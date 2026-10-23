'use strict';

// Visit counter. Pure logic (no Homey, no network) so it can be unit tested.
// Stored shape (small, JSON-safe):
//   days:    { 'YYYY-MM-DD': { <speciesId>: count } }   per local day
//   species: { <speciesId>: name }                      every species ever seen
//   ids:     [postcardId]                               recent ids, so a visit is never counted twice
const MAX_IDS = 500;
const PERIODS = ['day', 'week', 'month', 'year', 'total'];

// Hour of the day (0-23) in the given IANA time zone.
function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' })
    .formatToParts(new Date(date));
  return Number(parts.find(part => part.type === 'hour').value);
}

// 'YYYY-MM-DD' in the given IANA time zone (the Homey's own zone).
function dayKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(date));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Offset (ms) between a time zone and UTC at a given moment.
function zoneOffset(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = type => Number(parts.find(part => part.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// The moment (ms) a local day starts in the given time zone.
function localMidnight(key, timeZone) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}

// Which periods to ask Bird Buddy for when filling the history:
// one request per day for the last `dailyDays` days, then one per month.
// The key is the first day of the period, so it fits the per-day storage.
function planBackfill(now, timeZone, months, dailyDays = 14) {
  const today = dayKey(now, timeZone);
  const plan = [];
  for (let i = 0; i < dailyDays; i += 1) {
    const key = addDays(today, -i);
    plan.push({ key, start: localMidnight(key, timeZone), end: i === 0 ? now : localMidnight(addDays(key, 1), timeZone) });
  }
  let endKey = addDays(today, -(dailyDays - 1)); // exclusive end of the monthly part
  for (let i = 0; i < months; i += 1) {
    const monthStart = `${addDays(endKey, -1).slice(0, 7)}-01`;
    plan.push({ key: monthStart, start: localMidnight(monthStart, timeZone), end: localMidnight(endKey, timeZone) });
    endKey = monthStart;
  }
  return plan;
}

// Monday of the week that contains the given day key.
function weekStart(key) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function periodStart(period, todayKey) {
  if (period === 'day') return todayKey;
  if (period === 'week') return weekStart(todayKey);
  if (period === 'month') return `${todayKey.slice(0, 7)}-01`;
  if (period === 'year') return `${todayKey.slice(0, 4)}-01-01`;
  return '0000-00-00';
}

class VisitStats {
  constructor(data) {
    this.data = { days: {}, species: {}, ids: [], hours: {}, ...(data || {}) };
    // Decides which species are shown and counted; set by the device (for example to hide flies).
    this.filter = () => true;
  }

  visible(id) {
    return this.filter(this.data.species[id] || id);
  }

  hasHistory() {
    return Object.keys(this.data.species).length > 0;
  }

  // Counts one visit for every identified species on the card.
  // Returns [] when the card was already counted or has no species.
  record(card, timeZone) {
    if (!card || !card.id || !(card.species || []).length) return [];
    if (this.data.ids.includes(card.id)) return [];
    const time = Date.parse(card.createdAt);
    // Visits before the history was filled in are already part of Bird Buddy's numbers.
    if (this.data.backfilledUntil && time <= Date.parse(this.data.backfilledUntil)) return [];
    const day = dayKey(Number.isFinite(time) ? time : Date.now(), timeZone);

    const wasKnown = this.hasHistory();
    const hour = localHour(Number.isFinite(time) ? time : Date.now(), timeZone);
    const results = [];
    for (const species of card.species) {
      const slots = this.data.hours[species.id] || (this.data.hours[species.id] = new Array(24).fill(0));
      slots[hour] += 1;
      const isNew = !(species.id in this.data.species);
      this.data.species[species.id] = species.name;
      const bucket = this.data.days[day] || (this.data.days[day] = {});
      bucket[species.id] = (bucket[species.id] || 0) + 1;
      results.push({ id: species.id, name: species.name, isNew: isNew && wasKnown });
    }
    this.data.ids.push(card.id);
    if (this.data.ids.length > MAX_IDS) this.data.ids = this.data.ids.slice(-MAX_IDS);
    return results;
  }

  // Replaces the days with Bird Buddy's own numbers: buckets = { key: { speciesId: count } }.
  applyBackfill(buckets, names, until) {
    this.data.days = buckets;
    Object.assign(this.data.species, names);
    this.data.backfilledUntil = new Date(until).toISOString();
  }

  // Visits per species in a period, most frequent first.
  counts(period, now, timeZone) {
    const start = periodStart(period, dayKey(now, timeZone));
    const totals = {};
    for (const [day, bucket] of Object.entries(this.data.days)) {
      if (day < start) continue;
      for (const [id, count] of Object.entries(bucket)) totals[id] = (totals[id] || 0) + count;
    }
    return Object.entries(totals)
      .filter(([id]) => this.visible(id))
      .map(([id, count]) => ({ id, name: this.data.species[id] || id, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  count(speciesId, period, now, timeZone) {
    const row = this.counts(period, now, timeZone).find(item => item.id === speciesId);
    return row ? row.count : 0;
  }

  total(period, now, timeZone) {
    return this.counts(period, now, timeZone).reduce((sum, item) => sum + item.count, 0);
  }

  // Number of visits per day for the last `days` days (oldest first), for a chart.
  daily(days, now, timeZone) {
    const out = [];
    const end = new Date(`${dayKey(now, timeZone)}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(end);
      date.setUTCDate(end.getUTCDate() - i);
      const key = date.toISOString().slice(0, 10);
      const bucket = this.data.days[key] || {};
      out.push({
        day: key,
        count: Object.entries(bucket).filter(([id]) => this.visible(id)).reduce((sum, [, n]) => sum + n, 0),
      });
    }
    return out;
  }

  // Species names for flow card pickers, most visited first.
  speciesList() {
    const totals = {};
    for (const bucket of Object.values(this.data.days)) {
      for (const [id, count] of Object.entries(bucket)) totals[id] = (totals[id] || 0) + count;
    }
    return Object.entries(this.data.species)
      .filter(([id]) => this.visible(id))
      .map(([id, name]) => ({ id, name, count: totals[id] || 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // Hour of the day a species usually comes, from the visits counted by this app.
  // Needs enough visits to mean something; Bird Buddy's own history has no hours.
  busiestHour(speciesId, minVisits = 10) {
    const slots = this.data.hours[speciesId];
    if (!slots) return null;
    const total = slots.reduce((a, b) => a + b, 0);
    if (total < minVisits) return null;
    return slots.indexOf(Math.max(...slots));
  }

  // Drops days older than the retention period (counted in whole months). 0 months = keep everything.
  prune(months, now, timeZone) {
    const keepMonths = Number(months);
    if (!Number.isFinite(keepMonths) || keepMonths <= 0) return 0;
    const cutoff = new Date(`${dayKey(now, timeZone)}T00:00:00Z`);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - keepMonths);
    // Whole months are kept or removed, so a month that is only partly inside the period
    // stays complete (history from Bird Buddy is stored per month beyond 35 days).
    const limit = cutoff.toISOString().slice(0, 7);
    let removed = 0;
    for (const day of Object.keys(this.data.days)) {
      if (day.slice(0, 7) < limit) { delete this.data.days[day]; removed += 1; }
    }
    return removed;
  }

  toJSON() { return this.data; }
}

module.exports = { VisitStats, dayKey, weekStart, planBackfill, localMidnight, localHour, PERIODS };
