import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { V2Store } from '../src/v2-store.mjs';

async function runtime() {
  const parent=join(process.cwd(),'work'); await mkdir(parent,{recursive:true});
  return mkdtemp(join(parent,'v2-store-test-'));
}

test('v2 store owns one writer and commits or rolls back indexed records',async()=>{
  const runtimeDir=await runtime();
  const store=await V2Store.open({runtimeDir});
  await assert.rejects(V2Store.open({runtimeDir}),error=>error.code==='JOURNAL_LOCKED');
  await store.tx(sql=>sql.run('INSERT INTO metadata(key,value) VALUES(?,?)',['test-key','first']));
  await assert.rejects(store.tx(async sql=>{
    await sql.run('UPDATE metadata SET value=? WHERE key=?',['second','test-key']);
    throw new Error('abort');
  }),/abort/);
  assert.equal((await store.read(sql=>sql.get('SELECT value FROM metadata WHERE key=?',['test-key']))).value,'first');
  await store.close();
  const reopened=await V2Store.open({runtimeDir});
  assert.equal((await reopened.read(sql=>sql.get('SELECT value FROM metadata WHERE key=?',['test-key']))).value,'first');
  await reopened.close();
});

test('v2 schema has the keyset and ownership indexes',async()=>{
  const store=await V2Store.open({runtimeDir:await runtime()});
  const names=(await store.read(sql=>sql.all("SELECT name FROM sqlite_master WHERE type='index'"))).map(row=>row.name);
  for(const index of ['timeline_room_order','timeline_room_kind_order','rooms_lifecycle_order',
    'binding_one_room_per_session','deliveries_binding_queue','deliveries_room_state',
    'work_requests_binding_queue']) assert.ok(names.includes(index),index);
  await store.close();
});
