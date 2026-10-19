'use strict';

const Homey = require('homey');

class BirdBuddyApp extends Homey.App {
  async onInit() {
    this.homey.flow
      .getConditionCard('visitor_within')
      .registerRunListener(async ({ device, minutes }) => device.hadVisitorWithin(minutes));

    this.log('Bird Buddy (unofficial) started');
  }
}

module.exports = BirdBuddyApp;
