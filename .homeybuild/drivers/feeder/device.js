'use strict';

const Homey = require('homey');
const BirdBuddyClient = require('../../lib/birdbuddy');

const DEFAULT_INTERVAL_MIN = 15;

class FeederDevice extends Homey.Device {
  async onInit() {
    // Devices added with an older version of this app get the capability changes here.
    if (this.hasCapability('alarm_battery')) await this.removeCapability('alarm_battery');
    if (this.hasCapability('feeder_charging')) await this.removeCapability('feeder_charging');

    this.client = new BirdBuddyClient({
      ...this.getStore(),
      onTokens: tokens => this.saveTokens(tokens),
    });
    await this.migrateCredentials();
    this.log(this.client.password
      ? 'Login storage: password kept as fallback'
      : 'Login storage: tokens only, no password stored');

    this.imageBuffer = null;
    this.lastPostcardId = null;
    this.visitorTrigger = this.homey.flow.getDeviceTriggerCard('visitor_arrived');

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
  }

  async refresh() {
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
    await this.updateLastVisitor().catch(err => this.error(`Last visitor: ${err.message}`));
  }

  async updateLastVisitor() {
    const card = await this.client.getLatestPostcard();
    if (!card || card.id === this.lastPostcardId) return;

    // Remembered across restarts, so old visitors don't trigger flows again.
    const previousId = this.getStoreValue('lastPostcardId');

    // Media URLs are time-limited, so download the photo right away.
    this.imageBuffer = await this.client.download(card.imageUrl);
    this.lastPostcardId = card.id;
    await this.image.update();
    await this.setStoreValue('lastPostcardId', card.id);
    await this.setStoreValue('lastVisitAt', String(card.createdAt || ''));
    this.log(`New visitor photo (${card.createdAt})`);

    await this.checkVideo().catch(err => this.error(`Video: ${err.message}`));

    // First run only sets the baseline; flows fire from the next new visitor on.
    if (previousId && previousId !== card.id) {
      await this.fireVisitorTrigger(card);
    }
  }

  async checkVideo() {
    this.hasVideo = Boolean(await this.getLatestVideoUrl());
    this.log(this.hasVideo ? 'Visitor video available' : 'No video with this visit');
  }

  async getLatestVideoUrl() {
    const video = await this.client.getLatestVideo();
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
  }
}

module.exports = FeederDevice;
