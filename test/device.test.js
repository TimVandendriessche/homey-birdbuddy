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
    this.errors = [];
    this.homey = {
      __: key => key,
      clearInterval: () => {}, setInterval: () => 1,
      flow: { getDeviceTriggerCard: name => ({ trigger: async (_, tokens) => this.events.push({ name, tokens }) }) },
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
