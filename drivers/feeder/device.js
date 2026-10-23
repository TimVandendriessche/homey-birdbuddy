'use strict';

const Homey = require('homey');
const BirdBuddyClient = require('../../lib/birdbuddy');
const PostcardMonitor = require('../../lib/postcard-monitor');
const { VisitStats, planBackfill, localHour, dayKey } = require('../../lib/stats');
const { translate, translateList, isBird, SUPPORTED } = require('../../lib/species-names');

const DEFAULT_INTERVAL_MIN = 15;
const BACKFILL_RETRY_MS = 6 * 60 * 60 * 1000;
const BACKFILL_PAUSE_MS = 250;
const MAX_BACKFILL_MONTHS = 120;
const BACKFILL_PARALLEL = 4;
const TICK_MS = 5 * 60 * 1000;
const HOUR_MS = 3600 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class FeederDevice extends Homey.Device {
  async onInit() {
    // Devices added with an older version of this app get the capability changes here.
    if (this.hasCapability('alarm_battery')) await this.removeCapability('alarm_battery');
    if (this.hasCapability('feeder_charging')) await this.removeCapability('feeder_charging');
    if (!this.hasCapability('last_species')) await this.addCapability('last_species');
    if (!this.hasCapability('visits_today')) await this.addCapability('visits_today');
    await this.showLastSpecies();

    this.client = new BirdBuddyClient({
      ...this.getStore(),
      onTokens: tokens => this.saveTokens(tokens),
    });
    await this.migrateCredentials();
    this.log(this.client.password
      ? 'Login storage: password kept as fallback'
      : 'Login storage: tokens only, no password stored');

    this.stats = new VisitStats(this.getStoreValue('visitStats'));
    this.countNonBirds = this.getSetting('count_non_birds') === true;
    this.stats.filter = name => this.countNonBirds || isBird(name);
    this.recorded = new Map();
    this.pendingRecords = [];
    this.backfilling = null;
    this.imageBuffer = null;
    this.lastPostcardId = null;
    this.visitorTrigger = this.homey.flow.getDeviceTriggerCard('visitor_arrived');
    this.identifiedTrigger = this.homey.flow.getDeviceTriggerCard('bird_identified');
    this.monitor = new PostcardMonitor({
      client: this.client,
      feederId: this.getData().id,
      state: this.getStoreValue('postcardMonitor'),
      saveState: state => this.setStoreValue('postcardMonitor', state),
      onCards: cards => this.updateVisitorCards(cards),
      onAnalysis: async card => {
        await this.updateSpecies(card);
        await this.recordVisit(card);
      },
      onIdentified: async card => {
        await this.identifiedTrigger.trigger(this, {
          species: card.species.map(species => this.speciesName(species.name)).join(', '),
          time: String(card.createdAt || ''),
        });
        await this.fireStatTriggers(card).catch(err => this.error(`Statistics flows: ${err.message}`));
      },
      onError: err => this.error(err.message),
    });

    // Camera image shown on the device: the most recent visitor photo.
    this.image = await this.homey.images.createImage();
    this.image.setStream(async stream => {
      if (this.imageBuffer) stream.end(this.imageBuffer);
      else stream.end();
    });
    await this.setCameraImage('lastVisitor', this.homey.__('camera.lastVisitor'), this.image);

    // Camera video: the video of the most recent visitor (fresh URL on every play).
    this.hasVideo = false;
    try {
      this.video = await this.homey.videos.createVideoOther();
      this.video.registerVideoUrlListener(async () => {
        const url = await this.getLatestVideoUrl();
        if (!url) throw new Error('No visitor video available');
        return { url };
      });
      await this.setCameraVideo('lastVisitorVideo', this.homey.__('camera.lastVisitorVideo'), this.video);
    } catch (err) {
      this.error(`Video setup: ${err.message}`);
    }

    await this.refresh();
    this.startPolling(this.getSetting('poll_interval'));

    // Housekeeping every few minutes: the "visits today" value at midnight, the daily
    // summary and the "no visitors" Flow.
    this.tickTimer = this.homey.setInterval(() => this.tick().catch(err => this.error(`Tick: ${err.message}`)), TICK_MS);
    await this.tick().catch(err => this.error(`Tick: ${err.message}`));
  }

  async saveTokens({ accessToken, refreshToken }) {
    await this.setStoreValue('accessToken', accessToken);
    if (refreshToken) await this.setStoreValue('refreshToken', refreshToken);
  }

  // Devices added by older versions stored the Bird Buddy password. Switch them to
  // tokens, but only drop the password once refreshing is proven to work.
  async migrateCredentials() {
    const { email, password } = this.getStore();
    if (!email && !password) return;
    try {
      await this.client.ensureSession();
      if (await this.client.verifyRefresh()) {
        await this.unsetStoreValue('email');
        await this.unsetStoreValue('password');
        this.client.forgetPassword();
        this.log('Bird Buddy password is no longer stored');
      } else {
        this.log('Token refresh not available: login kept as fallback');
      }
    } catch (err) {
      this.error(`Credential migration: ${err.message}`);
    }
  }

  // Called from the Repair flow after the user logged in again.
  async applyNewLogin(tokens, credentials) {
    this.client.forgetPassword();
    this.client.accessToken = tokens.accessToken;
    this.client.refreshToken = tokens.refreshToken || null;

    if (await this.client.verifyRefresh()) {
      await this.unsetStoreValue('email').catch(() => {});
      await this.unsetStoreValue('password').catch(() => {});
    } else {
      // No working refresh: keep the login as fallback so the device keeps working.
      this.client.email = credentials.email;
      this.client.password = credentials.password;
      await this.setStoreValue('email', credentials.email);
      await this.setStoreValue('password', credentials.password);
      await this.saveTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    }
    await this.refresh();
  }

  startPolling(minutes) {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const interval = Math.max(5, Number(minutes) || DEFAULT_INTERVAL_MIN);
    this.pollTimer = this.homey.setInterval(() => this.refresh(), interval * 60 * 1000);
    this.log(`Checking Bird Buddy every ${interval} minutes`);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.startPolling(newSettings.poll_interval);
    }
    if (changedKeys.includes('count_non_birds')) {
      this.countNonBirds = newSettings.count_non_birds === true;
      await this.updateVisitsToday();
    }
    if (changedKeys.includes('species_language')) {
      await this.showLastSpecies(this.speciesLanguage(newSettings.species_language));
    }
    if (changedKeys.includes('auto_identify') && newSettings.auto_identify) {
      // Identify the latest visitor right away. Runs after the new setting is in place.
      await this.setStoreValue('latestQueued', false);
      this.homey.setTimeout(() => this.refresh().catch(err => this.error(err.message)), 1000);
    }
    if (changedKeys.includes('stats_reimport') && newSettings.stats_reimport) {
      // Fetch the history again; the checkbox switches itself off when done.
      this.fillHistory(true)
        .catch(err => this.error(`History: ${err.message}`))
        .finally(() => this.setSettings({ stats_reimport: false }).catch(this.error));
    }
    if (changedKeys.includes('stats_retention_months')) {
      // A shorter period removes the older days right away.
      this.stats.prune(newSettings.stats_retention_months, Date.now(), this.timeZone());
      await this.setStoreValue('visitStats', this.stats.toJSON());
    }
  }

  async refresh() {
    // A slow inference request, Repair, and the interval must not overlap.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshOnce() {
    try {
      const feeders = await this.client.getFeeders();
      const feeder = feeders.find(f => f.id === this.getData().id);
      if (!feeder) throw new Error('Feeder not found in your Bird Buddy account');

      const battery = feeder.battery || {};
      // Offline feeders don't report battery, so we keep the last known values.
      if (typeof battery.percentage === 'number') {
        await this.setCapabilityValue('measure_battery', Math.round(battery.percentage));
      }
      await this.setAvailable();
    } catch (err) {
      this.error(err.message);
      await this.setUnavailable(err.message).catch(this.error);
      return;
    }

    // The photo is a bonus: a failure here must never break the battery status.
    await this.monitor.poll(this.getSetting('auto_identify') === true)
      .catch(err => this.error(`Visitors: ${err.message}`));

    await this.identifyLatestOnce().catch(err => this.error(`Latest visitor: ${err.message}`));

    // Once per device: copy the existing numbers from Bird Buddy. Runs in the background.
    if (!this.stats.data.backfilledUntil) {
      this.fillHistory(false).catch(err => this.error(`History: ${err.message}`));
    }
  }

  // With automatic identification on and no bird known yet, identify the latest visit once.
  async identifyLatestOnce() {
    if (this.getSetting('auto_identify') !== true) return;
    if (this.getStoreValue('lastIdentification') || this.getStoreValue('latestQueued')) return;
    await this.setStoreValue('latestQueued', true);
    if (await this.monitor.queueLatest()) await this.monitor.poll(true);
  }

  // Fills the statistics with the visit counts Bird Buddy already has.
  // A second call while one is running waits for that one.
  fillHistory(force) {
    if (this.backfilling) return this.backfilling;
    const last = Date.parse(this.getStoreValue('historyAttemptAt'));
    if (!force && Number.isFinite(last) && Date.now() - last < BACKFILL_RETRY_MS) return Promise.resolve();
    this.backfilling = this.runHistory()
      .finally(async () => {
        this.backfilling = null;
        // Visits that came in while the history was being fetched.
        const waiting = this.pendingRecords.splice(0);
        for (const card of waiting) await this.recordVisit(card).catch(err => this.error(err.message));
      });
    return this.backfilling;
  }

  // Visits per species in one period. A period without visits makes Bird Buddy answer
  // "Internal server error"; after one retry that is treated as no visits.
  async fetchWindow(userId, feederId, window) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.client.getVisitReport({ userId, feederId, start: window.start, end: window.end });
      } catch (err) {
        if (!/Internal server error/i.test(err.message)) throw err;
      }
    }
    return [];
  }

  async runHistory() {
    await this.setStoreValue('historyAttemptAt', new Date().toISOString());
    const retention = Number(this.getSetting('stats_retention_months')) || 0;
    const months = retention > 0 ? Math.min(retention, MAX_BACKFILL_MONTHS) : 60;
    const now = Date.now();
    const feederId = this.getData().id;
    const userId = await this.client.getUserId();

    const buckets = {};
    const names = {};
    const plan = planBackfill(now, this.timeZone(), months);
    this.log(`History: fetching ${plan.length} periods from Bird Buddy`);
    const pause = this.backfillPauseMs === undefined ? BACKFILL_PAUSE_MS : this.backfillPauseMs;
    let next = 0;
    let done = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < plan.length) {
        const window = plan[next]; next += 1;
        try {
          const rows = await this.fetchWindow(userId, feederId, window);
          for (const row of rows) {
            (buckets[window.key] || (buckets[window.key] = {}))[row.id] = row.count;
            names[row.id] = row.name;
          }
        } catch (err) {
          failed = true;
          throw err;
        }
        done += 1;
        if (done % 10 === 0) this.log(`History: ${done}/${plan.length} periods`);
        await sleep(pause);
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_PARALLEL }, worker));

    // Bird Buddy answers a period without visits with an error, which we count as zero.
    // Safety net: the pieces must add up to the total over the whole period.
    const whole = await this.fetchWindow(userId, feederId,
      { start: Math.min(...plan.map(window => window.start)), end: now });
    const expected = whole.reduce((sum, row) => sum + row.count, 0);
    const found = Object.values(buckets).reduce((sum, bucket) => (
      sum + Object.values(bucket).reduce((a, b) => a + b, 0)), 0);
    if (Math.abs(found - expected) > Math.max(2, Math.ceil(expected * 0.01))) {
      throw new Error(`History check failed: periods add up to ${found}, Bird Buddy says ${expected}`);
    }
    this.stats.applyBackfill(buckets, names, now);
    this.stats.prune(retention, Date.now(), this.timeZone());
    await this.setStoreValue('visitStats', this.stats.toJSON());
    this.log(`History filled: ${Object.keys(names).length} species, ${found} visits (checked)`);
  }

  async updateLastVisitor(card) {
    if (!card || card.id === this.lastPostcardId) return;

    // Remembered across restarts, so old visitors don't trigger flows again.
    const previousId = this.getStoreValue('lastPostcardId');

    // Media URLs are time-limited, so download the photo right away.
    this.imageBuffer = await this.client.download(card.imageUrl);
    this.lastPostcardId = card.id;
    await this.image.update();
    await this.setStoreValue('lastPostcardId', card.id);
    await this.setStoreValue('lastVisitAt', String(card.createdAt || ''));
    await this.updateSpecies(card);
    this.log(`New visitor photo (${card.createdAt})`);

    await this.checkVideo().catch(err => this.error(`Video: ${err.message}`));

    // First run only sets the baseline; flows fire from the next new visitor on.
    if (previousId && previousId !== card.id) {
      await this.fireVisitorTrigger(card);
    }
  }

  async updateVisitorCards(cards) {
    let card = cards.find(item => item.imageUrl);
    // A cursor may point to a video-only visit. Restore the older photo after a
    // restart without moving the identification cursor backwards.
    if (!card && !this.imageBuffer) card = await this.client.getLatestPostcard(this.getData().id);
    await this.updateLastVisitor(card);
  }

  async checkVideo() {
    this.hasVideo = Boolean(await this.getLatestVideoUrl());
    this.log(this.hasVideo ? 'Visitor video available' : 'No video with this visit');
  }

  async getLatestVideoUrl() {
    const video = await this.client.getLatestVideo(this.getData().id);
    return video ? video.url : null;
  }

  // Used by the flow condition "A visitor came in the last X minutes".
  hadVisitorWithin(minutes) {
    const at = Date.parse(this.getStoreValue('lastVisitAt'));
    if (Number.isNaN(at)) return false;
    return Date.now() - at <= Number(minutes) * 60 * 1000;
  }

  // Used by the dashboard widget.
  getLastVisitorPhoto() {
    if (!this.imageBuffer) return null;
    return {
      dataUrl: `data:image/jpeg;base64,${this.imageBuffer.toString('base64')}`,
      time: this.getStoreValue('lastVisitAt') || null,
      hasVideo: this.hasVideo,
      species: translateList(this.getStoreValue('lastSpecies') || '', this.speciesLanguage()),
    };
  }

  async updateSpecies(card) {
    const species = card.species.map(item => item.name).join(', ');
    if (card.id === this.lastPostcardId) await this.setStoreValue('lastSpecies', species);
    const previous = this.getStoreValue('lastIdentification');
    if (species && (!previous || Date.parse(card.createdAt) >= Date.parse(previous.time))) {
      await this.setStoreValue('lastIdentification', { species, time: card.createdAt });
      await this.showLastSpecies();
    }
  }

  // Language of the bird names: the setting, or the Homey language when set to automatic.
  speciesLanguage(setting = this.getSetting('species_language')) {
    const wanted = !setting || setting === 'auto'
      ? (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'en'
      : setting;
    return SUPPORTED.includes(wanted) ? wanted : 'en';
  }

  speciesName(name, language) {
    return translate(name, language || this.speciesLanguage());
  }

  // The last identified species in the chosen language (the stored name stays English).
  async showLastSpecies(language) {
    const species = this.getStoreValue('lastIdentification')?.species;
    await this.setCapabilityValue('last_species',
      species ? translateList(species, language || this.speciesLanguage()) : this.homey.__('species.unknown'));
  }

  async updateVisitsToday() {
    const value = this.stats.total('day', Date.now(), this.timeZone());
    if (this.getCapabilityValue && this.getCapabilityValue('visits_today') === value) return;
    await this.setCapabilityValue('visits_today', value);
  }

  // Runs every few minutes (and once at startup).
  async tick(now = Date.now()) {
    await this.updateVisitsToday();
    await this.sendSummaryIfDue(now);
    await this.checkNoVisitors(now);
  }

  // Once a day, from the chosen hour on: the visits of that day, for a notification.
  async sendSummaryIfDue(now) {
    const zone = this.timeZone();
    const today = dayKey(now, zone);
    const hour = Number(this.getSetting('summary_hour'));
    if (localHour(now, zone) < (Number.isFinite(hour) ? hour : 20)) return;
    if (this.getStoreValue('summaryDay') === today) return;
    await this.setStoreValue('summaryDay', today);
    const rows = this.stats.counts('day', now, zone);
    if (!rows.length) return;
    await this.homey.flow.getDeviceTriggerCard('daily_summary').trigger(this, {
      summary: rows.map(row => `${row.count}× ${this.speciesName(row.name)}`).join(', '),
      total: rows.reduce((sum, row) => sum + row.count, 0),
      species: rows.length,
    });
  }

  // Offers the silence to every "no visitor for X hours" Flow; each Flow decides in
  // shouldFireNoVisitors whether it is its turn.
  async checkNoVisitors(now) {
    const last = this.getStoreValue('lastVisitAt');
    const since = (now - Date.parse(last)) / HOUR_MS;
    if (!last || !Number.isFinite(since) || since < 1) return;
    await this.homey.flow.getDeviceTriggerCard('no_visitors')
      .trigger(this, { hours: Math.floor(since), last_visit: String(last) }, { hours: since, last });
  }

  // Each Flow fires once per silence: the same quiet period never fires it twice.
  async shouldFireNoVisitors(hours, state) {
    if (!(state.hours >= Number(hours))) return false;
    const fired = { ...(this.getStoreValue('silenceFired') || {}) };
    if (fired[String(hours)] === state.last) return false;
    fired[String(hours)] = state.last;
    await this.setStoreValue('silenceFired', fired);
    return true;
  }

  timeZone() {
    return this.homey.clock.getTimezone();
  }

  // Counts every identified visit once. Runs for each postcard, also for visits that
  // arrived together within one check interval.
  async recordVisit(card) {
    if (this.backfilling) { this.pendingRecords.push(card); return; }
    const results = this.stats.record(card, this.timeZone());
    if (!results.length) return;
    this.stats.prune(this.getSetting('stats_retention_months'), Date.now(), this.timeZone());
    await this.setStoreValue('visitStats', this.stats.toJSON());
    this.recorded.set(card.id, results);
    await this.updateVisitsToday().catch(err => this.error(err.message));
    // Only the latest few are needed: flows for a card run right after it is counted.
    if (this.recorded.size > 50) this.recorded.delete(this.recorded.keys().next().value);
  }

  async fireStatTriggers(card) {
    const results = this.recorded.get(card.id) || [];
    this.recorded.delete(card.id);
    const now = Date.now();
    const zone = this.timeZone();
    const total = this.stats.total('total', now, zone);
    for (const result of results) {
      if (!this.stats.visible(result.id)) continue; // for example a fly
      const count = this.stats.count(result.id, 'total', now, zone);
      const tokens = {
        species: this.speciesName(result.name),
        count_today: this.stats.count(result.id, 'day', now, zone),
        count_total: count,
      };
      const state = { id: result.id, count, total };
      await this.homey.flow.getDeviceTriggerCard('species_visited').trigger(this, tokens, state);
      await this.homey.flow.getDeviceTriggerCard('species_milestone')
        .trigger(this, { species: this.speciesName(result.name), count, total }, state);
      await this.homey.flow.getDeviceTriggerCard('rare_visitor')
        .trigger(this, { species: this.speciesName(result.name), count }, state);
      if (result.isNew) {
        await this.homey.flow.getDeviceTriggerCard('new_species')
          .trigger(this, { species: this.speciesName(result.name) }, state);
      }
    }
  }

  // Choices for the species pickers in Flow cards.
  getSpeciesOptions(query, includeAny) {
    const text = String(query || '').toLowerCase();
    const options = this.stats.speciesList()
      .map(item => ({ id: item.id, name: this.speciesName(item.name), english: item.name, count: item.count }))
      .filter(item => item.name.toLowerCase().includes(text) || item.english.toLowerCase().includes(text))
      .map(item => ({ id: item.id, name: item.name, description: `${item.count}×` }));
    if (includeAny) options.unshift({ id: '*', name: this.homey.__('species.any') });
    return options;
  }

  // Used by the statistics widget.
  getStatistics() {
    const now = Date.now();
    const zone = this.timeZone();
    const periods = {};
    for (const period of ['day', 'week', 'month', 'year', 'total']) {
      periods[period] = {
        total: this.stats.total(period, now, zone),
        species: this.stats.counts(period, now, zone).slice(0, 10)
          .map(row => ({ ...row, name: this.speciesName(row.name), hour: this.stats.busiestHour(row.id) })),
      };
    }
    return {
      periods,
      daily: this.stats.daily(14, now, zone),
      retentionMonths: Number(this.getSetting('stats_retention_months')) || 0,
    };
  }

  async fireVisitorTrigger(card) {
    const buffer = this.imageBuffer;
    const image = await this.homey.images.createImage();
    image.setStream(async stream => stream.end(buffer));
    await this.visitorTrigger.trigger(this, { image, time: String(card.createdAt || '') });
  }

  async onDeleted() {
    this.homey.clearInterval(this.pollTimer);
    this.homey.clearInterval(this.tickTimer);
  }
}

module.exports = FeederDevice;
