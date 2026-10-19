'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { parse } = require('graphql');
const BirdBuddyClient = require('../lib/birdbuddy');

function node(id, feederId = 'feeder-1', extra = {}) {
  return {
    __typename: 'FeedItemNewPostcard', id, feeder: { id: feederId },
    createdAt: '2026-10-19T12:00:00Z', inferenceExecutionMode: 'MANUAL_NOT_STARTED',
    reanalyzeAvailability: 'AVAILABLE',
    medias: [{ __typename: 'MediaImage', contentUrl: `https://example.invalid/${id}.jpg` }],
    ...extra,
  };
}

function feed(nodes, hasNextPage = false, endCursor = null) {
  return { status: 200, json: { data: { me: { feed: {
    edges: nodes.map(value => ({ node: value })), pageInfo: { hasNextPage, endCursor },
  } } } } };
}

test('finds all postcards for this feeder across pages, including video-only visits', async () => {
  const client = new BirdBuddyClient();
  const pages = [
    feed([node('other', 'feeder-2')], true, 'page-2'),
    feed([node('first', 'feeder-1', {
      medias: [{ __typename: 'MediaVideo', contentUrl: 'https://example.invalid/video.mp4' }],
    })], true, 'page-3'),
    feed([node('second', 'feeder-1', { createdAt: '2026-10-19T11:59:00Z' }),
      node('old', 'feeder-1', { createdAt: '2026-10-18T12:00:00Z' })]),
  ];
  const cursors = [];
  client.request = async (query, variables) => {
    parse(query);
    cursors.push(variables.after);
    return pages.shift();
  };
  const cards = await client.getPostcards({ feederId: 'feeder-1', since: '2026-10-19T11:00:00Z' });
  assert.deepEqual(cards.map(card => card.id), ['first', 'second']);
  assert.equal(cards[0].imageUrl, undefined);
  assert.equal(cards[0].videoUrl, 'https://example.invalid/video.mp4');
  assert.deepEqual(cursors, [null, 'page-2', 'page-3']);
});

test('initial lookup can pass another feeder’s page, then stops without scanning history', async () => {
  const client = new BirdBuddyClient();
  const pages = [feed([node('other', 'feeder-2')], true, 'next'), feed([node('mine')], true, 'older')];
  client.request = async () => pages.shift();
  assert.equal((await client.getLatestPostcard('feeder-1')).id, 'mine');
  assert.equal(pages.length, 0);
});

test('identification uses variables, accepts unlocked birds, and deduplicates species', async () => {
  const client = new BirdBuddyClient();
  const species = { id: 'robin', name: 'European Robin' };
  client.request = async (query, variables, timeoutMs) => {
    const document = parse(query);
    assert.equal(document.definitions[0].operation, 'mutation');
    assert.match(query, /inferenceExternalPostcardReanalyze/);
    assert.doesNotMatch(query, /postcardCollect/);
    assert.deepEqual(variables, { feedItemId: 'postcard"1' });
    assert.equal(timeoutMs, 60000);
    return { status: 200, json: { data: { inferenceExternalPostcardReanalyze: {
      updatedFeedItem: node('postcard"1', 'feeder-1', {
        inferenceExecutionMode: 'MANUAL_COMPLETED',
        sightingReportPreview: { sightings: [
          { __typename: 'SightingRecognizedBirdUnlocked', species },
          { __typename: 'SightingRecognizedBird', species },
          { __typename: 'SightingRecognizedMysteryVisitor' },
        ] },
      }),
    } } } };
  };
  const result = await client.identifyPostcard('postcard"1');
  assert.deepEqual(result.species, [species]);
  assert.equal(result.inferenceExecutionMode, 'MANUAL_COMPLETED');
});

test('HTTP-200 GraphQL denials and rate limits are not treated as successful identification', async () => {
  const client = new BirdBuddyClient();
  client.request = async () => ({ status: 200, json: {
    errors: [{ message: 'Unavailable for this postcard', extensions: { code: 'FORBIDDEN' } }],
    data: { inferenceExternalPostcardReanalyze: null },
  } });
  await assert.rejects(client.identifyPostcard('1'), { code: 'FORBIDDEN' });
  client.request = async () => ({ status: 429, json: { errors: [{ message: 'Slow down' }] }, retryAfter: '120' });
  await assert.rejects(client.identifyPostcard('1'), error => error.status === 429 && error.retryAfterMs === 120000);
});

test('refreshing an expired token preserves the mutation variables and stores rotated tokens', async t => {
  const calls = [];
  const replies = [
    { status: 401, json: { errors: [{ message: 'Expired' }] } },
    { status: 200, json: { data: { authRefreshToken: { accessToken: 'new', refreshToken: 'rotated' } } } },
    { status: 200, json: { data: { ok: true } } },
  ];
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = body => calls.push({ body: JSON.parse(body), headers: options.headers });
    req.end = () => queueMicrotask(() => {
      const reply = replies.shift();
      const res = new EventEmitter();
      res.statusCode = reply.status;
      res.headers = {};
      callback(res);
      res.emit('data', JSON.stringify(reply.json));
      res.emit('end');
    });
    return req;
  });
  let tokens;
  const client = new BirdBuddyClient({ accessToken: 'old', refreshToken: 'refresh', onTokens: value => { tokens = value; } });
  await client.request('mutation ($id: ID!) { example(id: $id) }', { id: 'postcard' });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body.variables, { id: 'postcard' });
  assert.deepEqual(calls[2].body.variables, { id: 'postcard' });
  assert.equal(calls[2].headers.Authorization, 'Bearer new');
  assert.deepEqual(tokens, { accessToken: 'new', refreshToken: 'rotated' });
});
