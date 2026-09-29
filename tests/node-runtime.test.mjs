import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkNodeRuntime, isSupportedNode, SUPPORTED_NODE_RANGE } from '../src/node-runtime.mjs';

test('supports the chosen LTS branches and rejects missing backup support, other majors and prereleases', () => {
  for (const v of ['22.16.0','22.23.3','v22.16.1','24.0.0','24.14.1','24.21.0']) assert.equal(isSupportedNode(v),true,v);
  for (const v of ['20.20.0','22.5.0','22.13.0','22.15.9','23.11.0','25.0.0','26.0.0','24.0.0-rc.1','24','24.01.0',null]) assert.equal(isSupportedNode(v),false,String(v));
});

test('unsupported versions are rejected before loading SQLite', async () => {
  let loaded=false;
  const result=await checkNodeRuntime({version:'22.15.0',loadSqlite:async()=>{loaded=true;throw Error('should not load');}});
  assert.equal(result.code,'NODE_VERSION_UNSUPPORTED');
  assert.equal(loaded,false);
});

test('supported version still needs working SQLite and the backup API', async () => {
  for (const loadSqlite of [async()=>{throw Error('disabled');},async()=>({DatabaseSync:class {}})]) {
    const result=await checkNodeRuntime({version:'24.0.0',loadSqlite});
    assert.equal(result.ok,false); assert.equal(result.code,'NODE_SQLITE_UNAVAILABLE');
  }
  let closed=false;
  const result=await checkNodeRuntime({version:'22.16.0',loadSqlite:async()=>({backup(){},DatabaseSync:class {
    prepare(){throw Error('broken query');} close(){closed=true;}
  }})});
  assert.equal(result.code,'NODE_SQLITE_UNAVAILABLE'); assert.equal(closed,true);
});

test('the actual runtime passes preflight and package policy agrees', async () => {
  const result=await checkNodeRuntime();
  assert.equal(result.ok,true,JSON.stringify(result));
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.engines.node,SUPPORTED_NODE_RANGE);
});
