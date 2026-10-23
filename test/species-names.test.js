'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { translate, translateList, isBird, SUPPORTED, NAMES } = require('../lib/species-names');

test('species of the feeder are translated to Dutch, German and French', () => {
  assert.equal(translate('Great Tit', 'nl'), 'Koolmees');
  assert.equal(translate('Eurasian Blue Tit', 'nl'), 'Pimpelmees');
  assert.equal(translate('European Robin', 'de'), 'Rotkehlchen');
  assert.equal(translate('Common Blackbird', 'fr'), 'Merle noir');
});

test('English, unknown languages and unknown species keep the English name', () => {
  assert.equal(translate('Great Tit', 'en'), 'Great Tit');
  assert.equal(translate('Great Tit', 'sv'), 'Great Tit');
  assert.equal(translate('Bald Eagle', 'nl'), 'Bald Eagle');
});

test('spelling variants of a name still match', () => {
  assert.equal(translate('Common Wood-Pigeon', 'nl'), 'Houtduif');
  assert.equal(translate('common wood pigeon', 'nl'), 'Houtduif');
  assert.equal(translate('Feral Pigeon', 'nl'), 'Stadsduif');
});

test('lists of several species are translated one by one', () => {
  assert.equal(translateList('Great Tit, Bald Eagle, Fly', 'nl'), 'Koolmees, Bald Eagle, Vlieg');
  assert.equal(translateList('', 'nl'), '');
});

test('every entry is complete and no English name appears twice', () => {
  const seen = new Set();
  for (const row of NAMES) {
    assert.equal(row.length, 4, row[0]);
    assert.ok(row.every(cell => typeof cell === 'string' && cell.trim() && !cell.includes(', ')), row[0]);
    assert.equal(seen.has(row[0].toLowerCase()), false, `duplicate ${row[0]}`);
    seen.add(row[0].toLowerCase());
  }
  assert.deepEqual(SUPPORTED, ['en', 'nl', 'de', 'fr']);
});

test('a fly is not a bird, everything else is', () => {
  assert.equal(isBird('Fly'), false);
  assert.equal(isBird(' fly '), false);
  assert.equal(isBird('Great Tit'), true);
});
