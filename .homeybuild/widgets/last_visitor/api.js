'use strict';

function devices(homey) {
  return homey.drivers.getDriver('feeder').getDevices();
}

module.exports = {
  async getPhoto({ homey }) {
    try {
      for (const device of devices(homey)) {
        const photo = device.getLastVisitorPhoto();
        if (photo) return photo;
      }
    } catch (err) {
      homey.app.error(`Widget: ${err.message}`);
    }
    return null;
  },

  // Video URLs are time-limited, so a fresh one is requested on every play.
  async getVideo({ homey }) {
    try {
      for (const device of devices(homey)) {
        const url = await device.getLatestVideoUrl();
        if (url) return { url };
      }
    } catch (err) {
      homey.app.error(`Widget video: ${err.message}`);
    }
    return null;
  },
};
