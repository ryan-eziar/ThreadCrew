import fs from 'node:fs/promises';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { updateError, parseManifest, regularFile, verifyInstalled, inDirectory, sha256 } from './update-package.mjs';

const execute=promisify(execFile);
const exists=async p=>{try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
export function updateOwnerAlive(owner){
  if(!Number.isSafeInteger(owner?.pid)||owner.pid<1)return false;
  try{process.kill(owner.pid,0);return true;}catch(e){return e.code!=='ESRCH';}
}
const writes=new Map();
export function writeUpdateState(runtimeDir,change){
  const key=resolve(runtimeDir),previous=writes.get(key)??Promise.resolve();
  const task=previous.catch(()=>{}).then(()=>saveUpdateState(runtimeDir,change));writes.set(key,task);
  void task.finally(()=>{if(writes.get(key)===task)writes.delete(key);}).catch(()=>{});return task;
}
async function saveUpdateState(runtimeDir,change){
  const file=join(runtimeDir,'update-state.json');let previous={schema:1};
  try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const result={...previous,...change},tmp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
  try{await replaceFile(tmp,file);}catch(e){await fs.unlink(tmp).catch(()=>{});throw e;}return result;
}
async function replaceFile(from,to){
  for(let attempt=0;;attempt++)try{return await fs.rename(from,to);}catch(e){
    // Windows readers/scanners may briefly hold the destination during a status
    // poll. Retain atomic replacement and retry the same file for at most 600 ms.
    if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=12)throw e;
    await delay(50);
  }
}
export const git=async(root,args)=>{
  const {stdout}=await execute('git',args,{cwd:root,windowsHide:true,timeout:60000,maxBuffer:24*1024*1024,encoding:'buffer'});
  return stdout;
};
export async function installationKind(root,{platform=process.platform,runGit=git}={}){
  if(platform!=='win32')return {installSupported:false,installKind:null,installUnsupportedReason:'UNSUPPORTED_PLATFORM'};
  try{
    parseManifest(await regularFile(root,'PUBLIC_EXPORT_MANIFEST.json'));
    if(await exists(join(root,'.git'))){
      const clean=String(await runGit(root,['status','--porcelain'])).trim();
      const branch=String(await runGit(root,['branch','--show-current'])).trim();
      const remote=String(await runGit(root,['remote','get-url','origin'])).trim();
      if(clean||branch!=='main'||!['https://github.com/ryan-eziar/ThreadCrew.git','https://github.com/ryan-eziar/ThreadCrew','git@github.com:ryan-eziar/ThreadCrew.git'].includes(remote))throw updateError('GIT_WORKTREE_UNSAFE');
      await runGit(root,['merge-base','--is-ancestor','HEAD','refs/remotes/origin/main']);
      return {installSupported:true,installKind:'git',installUnsupportedReason:null};
    }
    return {installSupported:true,installKind:'zip',installUnsupportedReason:null};
  }catch(e){return {installSupported:false,installKind:await exists(join(root,'.git'))?'git':null,installUnsupportedReason:await exists(join(root,'.git'))?'GIT_WORKTREE_UNSAFE':'UNMANAGED_INSTALL'};}
}
export async function verifyGitTarget(root,commit,manifest,runGit=git){
  const names=String(await runGit(root,['ls-tree','-r','--name-only',commit])).trim().split('\n').filter(Boolean).sort();
  const expected=[...manifest.files.map(f=>f.path),'PUBLIC_EXPORT_MANIFEST.json'].sort();
  if(JSON.stringify(names)!==JSON.stringify(expected))throw updateError('UPDATE_PACKAGE_INVALID');
  for(const f of manifest.files){const bytes=await runGit(root,['show',`${commit}:${f.path}`]);if(bytes.length!==f.bytes||sha256(bytes)!==f.sha256)throw updateError('UPDATE_PACKAGE_INVALID');}
}
async function putFile(root,name,bytes){
  const file=inDirectory(root,name);let at=resolve(root);
  for(const part of name.split('/').slice(0,-1)){
    at=join(at,part);
    try{const st=await fs.lstat(at);if(!st.isDirectory()||st.isSymbolicLink())throw updateError('UPDATE_LOCAL_CHANGES');}
    catch(e){if(e.code==='ENOENT')await fs.mkdir(at);else throw e;}
  }
  await fs.mkdir(dirname(file),{recursive:true});
  const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,bytes,{flag:'wx'});await replaceFile(tmp,file);
}
async function backupControl(runtimeDir,destination){
  await fs.mkdir(destination,{recursive:true});
  for(const name of await fs.readdir(runtimeDir)){
    if(['updates','backups','recovery-evidence','attachments','replies'].includes(name)||name.endsWith('.log')||name==='broker-state.lock')continue;
    const source=join(runtimeDir,name),st=await fs.lstat(source);if(st.isSymbolicLink())throw updateError('UPDATE_INSTALL_FAILED');
    if(st.isFile())await fs.copyFile(source,join(destination,name));
    else if(st.isDirectory())await copyTree(source,join(destination,name));
  }
}
async function copyTree(from,to){
  await fs.mkdir(to,{recursive:true});
  for(const entry of await fs.readdir(from,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw updateError('UPDATE_INSTALL_FAILED');
    const source=join(from,entry.name),target=join(to,entry.name);
    if(entry.isDirectory())await copyTree(source,target);else if(entry.isFile())await fs.copyFile(source,target);
  }
}
async function restoreControl(runtime,backup,jobDir){
  // Preserve the failed startup's exact database family before restoring the
  // old snapshot. Never replay a new WAL onto an older database.
  const evidence=join(jobDir,'failed-startup-runtime');await fs.mkdir(evidence,{recursive:true});
  for(const name of ['v2-state.sqlite','v2-state.sqlite-wal','v2-state.sqlite-shm']){
    const file=join(runtime,name);if(await exists(file))await fs.rename(file,join(evidence,name));
  }
  await copyTree(backup,runtime);
}
async function lockGone(runtimeDir,timeout=30000){
  const end=Date.now()+timeout;while(await exists(join(runtimeDir,'broker-state.lock'))){if(Date.now()>end)throw updateError('UPDATE_INSTALL_FAILED');await delay(150);}
}
async function restart(job){
  // Wait for the launcher process, not inherited pipe handles retained by its
  // background broker. Read the verified runtime descriptor after it exits.
  await new Promise((yes,no)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(job.projectDir,'scripts','launch-agent-chat.ps1'),'-RuntimeDir',job.runtimeDir,'-NodePath',job.nodePath,'-NoOpen'],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();no(updateError('UPDATE_RESTART_FAILED'));},45000);
    child.once('error',()=>{clearTimeout(timer);no(updateError('UPDATE_RESTART_FAILED'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?yes():no(updateError('UPDATE_RESTART_FAILED'));});
  });
  const descriptor=JSON.parse(await fs.readFile(join(job.runtimeDir,'connection-codex.json'),'utf8'));
  const started={url:descriptor.baseUrl,instanceId:descriptor.instanceId};
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(started.url))throw updateError('UPDATE_RESTART_FAILED');
  const html=await(await fetch(started.url,{signal:AbortSignal.timeout(4000)})).text();
  const boot=JSON.parse(html.match(/window\.__AGENT_CHAT__=(\{.*?\});<\/script>/s)?.[1]??'null');
  if(boot?.workspaceId!==job.workspaceId||boot.instanceId!==started.instanceId)throw updateError('UPDATE_RESTART_FAILED');
  const result=await(await fetch(started.url+'/api/v2/diagnostics',{headers:{Authorization:'Bearer '+boot.humanToken},signal:AbortSignal.timeout(4000)})).json();
  if(!result.ok||result.result.version!==job.version)throw updateError('UPDATE_RESTART_FAILED');
  return started;
}
async function stopRestarted(job){
  if(!await exists(join(job.runtimeDir,'broker-state.lock')))return;
  const descriptor=JSON.parse(await fs.readFile(join(job.runtimeDir,'connection-codex.json'),'utf8'));
  if(descriptor.workspaceId!==job.workspaceId||!/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.baseUrl))throw updateError('UPDATE_RESTART_FAILED');
  const html=await(await fetch(descriptor.baseUrl,{signal:AbortSignal.timeout(4000)})).text();
  const boot=JSON.parse(html.match(/window\.__AGENT_CHAT__=(\{.*?\});<\/script>/s)?.[1]??'null');
  if(boot?.workspaceId!==job.workspaceId||boot.instanceId!==descriptor.instanceId)throw updateError('UPDATE_RESTART_FAILED');
  const response=await fetch(descriptor.baseUrl+'/api/v2/admin/shutdown',{method:'POST',headers:{Authorization:'Bearer '+boot.humanToken,Origin:descriptor.baseUrl,'Content-Type':'application/json'},body:JSON.stringify({expectedInstanceId:boot.instanceId,shutdownId:'update-rollback-'+job.operationId}),signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw updateError('UPDATE_RESTART_FAILED');await lockGone(job.runtimeDir);
}
export async function applyUpdate(job,{runGit=git,restartApp=restart,stopApp=stopRestarted,openApp=true}={}){
  const runtime=await fs.realpath(job.runtimeDir);
  const status=async(state,errorCode=null)=>writeUpdateState(runtime,{install:{operationId:job.operationId,version:job.version,state,startedAt:job.startedAt,updatedAt:new Date().toISOString(),errorCode},
    ...(['completed','failed','rolled_back'].includes(state)?{installOwner:null}:{installOwner:{pid:process.pid,kind:'installer',jobDir:job.jobDir}})});
  const open=async started=>{if(openApp&&started?.url)try{await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Start-Process '${started.url.replaceAll("'","''")}'`],{windowsHide:true,timeout:10000});}catch{}};
  let replaced=false,backedUp=false,stopped=false;
  let root,stage,jobDir,oldManifest,nextManifest,oldNames,nextNames;
  try{
    root=await fs.realpath(job.projectDir);jobDir=await fs.realpath(job.jobDir);
    const prefix=resolve(runtime,'updates')+sep;if(!jobDir.startsWith(prefix)||!resolve(job.stageDir).startsWith(jobDir+sep)||job.projectDir!==root||job.runtimeDir!==runtime)throw updateError('UPDATE_INSTALL_FAILED');
    await status('stopping');await lockGone(runtime);stopped=true;
    stage=await fs.realpath(job.stageDir);if(!stage.startsWith(jobDir+sep))throw updateError('UPDATE_INSTALL_FAILED');
    oldManifest=parseManifest(await regularFile(root,'PUBLIC_EXPORT_MANIFEST.json'));
    nextManifest=parseManifest(await regularFile(stage,'PUBLIC_EXPORT_MANIFEST.json'));
    oldNames=[...oldManifest.files.map(f=>f.path),'PUBLIC_EXPORT_MANIFEST.json'];
    nextNames=[...nextManifest.files.map(f=>f.path),'PUBLIC_EXPORT_MANIFEST.json'];
    await verifyInstalled(root,oldManifest);await verifyInstalled(stage,nextManifest);
    for(const name of nextNames)if(!oldNames.includes(name)&&await exists(inDirectory(root,name)))throw updateError('UPDATE_LOCAL_CHANGES');
    await fs.mkdir(join(jobDir,'backup-app'),{recursive:true});
    for(const name of oldNames)await putFile(join(jobDir,'backup-app'),name,await regularFile(root,name));
    await backupControl(runtime,join(jobDir,'backup-runtime'));backedUp=true;
    await status('installing');
    if(job.installKind==='git'){
      if(String(await runGit(root,['status','--porcelain'])).trim()||String(await runGit(root,['rev-parse','HEAD'])).trim()!==job.previousCommit)throw updateError('UPDATE_LOCAL_CHANGES');
      await verifyGitTarget(root,job.targetCommit,nextManifest,runGit);
      await runGit(root,['merge','--ff-only',job.targetCommit]);replaced=true;
    }else{
      replaced=true;
      for(const name of nextNames)await putFile(root,name,await regularFile(stage,name));
      for(const name of oldNames)if(!nextNames.includes(name))await fs.unlink(inDirectory(root,name));
    }
    await status('restarting');const started=await restartApp(job);
    await status('completed');
    await open(started);
    return {state:'completed',version:job.version};
  }catch(error){
    const code=error.code?.startsWith('UPDATE_')?error.code:'UPDATE_INSTALL_FAILED';
    if(replaced&&backedUp){
      try{
        await stopApp(job);await lockGone(runtime);
        if(job.installKind==='git')await runGit(root,['reset','--keep',job.previousCommit]);
        else{
          // Reject edits made after replacement instead of erasing them during rollback.
          for(const name of nextNames)if(await exists(inDirectory(root,name))){
            const current=sha256(await regularFile(root,name)),next=sha256(await regularFile(stage,name));
            const old=oldNames.includes(name)?sha256(await regularFile(join(jobDir,'backup-app'),name)):null;
            if(current!==next&&current!==old)throw updateError('UPDATE_LOCAL_CHANGES');
          }
          for(const name of oldNames)await putFile(root,name,await regularFile(join(jobDir,'backup-app'),name));
          for(const name of nextNames)if(!oldNames.includes(name)&&await exists(inDirectory(root,name))){const expected=nextManifest.files.find(f=>f.path===name);if(!expected||sha256(await regularFile(root,name))!==expected.sha256)throw updateError('UPDATE_LOCAL_CHANGES');await fs.unlink(inDirectory(root,name));}
        }
        await restoreControl(runtime,join(jobDir,'backup-runtime'),jobDir);
        await status('restarting');
        const started=await restartApp({...job,version:job.previousVersion});
        await status('rolled_back',code);await open(started);return {state:'rolled_back',errorCode:code};
      }catch{await status('failed','UPDATE_ROLLBACK_FAILED');return {state:'failed',errorCode:'UPDATE_ROLLBACK_FAILED'};}
    }
    if(stopped)try{await open(await restartApp({...job,version:job.previousVersion}));}catch{await status('failed','UPDATE_RESTART_FAILED');return {state:'failed',errorCode:'UPDATE_RESTART_FAILED'};}
    await status('failed',code);return {state:'failed',errorCode:code};
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.argv.length!==4||process.argv[2]!=='--job')throw Error('Expected job');const job=JSON.parse(await fs.readFile(process.argv[3],'utf8'));const result=await applyUpdate(job);process.exitCode=result.state==='completed'?0:1;}
  catch{process.exitCode=1;}
}
