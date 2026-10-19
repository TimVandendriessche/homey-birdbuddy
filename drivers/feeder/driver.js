'use strict';

const Homey = require('homey');
const BirdBuddyClient = require('../../lib/birdbuddy');

class FeederDriver extends Homey.Driver {
  async onPair(session) {
    let client = null;
    let store = null;

    session.setHandler('login', async ({ username, password }) => {
      let tokens;
      try {
        tokens = await BirdBuddyClient.signIn(username, password);
      } catch (err) {
        if (err.code === 'AUTH') return false; // wrong email/password
        throw err; // network problem etc.
      }

      client = new BirdBuddyClient(tokens);

      // Only keep tokens when refreshing is proven to work. If it doesn't,
      // keep the login as a fallback, otherwise the device would stop working.
      if (await client.verifyRefresh()) {
        store = { accessToken: client.accessToken, refreshToken: client.refreshToken };
        this.log('Pairing: token login verified, password is not stored');
      } else {
        this.error('Token refresh not available: keeping login as fallback');
        store = { accessToken: tokens.accessToken, email: username, password };
        if (tokens.refreshToken) store.refreshToken = tokens.refreshToken;
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      const feeders = await client.getFeeders();
      return feeders.map(feeder => ({
        name: feeder.name || 'Bird Buddy',
        data: { id: feeder.id },
        store,
      }));
    });
  }

  // Log in again for an existing device (for example after a password change).
  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      let tokens;
      try {
        tokens = await BirdBuddyClient.signIn(username, password);
      } catch (err) {
        if (err.code === 'AUTH') return false;
        throw err;
      }
      await device.applyNewLogin(tokens, { email: username, password });
      return true;
    });
  }
}

module.exports = FeederDriver;
