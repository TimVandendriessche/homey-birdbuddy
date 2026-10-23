'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let server;
class MockDevice {
  constructor({ store = {}, settings = {} } = {}) {
    this.store = structuredClone(store);
    this.settings = settings;
    this.capabilities = new Map([['measure_battery', null]]);
    this.events = [];
    this.statEvents = [];
    this.errors = [];
    this.homey = {
      __: key => key,
      i18n: { getLanguage: () => 'en' },
      clock: { getTimezone: () => 'Europe/Brussels' },
      clearInterval: () => {}, setInterval: () => 1,
      setTimeout: fn => globalThis.setTimeout(fn, 0),
      flow: { getDeviceTriggerCard: name => ({ trigger: async (_, tokens, state) => (
        ['species_visited', 'species_milestone', 'new_species'].includes(name) ? this.statEvents : this.events
      ).push({ name, tokens, state }) }) },
      images: { createImage: async () => ({ setStream() {}, async update() {} }) },
      videos: { createVideoOther: async () => ({ registerVideoUrlListener() {} }) },
    };
  }
  getStore() { return this.store; }
  getStoreValue(key) { return this.store[key]; }
  async setStoreValue(key, value) { this.store[key] = structuredClone(value); }
  getData() { return { id: 'feeder' }; }
  getSetting(key) { return this.settings[key]; }
  hasCapability(key) { return this.capabilities.has(key); }
  async addCapability(key) { this.capabilities.set(key, null); }
  async setCapabilityValue(key, value) { this.capabilities.set(key, value); }
  async setCameraImage() {}
  async setCameraVideo() {}
  async setAvailable() {}
  async setUnavailable() {}
  log() {}
  error(message) { this.errors.push(message); }
}

class MockClient {
  async getFeeders() { return [{ id: 'feeder', battery: { percentage: 75 } }]; }
  async getPostcards({ since } = {}) {
    return server.cards.filter(card => !since || Date.parse(card.createdAt) >= Date.parse(since));
  }
  async getLatestPostcard() { return server.cards.find(card => card.imageUrl) || null; }
  async getPostcard(id) { return server.cards.find(card => card.id === id) || null; }
  async identifyPostcard(id) {
    server.identified.push(id);
    const card = { ...await this.getPostcard(id), inferenceExecutionMode: 'MANUAL_COMPLETED',
      species: [{ id: 'robin', name: 'European Robin' }] };
    server.cards = server.cards.map(item => item.id === id ? card : item);
    return card;
  }
  async getUserId() {
    if (!server.report) throw new Error('visit report not available');
    return 'user-1';
  }
  async getVisitReport(window) {
    server.reportCalls.push(window);
    return server.report(window);
  }
  async getLatestVideo(feederId) { server.videoFeederIds.push(feederId); return null; }
  async download() {
    if (server.failDownload) throw new Error('Expired photo');
    return Buffer.from('photo');
  }
}

const originalLoad = Module._load;
let FeederDevice;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') return { Device: MockDevice };
    if (request === '../../lib/birdbuddy') return MockClient;
    return originalLoad.call(this, request, parent, isMain);
  };
  FeederDevice = require('../drivers/feeder/device');
} finally {
  Module._load = originalLoad;
}

function card(id, minute) {
  return { id, createdAt: new Date(Date.UTC(2026, 9, 19, 12, minute)).toISOString(), feederId: 'feeder',
    imageUrl: 'https://example.invalid/photo.jpg', species: [], inferenceExecutionMode: 'MANUAL_NOT_STARTED' };
}

for (const autoIdentify of [undefined, null, false]) {
  test(`automatic identification requires opt-in when the setting is ${autoIdentify}`, async () => {
    server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
    const device = new FeederDevice({ settings: autoIdentify === undefined ? {} : { auto_identify: autoIdentify } });
    await device.onInit();
    server.cards.unshift(card('before-opt-in', 1));
    await device.refresh();
    assert.deepEqual(server.identified, []);
    assert.equal(device.capabilities.get('measure_battery'), 75);
    assert.equal(device.store.lastPostcardId, 'before-opt-in');
    assert.deepEqual(device.events.map(event => event.name), ['visitor_arrived']);

    device.settings.auto_identify = true;
    server.cards.unshift(card('after-opt-in', 2));
    await device.refresh();
    assert.deepEqual(server.identified, ['after-opt-in']);
    assert.equal(device.events.at(-1).name, 'bird_identified');
  });
}

