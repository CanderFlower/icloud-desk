import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/js/cache.js', import.meta.url), 'utf8');
const { ResponseCache } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const KEY = '/api/calendar/events?start=2026-11-01';
const ready = { state: 'ready', apple_id: 'one@example.test', china_mainland: false, user: { full_name: 'One' } };
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
function setup(storage = new Map()) {
  let time = 100000;
  const events = [];
  const adapter = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const cache = new ResponseCache({ storage: adapter, now: () => time, notify: (event) => events.push(event) });
  cache.setSession(ready);
  return { cache, events, adapter, storage, advance: (ms) => { time += ms; }, now: () => time };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('warm reads are immediate and use isolated copies without another request', async () => {
  const { cache } = setup();
  let calls = 0;
  await cache.read(KEY, async () => { calls++; return [{ title: 'original' }]; });
  const rows = await cache.read(KEY, async () => { calls++; return []; });
  rows[0].title = 'edited';
  assert.equal(cache.peek(KEY)[0].title, 'original');
  assert.equal(calls, 1);
});

test('stale data renders before a slow request and updates after it completes', async () => {
  const { cache, advance } = setup();
  await cache.read(KEY, async () => ['old']);
  advance(61000);
  const remote = deferred();
  let update;
  const started = performance.now();
  assert.deepEqual(await cache.read(KEY, () => remote.promise, { onUpdate: (data) => { update = data; } }), ['old']);
  assert.ok(performance.now() - started < 100);
  assert.equal(update, undefined);
  remote.resolve(['new']);
  await flush();
  assert.deepEqual(update, ['new']);
  assert.deepEqual(cache.peek(KEY), ['new']);
});

test('concurrent readers share one cloud request', async () => {
  const { cache } = setup();
  const remote = deferred();
  let calls = 0;
  const fetcher = () => { calls++; return remote.promise; };
  const a = cache.read(KEY, fetcher);
  const b = cache.read(KEY, fetcher);
  remote.resolve([]);
  assert.deepEqual(await a, []);
  assert.deepEqual(await b, []);
  assert.equal(calls, 1);
});

test('manual refresh bypasses a fresh snapshot', async () => {
  const { cache } = setup();
  await cache.read(KEY, async () => ['old']);
  assert.deepEqual(await cache.read(KEY, async () => ['latest'], { force: true }), ['latest']);
});

test('offline revalidation keeps the snapshot and reports its failure', async () => {
  const { cache, events, advance } = setup();
  await cache.read(KEY, async () => ['saved']);
  advance(61000);
  assert.deepEqual(await cache.read(KEY, async () => { throw new Error('offline'); }), ['saved']);
  await flush();
  assert.equal(events.find((e) => e.background)?.error.message, 'offline');
  assert.deepEqual(cache.peek(KEY), ['saved']);
});

test('snapshots survive restart but not expiry, account switch or logout', async () => {
  const { cache, adapter, now } = setup();
  await cache.read(KEY, async () => ['saved']);
  const restarted = new ResponseCache({ storage: adapter, now });
  restarted.setSession({ ...ready, state: 'restoring' });
  assert.deepEqual(restarted.peek(KEY), ['saved']);
  assert.equal(restarted.profile.user.full_name, 'One');
  restarted.setSession({ ...ready, china_mainland: true });
  assert.equal(restarted.peek(KEY), undefined);
  await restarted.read(KEY, async () => ['China']);
  restarted.setSession({ ...ready, apple_id: 'two@example.test' });
  assert.equal(restarted.peek(KEY), undefined);
  await restarted.read(KEY, async () => ['Two']);
  restarted.setSession({ ...ready, state: 'logged_out' });
  assert.equal(restarted.peek(KEY), undefined);
  assert.equal(adapter.getItem('icd.responses.v1'), undefined);
  const expired = new ResponseCache({ storage: adapter, now: () => now() + 8 * 86400000 });
  assert.equal(expired.peek(KEY), undefined);
});

test('expired entries are not loaded from disk', async () => {
  const { cache, adapter, now } = setup();
  await cache.read(KEY, async () => ['saved']);
  const expired = new ResponseCache({ storage: adapter, now: () => now() + 8 * 86400000 });
  expired.setSession(ready);
  assert.equal(expired.peek(KEY), undefined);
});

test('writes invalidate only their module and cannot resurrect an older in-flight response', async () => {
  const { cache, advance } = setup();
  const notes = '/api/notes?limit=1000';
  await cache.read(KEY, async () => ['old']);
  await cache.read(notes, async () => ['note']);
  advance(61000);
  const remote = deferred();
  let updated = false;
  await cache.read(KEY, () => remote.promise, { onUpdate: () => { updated = true; } });
  cache.invalidate('/api/calendar');
  remote.resolve(['stale']);
  await flush();
  assert.equal(updated, false);
  assert.equal(cache.peek(KEY), undefined);
  assert.deepEqual(cache.peek(notes), ['note']);
});

test('logout suppresses in-flight updates and clears persisted content', async () => {
  const { cache, advance, adapter } = setup();
  await cache.read(KEY, async () => ['saved']);
  advance(61000);
  const remote = deferred();
  let updated = false;
  await cache.read(KEY, () => remote.promise, { onUpdate: () => { updated = true; } });
  cache.setSession({ ...ready, state: 'logged_out' });
  remote.resolve(['private']);
  await flush();
  assert.equal(updated, false);
  assert.equal(adapter.getItem('icd.responses.v1'), undefined);
});

test('background cloud access waits for restored session', async () => {
  const { cache } = setup();
  cache.setSession({ ...ready, state: 'restoring' });
  let fetched = false;
  const request = cache.read(KEY, async () => { await cache.waitForSession(); fetched = true; return ['ready']; });
  await flush();
  assert.equal(fetched, false);
  cache.setSession(ready);
  assert.deepEqual(await request, ['ready']);
});

test('storage failure is reported and memory cache still works', async () => {
  const events = [];
  const cache = new ResponseCache({
    storage: { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('quota'); } },
    notify: (event) => events.push(event),
  });
  cache.setSession(ready);
  await cache.read(KEY, async () => ['memory']);
  assert.deepEqual(cache.peek(KEY), ['memory']);
  assert.equal(events.find((e) => e.storage)?.error.message, 'quota');
});
