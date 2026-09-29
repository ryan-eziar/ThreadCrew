import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPublicText } from '../scripts/export-public.mjs';

test('publication scan reports locations without returning matched secrets',()=>{
  const sample=['sk-'+'a'.repeat(30),'C:'+'\\Users\\someone\\private.txt','contact@'+'private.invalid'].join('\n');
  const findings=scanPublicText('sample.txt',sample);
  assert.deepEqual(findings.map(f=>f.rule),['provider-key','personal-home-path','email']);
  assert.deepEqual(findings.map(f=>f.line),[1,2,3]);
  assert.ok(findings.every(f=>Object.keys(f).join(',')==='path,line,rule'));
  assert.equal(scanPublicText('public.md','Ryan Zhang\nhttps://github.com/ryan-eziar/ThreadCrew\n123+sample@users.noreply.github.com').length,0);
});
