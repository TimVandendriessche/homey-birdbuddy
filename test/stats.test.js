'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VisitStats, dayKey, weekStart, planBackfill, localMidnight, localHour } = require('../lib/stats');

const TZ = 'Europe/Brussels';
const robin = { id: 'robin', name: 'European Robin' };
const tit = { id: 'tit', name: 'Great Tit' };
const card = (id, createdAt, ...species) => ({ id, createdAt, species });
const NOW = Date.parse('2026-10-23T10:00:00Z'); // Friday

test('dayKey uses the local time zone, not UTC', () => {
  assert.equal(dayKey('2026-10-22T22:30:00Z', TZ), '2026-10-23'); // 00:30 in Brussels
  assert.equal(dayKey('2026-10-22T22:30:00Z', 'UTC'), '2026-10-22');
});

test('weekStart returns the Monday', () => {
  assert.equal(weekStart('2026-10-23'), '2026-10-19');
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
  assert.equal(weekStart('2026-10-25'), '2026-10-19');
});

test('a postcard is counted once, even when recorded again', () => {
  const stats = new VisitStats();
  assert.equal(stats.record(card('a', '2026-10-23T08:00:00Z', robin), TZ).length, 1);
  assert.equal(stats.record(card('a', '2026-10-23T08:00:00Z', robin), TZ).length, 0);
  assert.equal(stats.count('robin', 'total', NOW, TZ), 1);
});

test('cards without species are ignored', () => {
  const stats = new VisitStats();
  assert.deepEqual(stats.record(card('a', '2026-10-23T08:00:00Z'), TZ), []);
  assert.equal(stats.hasHistory(), false);
});

test('several visits within one interval are all counted, by visit time', () => {
  const stats = new VisitStats();
  stats.record(card('1', '2026-10-23T07:00:00Z', robin), TZ);
  stats.record(card('2', '2026-10-23T07:05:00Z', robin), TZ);
  stats.record(card('3', '2026-10-23T07:09:00Z', tit), TZ);
  assert.equal(stats.count('robin', 'day', NOW, TZ), 2);
  assert.equal(stats.total('day', NOW, TZ), 3);
});

test('periods: day, week, month, year, total', () => {
  const stats = new VisitStats();
  stats.record(card('1', '2026-10-23T07:00:00Z', robin), TZ); // today
  stats.record(card('2', '2026-10-20T07:00:00Z', robin), TZ); // this week
  stats.record(card('3', '2026-10-02T07:00:00Z', robin), TZ); // this month
  stats.record(card('4', '2026-03-02T07:00:00Z', robin), TZ); // this year
  stats.record(card('5', '2025-03-02T07:00:00Z', robin), TZ); // last year
  const get = period => stats.count('robin', period, NOW, TZ);
  assert.deepEqual(['day', 'week', 'month', 'year', 'total'].map(get), [1, 2, 3, 4, 5]);
});

test('new species is reported, but not for the very first record', () => {
  const stats = new VisitStats();
  assert.equal(stats.record(card('1', '2026-10-23T07:00:00Z', robin), TZ)[0].isNew, false);
  assert.equal(stats.record(card('2', '2026-10-23T07:10:00Z', tit), TZ)[0].isNew, true);
  assert.equal(stats.record(card('3', '2026-10-23T07:20:00Z', tit), TZ)[0].isNew, false);
});

test('one visit with two species counts both', () => {
  const stats = new VisitStats();
  const results = stats.record(card('1', '2026-10-23T07:00:00Z', robin, tit), TZ);
  assert.equal(results.length, 2);
  assert.equal(stats.total('day', NOW, TZ), 2);
});

test('counts are sorted by visits', () => {
  const stats = new VisitStats();
  stats.record(card('1', '2026-10-23T07:00:00Z', tit), TZ);
  stats.record(card('2', '2026-10-23T07:10:00Z', robin), TZ);
  stats.record(card('3', '2026-10-23T07:20:00Z', robin), TZ);
  assert.deepEqual(stats.counts('day', NOW, TZ).map(row => row.id), ['robin', 'tit']);
});

test('prune removes old days but keeps the species list; 0 keeps everything', () => {
  const stats = new VisitStats();
  stats.record(card('1', '2024-01-05T07:00:00Z', robin), TZ);
  stats.record(card('2', '2026-10-01T07:00:00Z', tit), TZ);
  assert.equal(stats.prune(0, NOW, TZ), 0);
  assert.equal(stats.prune(24, NOW, TZ), 1);
  assert.equal(stats.total('total', NOW, TZ), 1);
  assert.equal(stats.speciesList().length, 2);
});

