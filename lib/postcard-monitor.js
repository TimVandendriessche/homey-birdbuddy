'use strict';

const MAX_ATTEMPTS = 5;
const MAX_JOBS_PER_POLL = 5;
const RETRY_MINUTE = 60 * 1000;

// The inbox cursor and pending jobs are saved BEFORE inference. A failed request
// can then be retried after a restart without identifying the same visit twice.
class PostcardMonitor {
  constructor({ client, feederId, state, saveState, onCards, onAnalysis, onIdentified, onError,
    now = Date.now }) {
    this.client = client;
    this.feederId = feederId;
    this.state = { since: null, seenIds: [], jobs: [], nextRequestAt: 0, ...state };
    this.saveState = saveState;
    this.onCards = onCards;
    this.onAnalysis = onAnalysis;
    this.onIdentified = onIdentified;
    this.onError = onError;
    this.now = now;
  }

  // Queues the newest recent visit that can still be identified (or already has a species),
  // without a Flow notification. Used when automatic identification is switched on, so the
  // device shows a bird right away instead of waiting for the next visitor.
  async queueLatest() {
    const recent = (await this.client.getPostcards({ feederId: this.feederId }))
      .filter(card => card.feederId === this.feederId && Number.isFinite(Date.parse(card.createdAt)))
      .slice(0, 10);
    const card = recent.find(item => item.species.length || item.inferenceExecutionMode === 'MANUAL_NOT_STARTED');
    if (!card || this.state.jobs.some(job => job.id === card.id)) return false;
    this.state.jobs.push({
      id: card.id, notify: false, manual: card.inferenceExecutionMode === 'MANUAL_NOT_STARTED',
      attempts: 0, nextAttemptAt: 0,
    });
    await this.saveState(this.state);
    return true;
  }

  async poll(autoIdentify) {
    const cards = (await this.client.getPostcards({ feederId: this.feederId, since: this.state.since }))
      .filter(card => card.feederId === this.feederId && Number.isFinite(Date.parse(card.createdAt)));
    const initial = !this.state.since;
    const previousTime = Date.parse(this.state.since);
    const fresh = initial ? cards.slice(0, 1) : cards.filter(card => (
      Date.parse(card.createdAt) > previousTime
      || (Date.parse(card.createdAt) === previousTime && !this.state.seenIds.includes(card.id))
    ));
    for (const card of [...fresh].reverse()) {
      const manual = card.inferenceExecutionMode === 'MANUAL_NOT_STARTED';
      if ((card.species.length || (manual && autoIdentify))
        && !this.state.jobs.some(job => job.id === card.id)) {
        this.state.jobs.push({ id: card.id, notify: !initial, manual, attempts: 0, nextAttemptAt: 0 });
      }
    }
    const latest = cards[0];
    if (latest && (!this.state.since || Date.parse(latest.createdAt) >= previousTime)) {
      const sameTime = latest.createdAt === this.state.since;
      this.state.seenIds = [...new Set([
        ...(sameTime ? this.state.seenIds : []),
        ...cards.filter(card => card.createdAt === latest.createdAt).map(card => card.id),
      ])];
      this.state.since = latest.createdAt;
    } else if (initial) {
      this.state.since = new Date(this.now()).toISOString();
    }
    await this.saveState(this.state);

    // Photo failures must not prevent identification, or vice versa.
    try { await this.onCards(cards); } catch (err) { this.onError(err); }
    let processed = 0;
    const byId = new Map(cards.map(card => [card.id, card]));
    for (const job of [...this.state.jobs]) {
      if (processed >= MAX_JOBS_PER_POLL || this.now() < this.state.nextRequestAt) break;
      if (this.now() < job.nextAttemptAt || (job.manual && !autoIdentify)) continue;
      processed += 1;
      try {
        let card = byId.get(job.id) || await this.client.getPostcard(job.id);
        // A postcard may have expired or been collected in the mobile app.
        if (card && card.feederId !== this.feederId) throw new Error('Postcard belongs to another feeder');
        if (card && card.inferenceExecutionMode === 'MANUAL_NOT_STARTED') {
          if (!autoIdentify) continue;
          if (!job.submitted) {
            card = await this.client.identifyPostcard(job.id);
            job.submitted = true;
            await this.saveState(this.state);
          }
          if (card.inferenceExecutionMode === 'MANUAL_NOT_STARTED') {
            throw new Error('Bird Buddy identification is still processing');
          }
        }
        if (card) {
          await this.onAnalysis(card);
          if (job.notify && card.species.length) await this.onIdentified(card);
        }
        this.state.jobs = this.state.jobs.filter(pending => pending.id !== job.id);
      } catch (err) {
        job.attempts += 1;
        const delay = Math.max(RETRY_MINUTE * (2 ** (job.attempts - 1)), err.retryAfterMs || 0);
        job.nextAttemptAt = this.now() + delay;
        const limited = err.status === 429 || /RATE_LIMIT|TOO_MANY_REQUESTS/i.test(err.code || '');
        if (limited) this.state.nextRequestAt = job.nextAttemptAt;
        const denied = [400, 403, 404].includes(err.status)
          || /^(FORBIDDEN|NOT_FOUND|BAD_USER_INPUT|UNAVAILABLE)$/.test(err.code || '');
        if (denied || job.attempts >= MAX_ATTEMPTS) {
          this.state.jobs = this.state.jobs.filter(pending => pending.id !== job.id);
        }
        this.onError(new Error(`Identify postcard ${job.id}: ${err.message}`));
      }
      await this.saveState(this.state);
    }
  }
}

module.exports = PostcardMonitor;
