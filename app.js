'use strict';

const Homey = require('homey');

const ANY = '*';

class BirdBuddyApp extends Homey.App {
  async onInit() {
    this.homey.flow
      .getConditionCard('visitor_within')
      .registerRunListener(async ({ device, minutes }) => device.hadVisitorWithin(minutes));

    // A species picker lists the birds counted so far; "any species" is also allowed
    // on the card where that makes sense.
    const visited = this.homey.flow.getDeviceTriggerCard('species_visited');
    visited.registerArgumentAutocompleteListener('species',
      async (query, args) => args.device.getSpeciesOptions(query, true));
    visited.registerRunListener(async (args, state) => (
      args.species.id === ANY || args.species.id === state.id
    ));

    const milestone = this.homey.flow.getDeviceTriggerCard('species_milestone');
    milestone.registerArgumentAutocompleteListener('species',
      async (query, args) => args.device.getSpeciesOptions(query, true));
    milestone.registerRunListener(async (args, state) => {
      const every = Math.floor(Number(args.every));
      if (!(every >= 1)) return false;
      if (args.species.id === ANY) return state.total % every === 0;
      return args.species.id === state.id && state.count % every === 0;
    });

    this.homey.flow.getDeviceTriggerCard('rare_visitor')
      .registerRunListener(async (args, state) => state.count <= Math.floor(Number(args.times)));

    this.homey.flow.getDeviceTriggerCard('no_visitors')
      .registerRunListener(async (args, state) => args.device.shouldFireNoVisitors(args.hours, state));

    this.log('Bird Buddy (unofficial) started');
  }
}

module.exports = BirdBuddyApp;
