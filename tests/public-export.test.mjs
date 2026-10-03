import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { scanPublicText, exportPublic } from '../scripts/export-public.mjs';

test('publication scan reports locations without returning matched secrets',()=>{
  const sample=['sk-'+'a'.repeat(30),'C:'+'\\Users\\someone\\private.txt','contact@'+'private.invalid'].join('\n');
  const findings=scanPublicText('sample.txt',sample);
  assert.deepEqual(findings.map(f=>f.rule),['provider-key','personal-home-path','email']);
  assert.deepEqual(findings.map(f=>f.line),[1,2,3]);
  assert.ok(findings.every(f=>Object.keys(f).join(',')==='path,line,rule'));
  assert.equal(scanPublicText('public.md','Ryan Zhang\nhttps://github.com/ryan-eziar/ThreadCrew\n123+sample@users.noreply.github.com').length,0);
});

test('public exports preserve README screenshots, exclude unlisted media and reject invalid PNG assets before writing', async t=>{
  const source=resolve(import.meta.dirname,'..'), work=join(source,'work');
  await fs.mkdir(work,{recursive:true});
  const temp=await fs.mkdtemp(join(work,'public-export-test-'));
  t.after(async()=>{
    const part=relative(work,resolve(temp));
    assert.ok(part.startsWith('public-export-test-')&&!isAbsolute(part)&&!part.includes(sep));
    await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const clean=join(temp,'clean');
  await exportPublic({source,destination:clean});
  const manifest=JSON.parse(await fs.readFile(join(clean,'PUBLIC_EXPORT_MANIFEST.json'),'utf8'));
  const bootstrap='scripts/start-independent-broker.ps1';
  assert.ok(manifest.files.some(file=>file.path===bootstrap));
  assert.deepEqual(await fs.readFile(join(clean,bootstrap)),await fs.readFile(join(source,bootstrap)));
  const screenshots=['room','discuss','work','reconnect'].map(name=>`docs/media/screenshot-${name}.png`);
  for(const path of screenshots) {
    const original=await fs.readFile(join(source,path)), exported=await fs.readFile(join(clean,path));
    assert.deepEqual(exported,original);
    const entry=manifest.files.find(file=>file.path===path);
    assert.equal(entry.bytes,original.length);
    assert.equal(entry.sha256,createHash('sha256').update(original).digest('hex'));
  }
  for(const name of ['README.md','README.zh-CN.md']) {
    const readme=await fs.readFile(join(clean,name),'utf8');
    for(const path of screenshots) assert.ok(readme.includes(`](${path})`),`${name} must retain ${path}`);
    for(const [,path] of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      if(!/^https?:/.test(path)) await fs.access(join(clean,path));
    }
  }
  const screenshot=await fs.readFile(join(clean,screenshots[0]));
  await fs.writeFile(join(clean,'docs/media/unlisted.png'),screenshot);
  const repeated=join(temp,'repeated');
  await exportPublic({source:clean,destination:repeated});
  await assert.rejects(fs.access(join(repeated,'docs/media/unlisted.png')),e=>e.code==='ENOENT');
  for(const [name,bytes] of [
    ['bad-signature',Buffer.from('not a PNG')],
    ['oversized',Buffer.concat([screenshot.subarray(0,8),Buffer.alloc(2*1024*1024)])],
  ]) {
    await fs.writeFile(join(clean,screenshots[0]),bytes);
    const destination=join(temp,name);
    await assert.rejects(exportPublic({source:clean,destination}),/reviewed PNG/);
    await assert.rejects(fs.access(destination),e=>e.code==='ENOENT');
  }
});