test('already recognized visitors still trigger identification Flows without opting in', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice();
  await device.onInit();
  server.cards.unshift({ ...card('premium', 1), inferenceExecutionMode: 'AUTOMATIC',
    species: [{ id: 'jay', name: 'Jay' }] });
  await device.refresh();
  assert.deepEqual(server.identified, []);
  assert.equal(device.capabilities.get('last_species'), 'Jay');
  assert.deepEqual(device.events.at(-1).tokens, { species: 'Jay', time: card('premium', 1).createdAt });
});

test('an existing pending job stays paused when the setting is missing after an upgrade', async () => {
  server = { cards: [card('pending', 1)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ store: { postcardMonitor: {
    since: card('pending', 1).createdAt, seenIds: ['pending'],
    jobs: [{ id: 'pending', notify: true, manual: true, attempts: 0, nextAttemptAt: 0 }],
  } } });
  await device.onInit();
  assert.deepEqual(server.identified, []);
  assert.equal(device.store.postcardMonitor.jobs.length, 1);
  device.settings.auto_identify = true;
  await device.refresh();
  assert.deepEqual(server.identified, ['pending']);
  assert.equal(device.store.postcardMonitor.jobs.length, 0);
});

test('Homey lifecycle migrates the capability, updates species/widget, and fires once per new visitor', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true } });
  await device.onInit();
  assert.equal(device.capabilities.get('last_species'), 'European Robin');
  assert.equal(device.getLastVisitorPhoto().species, 'European Robin');
  assert.deepEqual(device.events, []);
  server.cards.unshift(card('new', 1));
  await device.refresh();
  assert.deepEqual(device.events.map(event => event.name), ['visitor_arrived', 'bird_identified']);
  assert.deepEqual(device.events[1].tokens, {
    species: 'European Robin',
    time: card('new', 1).createdAt,
  });
  assert.ok(server.videoFeederIds.every(id => id === 'feeder'));
  const restarted = new FeederDevice({ store: device.store, settings: device.settings });
  await restarted.onInit();
  assert.deepEqual(restarted.events, []);
  assert.deepEqual(server.identified, ['baseline', 'new']);
});

test('a broken photo does not prevent identification or make the feeder unavailable', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [], failDownload: true };
  const device = new FeederDevice({ settings: { auto_identify: true } });
  await device.onInit();
  server.cards.unshift(card('new', 1));
  await device.refresh();
  assert.deepEqual(server.identified, ['baseline', 'new']);
  assert.equal(device.events[0].name, 'bird_identified');
  assert.equal(device.capabilities.get('measure_battery'), 75);
  assert.match(device.errors[0], /Expired photo/);
});

test('overlapping refreshes share one polling operation', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: false } });
  await device.onInit();
  let release;
  let calls = 0;
  device.client.getFeeders = () => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  };
  const first = device.refresh();
  const second = device.refresh();
  assert.equal(calls, 1);
  release([{ id: 'feeder', battery: {} }]);
  await Promise.all([first, second]);
  assert.deepEqual(server.identified, []);
});

test('video-only identification updates the species and preserves the previous photo after restart', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true } });
  await device.onInit();
  server.cards.unshift({ ...card('video', 1), imageUrl: undefined });
  device.client.identifyPostcard = async id => {
    const result = { ...await device.client.getPostcard(id), inferenceExecutionMode: 'MANUAL_COMPLETED',
      species: [{ id: 'jay', name: 'Jay' }] };
    server.cards[0] = result;
    return result;
  };
  await device.refresh();
  assert.equal(device.capabilities.get('last_species'), 'Jay');
  assert.equal(device.getLastVisitorPhoto().species, 'European Robin');
  const restarted = new FeederDevice({ store: device.store, settings: device.settings });
  await restarted.onInit();
  assert.equal(restarted.capabilities.get('last_species'), 'Jay');
  assert.equal(restarted.getLastVisitorPhoto().species, 'European Robin');
  assert.equal(restarted.events.length, 0);
});

test('visits that arrive together within one check are all counted, each once', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true, stats_retention_months: 24 } });
  await device.onInit();
  // Three birds between two checks; the newest card is first in the feed.
  server.cards.unshift(card('v3', 3));
  server.cards.unshift(card('v2', 2));
  server.cards.unshift(card('v1', 1));
  await device.refresh();
  const stats = device.getStatistics();
  assert.equal(stats.periods.total.total, 4); // baseline + 3 visits, all robins
  assert.equal(stats.periods.total.species[0].count, 4);

  // The same cards seen again (or after a restart) are not counted twice.
  await device.refresh();
  const restarted = new FeederDevice({ store: device.store, settings: device.settings });
  await restarted.onInit();
  await restarted.refresh();
  assert.equal(restarted.getStatistics().periods.total.total, 4);
});

