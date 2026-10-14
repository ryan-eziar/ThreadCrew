import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';

const project=resolve(import.meta.dirname,'..'),work=join(project,'work');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
async function run(args){return new Promise((yes,no)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',no);child.once('close',code=>yes({code,out,err}));});}
async function fixture(t,{pending=false}={}){
  await fs.mkdir(work,{recursive:true});const root=await fs.mkdtemp(join(work,'opener-test-')),runtime=join(root,'runtime');await fs.mkdir(runtime);
  let source=await fs.readFile(process.env.THREADCREW_OPENER_TEST_SOURCE??join(project,'scripts/open-agent-chat.ps1'),'utf8');
  // Scale the old 90-second cutoff to 100ms and the new bounded budget to
  // six seconds. Real PowerShell startup/recovery completion remains async.
  source=source.replace('WaitForExit(90000)','WaitForExit(100)')
    .replace('[TimeSpan]::FromMinutes(20)',pending?'[TimeSpan]::FromMilliseconds(50)':'[TimeSpan]::FromSeconds(6)')
    .replaceAll('[System.IO.Path]::GetTempFileName()','(New-TestOutputFile)');
  await fs.writeFile(join(root,'open-agent-chat.ps1'),source);
  await fs.writeFile(join(root,'launch-agent-chat.ps1'),`param([string]$RuntimeDir,[switch]$NoOpen)
Start-Sleep -Milliseconds 500
[pscustomobject]@{status='started';url='http://127.0.0.1:41117'} | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $RuntimeDir 'child-finished') -Value 'done'
`);
  const opened=join(root,'opened.txt');
  const runner=`function New-TestOutputFile { $p=Join-Path ${quote(runtime)} ([guid]::NewGuid().ToString('N')+'.log'); [IO.File]::WriteAllText($p,''); return $p }
function Start-Process { param([string]$FilePath) [IO.File]::AppendAllText(${quote(opened)},$FilePath+[Environment]::NewLine) }
& ${quote(join(root,'open-agent-chat.ps1'))} -RuntimeDir ${quote(runtime)} -NoUi
exit $LASTEXITCODE
`;
  t.after(async()=>{
    for(let n=0;n<80;n++){try{await fs.access(join(runtime,'child-finished'));break;}catch{}await new Promise(r=>setTimeout(r,100));}
    const target=resolve(root);assert.ok(target.startsWith(work+sep)&&target.slice(work.length+1).startsWith('opener-test-'));
    await fs.rm(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  });
  return {runtime,opened,execute:()=>run(['-EncodedCommand',Buffer.from(runner,'utf16le').toString('base64')])};
}

test('desktop opener waits for slow safe startup and opens the returned URL once',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const f=await fixture(t),result=await f.execute();
  assert.equal(result.code,0,result.out+result.err);
  assert.match(result.out,/OK started http:\/\/127\.0\.0\.1:41117/);
  assert.equal((await fs.readFile(f.opened,'utf8')).trim(),'http://127.0.0.1:41117');
  assert.deepEqual((await fs.readdir(f.runtime)).filter(n=>n.endsWith('.log')),[]);
});

test('a bounded opener timeout is pending and retains a running launcher output',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const f=await fixture(t,{pending:true}),result=await f.execute();
  assert.equal(result.code,2,result.out+result.err);assert.match(result.out,/IN_PROGRESS/);
  assert.equal((await fs.readdir(f.runtime)).filter(n=>n.endsWith('.log')).length,2);
  await assert.rejects(fs.access(f.opened),e=>e.code==='ENOENT','no browser opens before verified completion');
});
