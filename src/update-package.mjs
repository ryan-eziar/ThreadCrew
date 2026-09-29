import fs from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const updateError=(code,publicDetails={})=>Object.assign(new Error(code),{code,status:409,outcome:'rejected',publicDetails});
const invalid=()=>{throw updateError('UPDATE_PACKAGE_INVALID');};
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function managedPath(name){
  if(typeof name!=='string'||name.length>240||!/^\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(name))invalid();
  const parts=name.split('/');
  if(parts.some(p=>p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))invalid();
  if(['runtime','work','node_modules','.git','.codex','.env'].some(p=>parts[0].toLowerCase()===p))invalid();
  return name;
}
export function inDirectory(root,name){
  const target=resolve(root,...managedPath(name).split('/')),rel=relative(resolve(root),target);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))invalid();
  return target;
}
export async function regularFile(root,name){
  const file=inDirectory(root,name);
  let at=resolve(root);
  for(const part of name.split('/')){at=join(at,part);const st=await fs.lstat(at);if(st.isSymbolicLink())invalid();}
  if(!(await fs.lstat(file)).isFile())invalid();
  return fs.readFile(file);
}
export function parseManifest(bytes){
  let m;try{m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
  if(m.product!=='ThreadCrew'||!Array.isArray(m.files)||!m.files.length||m.files.length>3000)invalid();
  const seen=new Set();let total=0;
  for(const f of m.files){managedPath(f.path);const k=f.path.toLowerCase();if(seen.has(k)||k==='public_export_manifest.json')invalid();seen.add(k);
    if(!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>20*1024*1024||!/^\w{64}$/.test(f.sha256)||!/^[0-9a-f]{64}$/.test(f.sha256))invalid();total+=f.bytes;}
  if(total>128*1024*1024||!seen.has('package.json')||!seen.has('chat.mjs')||!seen.has('scripts/launch-agent-chat.ps1'))invalid();
  return m;
}
// Release ZIPs are small, ordinary store/deflate archives. Reject Zip64,
// encryption, symlinks, duplicate/case-colliding paths and unmanifested files.
export function readReleaseZip(bytes,expectedVersion){
  if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>50*1024*1024)invalid();
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))invalid();
  const count=bytes.readUInt16LE(end+10),centralBytes=bytes.readUInt32LE(end+12),centralOffset=bytes.readUInt32LE(end+16);
  if(count!==bytes.readUInt16LE(end+8)||!count||count>4000||centralOffset+centralBytes!==end)invalid();
  const entries=new Map(),seen=new Set();let position=centralOffset,total=0;
  for(let n=0;n<count;n++){
    if(position+46>end||bytes.readUInt32LE(position)!==0x02014b50)invalid();
    const flags=bytes.readUInt16LE(position+8),method=bytes.readUInt16LE(position+10),compressed=bytes.readUInt32LE(position+20),size=bytes.readUInt32LE(position+24);
    const nameLength=bytes.readUInt16LE(position+28),extra=bytes.readUInt16LE(position+30),comment=bytes.readUInt16LE(position+32),offset=bytes.readUInt32LE(position+42),attrs=bytes.readUInt32LE(position+38);
    if(position+46+nameLength+extra+comment>end||flags&1||!([0,8].includes(method))||size>20*1024*1024||((attrs>>>16)&0xf000)===0xa000)invalid();
    const rawName=bytes.subarray(position+46,position+46+nameLength);if([...rawName].some(x=>x<32||x>126))invalid();
    const name=rawName.toString('ascii'),directory=name.endsWith('/'),canonical=directory?name.slice(0,-1):name;
    managedPath(canonical);const key=canonical.toLowerCase();if(seen.has(key))invalid();seen.add(key);
    if(offset+30>centralOffset||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+8)!==method||bytes.readUInt16LE(offset+6)!==flags)invalid();
    const localNameLength=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),start=offset+30+localNameLength+localExtra;
    if(!bytes.subarray(offset+30,offset+30+localNameLength).equals(rawName)||start+compressed>centralOffset)invalid();
    let content;try{content=method===0?Buffer.from(bytes.subarray(start,start+compressed)):inflateRawSync(bytes.subarray(start,start+compressed),{maxOutputLength:Math.max(1,size)});}catch{invalid();}
    if(content.length!==size||(directory&&size))invalid();total+=size;if(total>128*1024*1024)invalid();
    if(!directory)entries.set(name,content);
    position+=46+nameLength+extra+comment;
  }
  if(position!==end||!entries.has('PUBLIC_EXPORT_MANIFEST.json'))invalid();
  const manifest=parseManifest(entries.get('PUBLIC_EXPORT_MANIFEST.json'));
  if(entries.size!==manifest.files.length+1)invalid();
  for(const f of manifest.files){const b=entries.get(f.path);if(!b||b.length!==f.bytes||sha256(b)!==f.sha256)invalid();}
  let pkg;try{pkg=JSON.parse(entries.get('package.json'));}catch{invalid();}
  if(pkg.name!=='threadcrew'||pkg.version!==expectedVersion)invalid();
  return {manifest,entries};
}
export async function writePackage(root,release){
  await fs.mkdir(root,{recursive:false});
  for(const [name,bytes] of release.entries){const target=inDirectory(root,name);await fs.mkdir(dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
}
export async function verifyInstalled(root,manifest){
  for(const f of manifest.files){let bytes;try{bytes=await regularFile(root,f.path);}catch{throw updateError('UPDATE_LOCAL_CHANGES');}
    if(bytes.length!==f.bytes||sha256(bytes)!==f.sha256)throw updateError('UPDATE_LOCAL_CHANGES');}
}