test('species flows fire per counted visit with running totals, never for the baseline', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true } });
  await device.onInit();
  assert.deepEqual(device.statEvents, []);
  server.cards.unshift(card('v2', 2));
  server.cards.unshift(card('v1', 1));
  await device.refresh();
  const visited = device.statEvents.filter(event => event.name === 'species_visited');
  assert.deepEqual(visited.map(event => event.tokens.count_total), [2, 3]);
  assert.equal(visited[0].state.id, 'robin');
  assert.equal(device.statEvents.some(event => event.name === 'new_species'), false);
});

test('flow pickers list the counted species, with "any species" first', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true } });
  await device.onInit();
  const options = device.getSpeciesOptions('rob', true);
  assert.deepEqual(options.map(item => item.id), ['*', 'robin']);
  assert.deepEqual(device.getSpeciesOptions('zzz', false), []);
});

test('a shorter retention setting removes older days right away', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true, stats_retention_months: 24 } });
  await device.onInit();
  assert.equal(device.getStatistics().periods.total.total, 1);
  // The test visits are dated 19 Oct 2026; a one-month window can no longer reach them
  // once enough time has passed, so simulate that by moving a day far into the past.
  const days = device.stats.data.days;
  days['2020-01-01'] = { robin: 5 };
  await device.onSettings({ newSettings: { stats_retention_months: 12 }, changedKeys: ['stats_retention_months'] });
  assert.equal('2020-01-01' in device.store.visitStats.days, false);
  assert.equal(device.getStatistics().periods.total.total, 1);
});

const DAY = 24 * 3600 * 1000;
function historyDevice(report, settings = {}) {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [], report, reportCalls: [] };
  const device = new FeederDevice({ settings: { auto_identify: true, stats_retention_months: 24, ...settings } });
  device.backfillPauseMs = 0;
  return device;
}

// A fake Bird Buddy report: counts the given visits in a period, and - like the real
// service - answers a period without visits with "Internal server error".
function visitsReport(visits) {
  const names = { robin: 'European Robin', tit: 'Great Tit' };
  return ({ start, end }) => {
    const counts = {};
    for (const visit of visits) if (visit.t >= start && visit.t < end) counts[visit.id] = (counts[visit.id] || 0) + 1;
    const rows = Object.entries(counts).map(([id, count]) => ({ id, name: names[id], count }));
    if (!rows.length) throw new Error('Could not read the visit report: Internal server error.');
    return rows;
  };
}

test('on first connection the history is copied from Bird Buddy, empty periods count as zero', async () => {
  const now = Date.now();
  const device = historyDevice(visitsReport([
    { t: now - 3600e3, id: 'robin' }, { t: now - 3 * DAY, id: 'robin' },
    { t: now - 60 * DAY, id: 'tit' }, { t: now - 400 * DAY, id: 'robin' },
  ]));
  await device.onInit();
  await device.fillHistory(true); // wait for the background run that onInit started
  const stats = device.getStatistics();
  assert.equal(stats.periods.total.total, 4);
  assert.deepEqual(stats.periods.total.species.map(row => [row.name, row.count]),
    [['European Robin', 3], ['Great Tit', 1]]);
  assert.ok(device.store.visitStats.backfilledUntil);
  assert.equal(device.stats.hasHistory(), true);
});

test('the import is refused when the pieces do not add up to Bird Buddy\'s total', async () => {
  // Pieces report nothing, but the whole period reports visits: something was lost.
  const device = historyDevice(({ start, end }) => {
    if (end - start > 100 * DAY) return [{ id: 'robin', name: 'European Robin', count: 50 }];
    throw new Error('Could not read the visit report: Internal server error.');
  });
  await device.onInit();
  await assert.rejects(() => device.fillHistory(true), /History check failed/);
  assert.equal(device.store.visitStats?.backfilledUntil, undefined);
});

test('visits older than the import are not counted twice; newer ones are', async () => {
  const device = historyDevice(() => []);
  await device.onInit();
  await device.fillHistory(true);
  const until = Date.parse(device.store.visitStats.backfilledUntil);
  const before = { ...card('old', 1), createdAt: new Date(until - 60000).toISOString(),
    species: [{ id: 'robin', name: 'European Robin' }] };
  const after = { ...card('new', 2), createdAt: new Date(until + 60000).toISOString(),
    species: [{ id: 'robin', name: 'European Robin' }] };
  await device.recordVisit(before);
  await device.recordVisit(after);
  assert.equal(device.getStatistics().periods.total.total, 1);
});