test('stats survive being saved and loaded again', () => {
  const stats = new VisitStats();
  stats.record(card('1', '2026-10-23T07:00:00Z', robin), TZ);
  const loaded = new VisitStats(JSON.parse(JSON.stringify(stats)));
  assert.equal(loaded.count('robin', 'total', NOW, TZ), 1);
  assert.equal(loaded.record(card('1', '2026-10-23T07:00:00Z', robin), TZ).length, 0);
});

test('daily() gives a zero-filled series, oldest first', () => {
  const stats = new VisitStats();
  stats.record(card('1', '2026-10-23T07:00:00Z', robin), TZ);
  const series = stats.daily(3, NOW, TZ);
  assert.deepEqual(series.map(item => item.count), [0, 0, 1]);
  assert.equal(series[2].day, '2026-10-23');
});

test('localMidnight is correct around the autumn clock change (25-hour day)', () => {
  const start = localMidnight('2026-10-25', TZ);
  const next = localMidnight('2026-10-26', TZ);
  assert.equal(new Date(start).toISOString(), '2026-10-24T22:00:00.000Z'); // CEST, UTC+2
  assert.equal(new Date(next).toISOString(), '2026-10-25T23:00:00.000Z'); // CET, UTC+1
  assert.equal((next - start) / 3600000, 25);
});

test('the backfill plan has no gaps or overlaps from the oldest month up to now', () => {
  const plan = planBackfill(NOW, TZ, 24);
  assert.equal(plan.length, 14 + 24);
  const sorted = [...plan].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) assert.equal(sorted[i].start, sorted[i - 1].end, `gap before ${sorted[i].key}`);
  assert.equal(sorted.at(-1).end, NOW);
  assert.equal(plan[0].key, '2026-10-23'); // today
  assert.equal(plan[13].key, '2026-10-10');
  assert.equal(plan[14].key, '2026-10-01'); // partial month right before the daily part
  assert.equal(plan[15].key, '2026-09-01');
});

test('backfill replaces the numbers, and older visits are then not counted twice', () => {
  const stats = new VisitStats();
  stats.record(card('live', '2026-10-23T05:00:00Z', robin), TZ);
  stats.applyBackfill({ '2026-10-23': { robin: 3 }, '2026-01-01': { robin: 40, tit: 10 } },
    { robin: 'European Robin', tit: 'Great Tit' }, '2026-10-23T09:00:00Z');
  assert.equal(stats.count('robin', 'total', NOW, TZ), 43);
  assert.equal(stats.record(card('x', '2026-10-23T08:59:00Z', robin), TZ).length, 0);
  assert.equal(stats.record(card('y', '2026-10-23T09:01:00Z', robin), TZ).length, 1);
  assert.equal(stats.count('robin', 'day', NOW, TZ), 4);
  assert.equal(stats.count('robin', 'year', NOW, TZ), 44);
});

test('localHour is the hour in the given time zone', () => {
  assert.equal(localHour('2026-10-23T06:30:00Z', TZ), 8); // CEST
  assert.equal(localHour('2026-12-01T06:30:00Z', TZ), 7); // CET
  assert.equal(localHour('2026-10-23T22:30:00Z', TZ), 0);
});

test('the filter hides species from counts, totals, lists and the daily series', () => {
  const stats = new VisitStats();
  const fly = { id: 'fly', name: 'Fly' };
  stats.record(card('1', '2026-10-23T07:00:00Z', robin), TZ);
  stats.record(card('2', '2026-10-23T07:05:00Z', fly), TZ);
  stats.filter = name => name !== 'Fly';
  assert.deepEqual(stats.counts('total', NOW, TZ).map(row => row.id), ['robin']);
  assert.equal(stats.total('day', NOW, TZ), 1);
  assert.deepEqual(stats.speciesList().map(row => row.id), ['robin']);
  assert.equal(stats.daily(1, NOW, TZ)[0].count, 1);
  stats.filter = () => true;
  assert.equal(stats.total('day', NOW, TZ), 2);
});

test('the busiest hour needs enough visits and is stored as an hour of the day', () => {
  const stats = new VisitStats();
  for (let i = 0; i < 9; i += 1) stats.record(card(`m${i}`, '2026-10-20T06:10:00Z', robin), TZ); // 08:xx local
  assert.equal(stats.busiestHour('robin'), null, 'only 9 visits');
  stats.record(card('m9', '2026-10-21T06:20:00Z', robin), TZ);
  stats.record(card('x', '2026-10-21T15:20:00Z', robin), TZ);
  assert.equal(stats.busiestHour('robin'), 8);
  assert.equal(stats.busiestHour('unknown'), null);
});
