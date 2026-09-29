// Explicit opt-in only. This prepares a hook definition; Codex still owns trust.
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export function recoveryHandler({projectDir,runtimeDir,nodePath=process.execPath}){
  const quote=value=>`'${String(value).replaceAll("'","''")}'`;
  const ps=`& ${quote(nodePath)} ${quote(join(resolve(projectDir),'scripts','codex-recovery-hook.mjs'))} --runtime-dir ${quote(resolve(runtimeDir))}`;
  return {type:'command',command:`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps,'utf16le').toString('base64')}`,
    timeout:6,additionalContextLimit:5000,statusMessage:'ThreadCrew: recover this session'};
}
export async function configureRecovery({configPath,projectDir,runtimeDir,nodePath,remove=false}){
  const path=resolve(configPath),handler=recoveryHandler({projectDir,runtimeDir,nodePath});
  let original=null,config={};
  try{original=await fs.readFile(path,'utf8');config=JSON.parse(original);}catch(e){if(e.code!=='ENOENT')throw Error('Existing hooks config is invalid; it was not changed.');}
  if(!config||typeof config!=='object'||Array.isArray(config)||config.hooks!==undefined&&(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw Error('Invalid hooks config');
  const groups=config.hooks?.SessionStart??[];
  if(!Array.isArray(groups))throw Error('Invalid SessionStart config');
  let found=false;
  const next=groups.map(group=>{
    if(!Array.isArray(group.hooks))throw Error('Invalid hook group');
    return {...group,hooks:group.hooks.filter(h=>{if(h.command===handler.command){found=true;return !remove;}return true;})};
  }).filter(group=>group.hooks.length);
  if(!remove&&!found)next.push({matcher:'^(compact|resume)$',hooks:[handler]});
  if(remove&&!found||!remove&&found)return {changed:false,configured:!remove,trust:'Review in Codex /hooks; configuration alone is not proof of activation.'};
  config.hooks={...config.hooks,SessionStart:next};
  await fs.mkdir(dirname(path),{recursive:true});
  const backup=original===null?null:path+'.backup-'+randomUUID();
  if(backup)await fs.writeFile(backup,original,{flag:'wx'});
  const tmp=path+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(config,null,2)+'\n',{flag:'wx'});await fs.rename(tmp,path);
  return {changed:true,configured:!remove,configPath:path,backup,trust:remove?'Removed; refresh Codex hooks.':'Review and trust the exact definition in Codex /hooks. Untrusted hooks are skipped.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),remove=args.shift()==='remove';
    if(!['install','remove'].includes(process.argv[2])||args.length!==4||args[0]!=='--config'||args[2]!=='--runtime-dir')throw Error('Use install|remove --config EXACT_HOOKS_JSON --runtime-dir EXACT_RUNTIME');
    console.log(JSON.stringify(await configureRecovery({configPath:args[1],projectDir:resolve(import.meta.dirname,'..'),runtimeDir:args[3],remove}),null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
