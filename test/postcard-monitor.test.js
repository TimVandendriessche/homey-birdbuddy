'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PostcardMonitor = require('../lib/postcard-monitor');

function card(id, minute = 0, extra = {}) {
  return { id, feederId: 'feeder', createdAt: new Date(Date.UTC(2026, 9, 19, 12, minute)).toISOString(),
    inferenceExecutionMode: 'MANUAL_NOT_STARTED', species: [], ...extra };
}

function setup(state) {
  const fixture = { cards: [], calls: [], notified: [], analyses: [], errors: [], clock: Date.UTC(2026, 9, 19, 13) };
  fixture.client = {
    getPostcards: async () => fixture.cards,
    getPostcard: async id => fixture.cards.find(item => item.id === id) || null,
    identifyPostcard: async id => {
      fixture.calls.push(id);
      return card(id, 1, { inferenceExecutionMode: 'MANUAL_COMPLETED', species: [{ id: 'robin', name: 'Robin' }] });
    },
  };
  fixture.monitor = new PostcardMonitor({ client: fixture.client, feederId: 'feeder', state,
    saveState: async value => { fixture.saved = structuredClone(value); },
    onCards: async () => {}, onAnalysis: async value => fixture.analyses.push(value),
    onIdentified: async value => fixture.notified.push(value.id),
    onError: error => fixture.errors.push(error), now: () => fixture.clock });
  return fixture;
}

test('startup identifies only the latest pending visitor and establishes a silent baseline', async () => {
  const f = setup();
  f.cards = [card('latest', 2), card('older', 1)];
  await f.monitor.poll(true);
  assert.deepEqual(f.calls, ['latest']);
  assert.deepEqual(f.notified, []);
  assert.equal(f.saved.jobs.length, 0);
});

test('all new postcards are queued, processed in bounded batches, and deduplicated after restart', async () => {
  const f = setup({ since: card('baseline').createdAt, seenIds: ['baseline'] });
  f.cards = Array.from({ length: 7 }, (_, i) => card(String(7 - i), 7 - i));
  await f.monitor.poll(true);
  assert.equal(f.calls.length, 5);
  assert.equal(f.saved.jobs.length, 2);
  const restarted = setup(f.saved);
  restarted.cards = f.cards;
  await restarted.monitor.poll(true);
  assert.deepEqual(restarted.calls, ['6', '7']);
  assert.equal(restarted.saved.jobs.length, 0);
  await restarted.monitor.poll(true);
  assert.equal(restarted.calls.length, 2);
});

test('a transient error survives restart and respects the retry delay', async () => {
  const f = setup({ since: card('baseline').createdAt, seenIds: ['baseline'] });
  f.cards = [card('new', 1)];
  f.client.identifyPostcard = async () => { throw new Error('Timeout'); };
  await f.monitor.poll(true);
  assert.equal(f.saved.jobs[0].attempts, 1);
  const restarted = setup(f.saved);
  restarted.cards = f.cards;
  await restarted.monitor.poll(true);
  assert.equal(restarted.calls.length, 0);
  restarted.clock += 60001;
  await restarted.monitor.poll(true);
  assert.deepEqual(restarted.calls, ['new']);
  assert.deepEqual(restarted.notified, ['new']);
});

test('pending inference is read again without resubmitting the manual request', async () => {
  const f = setup({ since: card('baseline').createdAt, seenIds: ['baseline'] });
  f.cards = [card('new', 1)];
  f.client.identifyPostcard = async id => { f.calls.push(id); return f.cards[0]; };
  await f.monitor.poll(true);
  assert.equal(f.saved.jobs[0].submitted, true);
  f.clock += 60001;
  f.cards = [card('new', 1, { inferenceExecutionMode: 'MANUAL_COMPLETED', species: [{ id: 'robin', name: 'Robin' }] })];
  await f.monitor.poll(true);
  assert.deepEqual(f.calls, ['new']);
  assert.deepEqual(f.notified, ['new']);
});

test('premium results trigger without inference; opting out and unknown results do not submit or invent species', async () => {
  const f = setup({ since: card('baseline').createdAt, seenIds: ['baseline'] });
  f.cards = [card('premium', 3, { inferenceExecutionMode: 'AUTOMATIC', species: [{ id: 'jay', name: 'Jay' }] }),
    card('manual', 2), card('unknown', 1, { inferenceExecutionMode: 'MANUAL_COMPLETED' })];
  await f.monitor.poll(false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.notified, ['premium']);
});

test('rate limiting pauses the queue and a server denial is not retried forever', async () => {
  const f = setup({ since: card('baseline').createdAt, seenIds: ['baseline'] });
  f.cards = [card('second', 2), card('first', 1)];
  f.client.identifyPostcard = async id => {
    f.calls.push(id);
    throw Object.assign(new Error('Slow down'), { status: 429, retryAfterMs: 600000 });
  };
  await f.monitor.poll(true);
  assert.deepEqual(f.calls, ['first']);
  f.clock += 600001;
  f.client.identifyPostcard = async id => {
    f.calls.push(id);
    throw Object.assign(new Error('Not available'), { code: 'FORBIDDEN', status: 403 });
  };
  await f.monitor.poll(true);
  assert.equal(f.saved.jobs.length, 0);
  const count = f.calls.length;
  await f.monitor.poll(true);
  assert.equal(f.calls.length, count);
});

test('photo download failure does not stop identification and another feeder is ignored', async () => {
  const f = setup({ since: card('baseline').createdAt, seenIds: ['baseline'] });
  f.cards = [card('other', 2, { feederId: 'other-feeder' }), card('mine', 1, { imageUrl: undefined })];
  f.monitor.onCards = async () => { throw new Error('Image download failed'); };
  await f.monitor.poll(true);
  assert.deepEqual(f.calls, ['mine']);
  assert.deepEqual(f.notified, ['mine']);
  assert.equal(f.errors.length, 1);
});

test('postcards sharing the cursor timestamp are not skipped', async () => {
  const f = setup({ since: card('seen', 1).createdAt, seenIds: ['seen'] });
  f.cards = [card('seen', 1), card('also-new', 1)];
  await f.monitor.poll(true);
  assert.deepEqual(f.calls, ['also-new']);
});
