import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateError, sha256, readReleaseZip, writePackage, parseManifest, regularFile, verifyInstalled } from './update-package.mjs';
import { installationKind, writeUpdateState, git, verifyGitTarget, updateOwnerAlive } from './update-install.mjs';

const SOURCE='https://github.com/ryan-eziar/ThreadCrew';
const API='https://api.github.com/repos/ryan-eziar/ThreadCrew/releases/latest';
const VERSION=/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const terminal=new Set(['completed','failed','rolled_back']);
export function newer(a,b){if(!VERSION.test(a)||!VERSION.test(b))throw updateError('UPDATE_CHECK_FAILED');const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;}
async function fetchBytes(url,max,fetcher,signal){
  let target=url;
  for(let hops=0;hops<5;hops++){
    const parsed=new URL(target);if(parsed.protocol!=='https:'||parsed.username||parsed.password||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname))throw updateError('UPDATE_CHECK_FAILED');
    const r=await fetcher(target,{redirect:'manual',headers:{Accept:'application/vnd.github+json','User-Agent':'ThreadCrew-update-check','X-GitHub-Api-Version':'2022-11-28'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    if([301,302,303,307,308].includes(r.status)){target=new URL(r.headers.get('location'),target).href;await r.body?.cancel();continue;}
    if(!r.ok)throw updateError('UPDATE_CHECK_FAILED');
    const chunks=[];let total=0;for await(const chunk of r.body){total+=chunk.length;if(total>max)throw updateError('UPDATE_PACKAGE_INVALID');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  throw updateError('UPDATE_CHECK_FAILED');
}
export class UpdateManager{
  constructor({projectDir,runtimeDir,features,prepareShutdown,fetcher=fetch,platform=process.platform,runGit=git,launchInstaller=null}){
    Object.assign(this,{projectDir:resolve(projectDir),runtimeDir:resolve(runtimeDir),features,prepareShutdown,fetcher,platform,runGit,launchInstaller});
    this.checking=null;this.installing=false;this.lastAttempt=0;this.support=null;this.closed=false;
    this.abort=new AbortController();
  }
  async initialize(){
    this.projectDir=await fs.realpath(this.projectDir);this.runtimeDir=await fs.realpath(this.runtimeDir);
    try{this.installedVersion=JSON.parse(await fs.readFile(join(this.projectDir,'package.json'),'utf8')).version;}catch{this.installedVersion='unknown';}
    // An interrupted installer must not leave a permanent write fence. A live
    // installer owns the fence through health verification and rollback.
    try{const saved=await this.saved();if(saved.install&&!terminal.has(saved.install.state)&&!updateOwnerAlive(saved.installOwner))
      await writeUpdateState(this.runtimeDir,{install:{...saved.install,state:'failed',errorCode:'UPDATE_INTERRUPTED',updatedAt:new Date().toISOString()},installOwner:null});}catch{}
    this.support=await installationKind(this.projectDir,{platform:this.platform,runGit:this.runGit});return this;
  }
  async saved(){try{return JSON.parse(await fs.readFile(join(this.runtimeDir,'update-state.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw updateError('UPDATE_STATE_UNREADABLE');}}
  async state(){
    let saved;try{saved=await this.saved();}catch{saved={checkState:'error',errorCode:'UPDATE_STATE_UNREADABLE'};}
    const settings=await this.features.settings(),available=saved.release&&VERSION.test(this.installedVersion)&&newer(saved.release.version,this.installedVersion);
    return {installedVersion:this.installedVersion,latestVersion:saved.release?.version??null,
      checkState:this.checking?'checking':saved.checkState==='error'?'error':saved.release?(available?'available':'current'):'idle',
      checkedAt:saved.checkedAt??null,autoCheckUpdates:settings.autoCheckUpdates,
      releaseUrl:saved.release?.url??null,releaseNotes:saved.release?.notes??'',...this.support,
      errorCode:saved.errorCode??null,install:saved.install??null};
  }
  async isApplying(){try{const s=await this.saved();return Boolean(s.install&&['stopping','installing','restarting'].includes(s.install.state)&&updateOwnerAlive(s.installOwner));}catch{return false;}}
  startAutomatic(){
    const check=async()=>{if(this.closed||this.installing)return;try{if(!await this.isApplying()&&(await this.features.settings()).autoCheckUpdates)await this.check();}catch{}};
    this.startTimer=setTimeout(check,2000);this.startTimer.unref();this.timer=setInterval(check,6*60*60*1000);this.timer.unref();
  }
  close(){this.closed=true;this.abort.abort();clearTimeout(this.startTimer);clearInterval(this.timer);}
  async check(){
    if(this.checking)return this.checking;
    if(this.installing||Date.now()-this.lastAttempt<60000)return this.state();
    this.lastAttempt=Date.now();
    this.checking=(async()=>{
      try{
        const r=JSON.parse((await fetchBytes(API,1024*1024,this.fetcher,this.abort.signal)).toString('utf8'));
        const version=typeof r.tag_name==='string'&&r.tag_name.startsWith('v')?r.tag_name.slice(1):'';
        if(r.draft||r.prerelease||!VERSION.test(version)||r.html_url!==`${SOURCE}/releases/tag/v${version}`||!Array.isArray(r.assets))throw updateError('UPDATE_CHECK_FAILED');
        const assetName=`ThreadCrew-${version}.zip`,asset=r.assets.find(a=>a.name===assetName),sums=r.assets.find(a=>a.name==='SHA256SUMS.txt');
        for(const a of [asset,sums])if(!a||a.browser_download_url!==`${SOURCE}/releases/download/v${version}/${a.name}`||!Number.isSafeInteger(a.size)||a.size<1)throw updateError('UPDATE_CHECK_FAILED');
        if(asset.size>50*1024*1024||sums.size>65536)throw updateError('UPDATE_PACKAGE_INVALID');
        const release={version,url:r.html_url,notes:typeof r.body==='string'?r.body.slice(0,12000):'',assetName,
          assetUrl:asset.browser_download_url,sumsUrl:sums.browser_download_url,size:asset.size,digest:asset.digest??null};
        await writeUpdateState(this.runtimeDir,{release,checkedAt:new Date().toISOString(),checkState:'ready',errorCode:null});
      }catch(e){if(!this.closed)await writeUpdateState(this.runtimeDir,{checkedAt:new Date().toISOString(),checkState:'error',errorCode:e.code?.startsWith('UPDATE_')?e.code:'UPDATE_CHECK_FAILED'});}
      finally{this.checking=null;}
      return this.state();
    })();return this.checking;
  }
  install(input){
    const prior=this.installRequests?.get(input.operationId);
    if(prior){if(prior.version!==input.expectedVersion)return Promise.reject(updateError('ID_CONFLICT'));return prior.promise;}
    this.installRequests??=new Map();
    const promise=this.installOnce(input).finally(()=>this.installRequests.delete(input.operationId));
    this.installRequests.set(input.operationId,{version:input.expectedVersion,promise});return promise;
  }
  async installOnce({operationId,expectedVersion}){
    if(typeof operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(operationId)||!VERSION.test(expectedVersion))throw updateError('INVALID_INPUT');
    const saved=await this.saved();
    if(saved.install?.operationId===operationId){if(saved.install.version!==expectedVersion)throw updateError('ID_CONFLICT');return this.state();}
    if(this.installing||(saved.install&&!terminal.has(saved.install.state)))throw updateError('UPDATE_IN_PROGRESS');
    if(!saved.release||saved.release.version!==expectedVersion||!VERSION.test(this.installedVersion)||!newer(expectedVersion,this.installedVersion))throw updateError('UPDATE_VERSION_CHANGED');
    this.support=await installationKind(this.projectDir,{platform:this.platform,runGit:this.runGit});
    if(!this.support.installSupported||!this.prepareShutdown)throw updateError('UPDATE_UNSUPPORTED');
    const preview=await this.features.updatePreview();if(Object.values(preview.counts).some(n=>n>0))throw updateError('UPDATE_BUSY',preview);
    // Acquire in-memory ownership before another asynchronous request can start.
    if(this.installing)throw updateError('UPDATE_IN_PROGRESS');this.installing=true;
    const job={operationId,version:expectedVersion,startedAt:new Date().toISOString(),previousVersion:this.installedVersion,
      projectDir:this.projectDir,runtimeDir:this.runtimeDir,nodePath:process.execPath,installKind:this.support.installKind,
      workspaceId:this.features.broker.workspaceId,ownerPid:process.pid};
    try{await writeUpdateState(this.runtimeDir,{install:{operationId,version:expectedVersion,state:'downloading',startedAt:job.startedAt,updatedAt:job.startedAt,errorCode:null},installOwner:{pid:process.pid,kind:'broker'}});}catch(e){this.installing=false;throw e;}
    this.task=this.prepare(job,saved.release).catch(async e=>{
      this.installing=false;await writeUpdateState(this.runtimeDir,{install:{operationId,version:expectedVersion,state:'failed',startedAt:job.startedAt,updatedAt:new Date().toISOString(),errorCode:e.code?.startsWith('UPDATE_')?e.code:'UPDATE_INSTALL_FAILED'}});
    });
    return this.state();
  }
  async prepare(job,release){
    const stageState=async state=>writeUpdateState(this.runtimeDir,{install:{operationId:job.operationId,version:job.version,state,startedAt:job.startedAt,updatedAt:new Date().toISOString(),errorCode:null}});
    const sums=(await fetchBytes(release.sumsUrl,65536,this.fetcher,this.abort.signal)).toString('utf8');
    const records=sums.trim().split(/\r?\n/).map(l=>l.match(/^([0-9a-fA-F]{64})\s+\*?([^\s]+)$/)).filter(Boolean).filter(m=>m[2]===release.assetName);
    if(records.length!==1)throw updateError('UPDATE_CHECKSUM_FAILED');
    const bytes=await fetchBytes(release.assetUrl,50*1024*1024,this.fetcher,this.abort.signal),digest=sha256(bytes);
    if(bytes.length!==release.size||digest!==records[0][1].toLowerCase()||(release.digest&&release.digest!==`sha256:${digest}`))throw updateError('UPDATE_CHECKSUM_FAILED');
    await stageState('verifying');const releasePackage=readReleaseZip(bytes,job.version);
    const oldManifest=parseManifest(await regularFile(this.projectDir,'PUBLIC_EXPORT_MANIFEST.json'));await verifyInstalled(this.projectDir,oldManifest);
    job.jobDir=join(this.runtimeDir,'updates',sha256(Buffer.from(job.operationId)));await fs.mkdir(job.jobDir,{recursive:true});
    job.stageDir=join(job.jobDir,'stage');await writePackage(job.stageDir,releasePackage);
    await promisify(execFile)(process.execPath,['--disable-warning=ExperimentalWarning',join(job.stageDir,'src','node-runtime.mjs')],{windowsHide:true,timeout:15000,maxBuffer:65536});
    if(job.installKind==='git'){
      job.previousCommit=String(await this.runGit(this.projectDir,['rev-parse','HEAD'])).trim();
      const ref=`refs/threadcrew/releases/v${job.version}`;
      await this.runGit(this.projectDir,['fetch','--no-tags',SOURCE+'.git','refs/heads/main:refs/remotes/origin/main',`refs/tags/v${job.version}:${ref}`]);
      job.targetCommit=String(await this.runGit(this.projectDir,['rev-parse',`${ref}^{commit}`])).trim();
      await this.runGit(this.projectDir,['merge-base','--is-ancestor',job.previousCommit,job.targetCommit]);
      await this.runGit(this.projectDir,['merge-base','--is-ancestor',job.targetCommit,'refs/remotes/origin/main']);
      await verifyGitTarget(this.projectDir,job.targetCommit,releasePackage.manifest,this.runGit);
      if(sha256(await this.runGit(this.projectDir,['show',`${job.targetCommit}:PUBLIC_EXPORT_MANIFEST.json`]))!==sha256(releasePackage.entries.get('PUBLIC_EXPORT_MANIFEST.json')))throw updateError('UPDATE_PACKAGE_INVALID');
    }
    for(const name of ['update-package.mjs','update-install.mjs'])await fs.copyFile(join(this.projectDir,'src',name),join(job.jobDir,name));
    const jobFile=join(job.jobDir,'job.json');await fs.writeFile(jobFile,JSON.stringify(job)+'\n',{flag:'wx',mode:0o600});
    // All reversible staging is finished. The server performs the final snapshot
    // and closes its mutation gate synchronously inside the serialized check.
    await this.prepareShutdown(job.operationId,async()=>{
      await stageState('stopping');
      if(this.launchInstaller)await this.launchInstaller(job);
      else{const child=spawn(process.execPath,[join(job.jobDir,'update-install.mjs'),'--job',jobFile],{detached:true,stdio:'ignore',windowsHide:true,cwd:job.jobDir});await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});child.unref();}
    });
  }
}
