import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { V2Broker } from '../src/v2-broker.mjs';

const COUNT = 125;
const orders = (page) => page.items.map((item) => item.order);
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

function assertPage(page) {
  assert.ok(page.items.length > 0 && page.items.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify({ items: page.items })) <= 256 * 1024);
  assert.deepEqual(orders(page), range(page.firstOrder, page.lastOrder));
  assert.equal(page.latestOrder, COUNT);
  assert.equal(Boolean(page.nextBeforeCursor), page.firstOrder > 1);
  assert.equal(Boolean(page.nextAfterCursor), page.lastOrder < COUNT);
}

test('byte-capped timeline pages retain their directional boundary and around target', async (t) => {
  await mkdir(join(process.cwd(), 'work'), { recursive: true });
  const runtimeDir = await mkdtemp(join(process.cwd(), 'work', 'v2-page-test-'));
  const broker = await V2Broker.open({ runtimeDir });
  t.after(() => broker.close());
  const room = await broker.createRoom({ operationId: 'page-room', name: 'Synthetic long history' });
  await broker.store.tx(async (sql) => {
    for (let order = 1; order <= COUNT; order++) {
      // Vary UTF-8 sizes so the byte cap, rather than row count, determines page edges.
      await sql.run(`INSERT INTO timeline(id,room_id,order_num,version,segment_id,at,kind,system_type,data_json,text)
        VALUES(?,?,?,1,?,'2026-09-28T00:00:00.000Z','system','seed','{}',?)`,
      [`page-item-${order}`, room.roomId, order, room.gate.segmentId, `History ${order}: ${'检'.repeat(2200 + order % 3 * 130)}`]);
    }
    await sql.run('UPDATE rooms SET latest_order=? WHERE id=?', [COUNT, room.roomId]);
  });
  const makeCursor = (direction, order) => Buffer.from(JSON.stringify({
    v: 1, workspaceId: broker.workspaceId, roomId: room.roomId, direction, order,
  })).toString('base64url');

  await t.test('latest and view include the actual latest entry', async () => {
    for (const page of [await broker.getTimeline(room.roomId), (await broker.getView(room.roomId)).page]) {
      assertPage(page);
      assert.ok(page.items.length < 100, 'fixture must exceed the page byte cap');
      assert.equal(page.lastOrder, COUNT);
      assert.equal(page.nextAfterCursor, null);
    }
  });

  await t.test('backward cursors visit every row exactly once without gaps', async () => {
    let before = makeCursor('before', COUNT + 1);
    let expectedLast = COUNT;
    const seen = [];
    for (let pageNumber = 0; before && pageNumber <= COUNT; pageNumber++) {
      const page = await broker.getTimeline(room.roomId, { before });
      assertPage(page);
      assert.equal(page.lastOrder, expectedLast);
      seen.unshift(...orders(page));
      expectedLast = page.firstOrder - 1;
      before = page.nextBeforeCursor;
    }
    assert.equal(before, null);
    assert.deepEqual(seen, range(1, COUNT));
  });

  await t.test('forward cursors visit every row exactly once without gaps', async () => {
    let after = makeCursor('after', 0);
    let expectedFirst = 1;
    const seen = [];
    for (let pageNumber = 0; after && pageNumber <= COUNT; pageNumber++) {
      const page = await broker.getTimeline(room.roomId, { after });
      assertPage(page);
      assert.equal(page.firstOrder, expectedFirst);
      seen.push(...orders(page));
      expectedFirst = page.lastOrder + 1;
      after = page.nextAfterCursor;
    }
    assert.equal(after, null);
    assert.deepEqual(seen, range(1, COUNT));
  });

  await t.test('around includes first, middle and last targets with both accepted address forms', async () => {
    for (const target of [1, 64, COUNT]) {
      for (const around of [`page-item-${target}`, makeCursor('around', target)]) {
        for (const limit of [1, 2, 17, 100]) {
          const page = await broker.getTimeline(room.roomId, { around, limit });
          assertPage(page);
          assert.ok(page.items.length <= limit);
          assert.equal(page.targetItemId, `page-item-${target}`);
          assert.ok(orders(page).includes(target), `missing target ${target}, limit ${limit}`);
          if (page.nextBeforeCursor) {
            const previous = await broker.getTimeline(room.roomId, { before: page.nextBeforeCursor });
            assert.equal(previous.lastOrder, page.firstOrder - 1);
          }
          if (page.nextAfterCursor) {
            const next = await broker.getTimeline(room.roomId, { after: page.nextAfterCursor });
            assert.equal(next.firstOrder, page.lastOrder + 1);
          }
        }
      }
    }
  });

  await t.test('an individually oversized boundary or target fails instead of silently skipping it', async () => {
    await broker.store.tx((sql) => sql.run('UPDATE timeline SET text=? WHERE id=?', ['检'.repeat(100000), 'page-item-64']));
    for (const options of [
      { before: makeCursor('before', 65) },
      { after: makeCursor('after', 63) },
      { around: 'page-item-64' },
    ]) {
      await assert.rejects(broker.getTimeline(room.roomId, options), (error) => error.code === 'PROJECTION_TOO_LARGE');
    }
  });
});