test('visits that arrive while the history is being fetched are counted afterwards', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const device = historyDevice(async () => { await gate; return []; });
  await device.onInit();
  const running = device.fillHistory(true);
  const late = { ...card('late', 5), createdAt: new Date(Date.now() + DAY).toISOString(),
    species: [{ id: 'robin', name: 'European Robin' }] };
  await device.recordVisit(late);
  assert.equal(device.pendingRecords.length, 1, 'queued while fetching');
  release();
  await running;
  assert.equal(device.pendingRecords.length, 0);
  // The baseline visit counted before the import is replaced; the late visit is counted.
  assert.equal(device.stats.count('robin', 'total', Date.now() + DAY, 'Europe/Brussels'), 1);
});

test('a failing history request changes nothing and is retried later', async () => {
  let fail = true;
  const device = historyDevice(() => { if (fail) throw new Error('Network down'); return []; });
  await device.onInit();
  await assert.rejects(() => device.fillHistory(true), /Network down/);
  assert.equal(device.store.visitStats?.backfilledUntil, undefined);
  assert.ok(!device.backfilling);
  // Not retried straight away ...
  const before = server.reportCalls.length;
  await device.fillHistory(false);
  assert.equal(server.reportCalls.length, before);
  // ... but works when forced (the "fetch again" checkbox).
  fail = false;
  await device.fillHistory(true);
  assert.ok(device.store.visitStats.backfilledUntil);
});

test('the "fetch again" checkbox runs the import and switches itself off', async () => {
  const device = historyDevice(() => []);
  let reset = null;
  device.setSettings = async values => { reset = values; };
  await device.onInit();
  await device.onSettings({ newSettings: { stats_reimport: true }, changedKeys: ['stats_reimport'] });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual(reset, { stats_reimport: false });
  assert.ok(device.store.visitStats.backfilledUntil);
});

test('switching automatic identification on identifies the latest visit at once, only the first time', async () => {
  server = { cards: [card('latest', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: false } });
  await device.onInit();
  assert.deepEqual(server.identified, []);
  assert.equal(device.capabilities.get('last_species'), 'species.unknown');

  device.settings.auto_identify = true;
  await device.onSettings({ newSettings: { auto_identify: true }, changedKeys: ['auto_identify'] });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(server.identified, ['latest']);
  assert.equal(device.capabilities.get('last_species'), 'European Robin');
  assert.equal(device.events.some(event => event.name === 'bird_identified'), false, 'no Flow for an old visit');

  await device.refresh();
  assert.deepEqual(server.identified, ['latest'], 'not repeated');
});

test('a feeder that already shows a bird is not identified again at startup', async () => {
  server = { cards: [card('latest', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true },
    store: { lastIdentification: { species: 'Jay', time: card('x', 0).createdAt } } });
  await device.onInit();
  assert.equal(device.store.latestQueued, undefined);
});

test('bird names follow the chosen language in the device, Flow tokens, widgets and pickers', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true, species_language: 'nl' } });
  await device.onInit();
  assert.equal(device.capabilities.get('last_species'), 'Roodborst');
  assert.equal(device.getLastVisitorPhoto().species, 'Roodborst');
  assert.equal(device.getStatistics().periods.total.species[0].name, 'Roodborst');
  assert.deepEqual(device.getSpeciesOptions('rood', false).map(item => item.name), ['Roodborst']);
  assert.deepEqual(device.getSpeciesOptions('robin', false).map(item => item.name), ['Roodborst'], 'English still finds it');
  server.cards.unshift(card('new', 1));
  await device.refresh();
  assert.equal(device.events.find(event => event.name === 'bird_identified').tokens.species, 'Roodborst');
  assert.equal(device.statEvents.find(event => event.name === 'species_visited').tokens.species, 'Roodborst');
  assert.equal(device.stats.speciesList()[0].name, 'European Robin', 'stored name stays English');
});

test('"same as Homey" follows the Homey language, and changing the setting updates the device at once', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true } }); // species_language unset = automatic
  device.homey.i18n.getLanguage = () => 'nl';
  await device.onInit();
  assert.equal(device.capabilities.get('last_species'), 'Roodborst');
  await device.onSettings({ newSettings: { species_language: 'de' }, changedKeys: ['species_language'] });
  assert.equal(device.capabilities.get('last_species'), 'Rotkehlchen');
  await device.onSettings({ newSettings: { species_language: 'en' }, changedKeys: ['species_language'] });
  assert.equal(device.capabilities.get('last_species'), 'European Robin');
});

test('a language Homey has but the list does not (for example Swedish) falls back to English', async () => {
  server = { cards: [card('baseline', 0)], identified: [], videoFeederIds: [] };
  const device = new FeederDevice({ settings: { auto_identify: true } });
  device.homey.i18n.getLanguage = () => 'sv';
  await device.onInit();
  assert.equal(device.capabilities.get('last_species'), 'European Robin');
});
