import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioReadSessions } from '../src/audio-assets/read-sessions.js';
import { scanAudioRows } from '../src/audio-assets/scan.js';

const context = n => ({ userRoot: `fixture-${n}`, contextId: `context-${n}` });
const options = () => ({ key: 'assets', capture: () => ({ revision: 1 }), build: async () => ({ rows: Array.from({ length: 100 }, (_, id) => ({ id })) }),
  checkPage: async () => true, view: (entry, offset, nextCursor) => ({ rows: entry.rows.slice(offset, offset + 50), nextCursor }) });

test('global snapshot and active read limits bound multiple users; outputs cannot mutate retained pages', async t => {
  const reads = new AudioReadSessions(); t.after(() => reads.close());
  const first = await reads.read(context(0), options());
  for (let n = 1; n <= 8; n++) await reads.read(context(n), options());
  assert.equal(reads.sessions.size, 8);
  await assert.rejects(reads.read(context(0), { ...options(), cursor: first.nextCursor }), { code: 'AUDIO_BROWSE_EXPIRED' });
  const page = await reads.read(context(9), options()); page.rows[0].id = -1;
  assert.equal([...reads.sessions.values()].at(-1).rows[0].id, 0);
  let release; const hold = new Promise(resolve => { release = resolve; });
  const pending = [10, 11, 12, 13].map(n => reads.read(context(n), { ...options(), build: async () => { await hold; return { rows: [] }; } }));
  await assert.rejects(reads.read(context(14), options()), { code: 'RESOURCE_BUSY' });
  release(); await Promise.all(pending);
  assert.equal(reads.active.size, 0);
});

test('shutdown aborts and drains all scan workers before closing the owner', async () => {
  const reads = new AudioReadSessions(); let release, started, completed = false, checks = 0;
  const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const pending = reads.read(context(1), { ...options(), build: async (_data, signal) => ({ rows: await scanAudioRows(Array(20).fill(0), async row => {
    if (++checks === 4) started(); await hold; return row;
  }, signal) }) });
  const rejection = assert.rejects(pending, { code: 'CLIENT_ABORTED' }); await entered;
  const closing = reads.close().then(() => { completed = true; }); await Promise.resolve(); assert.equal(completed, false);
  release(); await closing; await rejection;
  assert.equal(checks, 4); assert.equal(reads.active.size, 0); assert.equal(reads.sessions.size, 0);
  await assert.rejects(reads.read(context(2), options()), { code: 'AUDIO_ASSET_UNAVAILABLE' });
});
