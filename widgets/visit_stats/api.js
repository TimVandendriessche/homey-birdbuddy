'use strict';

module.exports = {
  // Statistics of the first feeder. Counts come from the app's own tally.
  async getStatistics({ homey }) {
    try {
      const [device] = homey.drivers.getDriver('feeder').getDevices();
      return device ? device.getStatistics() : null;
    } catch (err) {
      homey.app.error(`Statistics widget: ${err.message}`);
      return null;
    }
  },
};
