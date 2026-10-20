'use strict';

// Unofficial client for the Bird Buddy GraphQL API.
// The API is undocumented: if something breaks, this is the only file to fix.
// Query/field names are based on the community library "pybirdbuddy".

const https = require('https');

// Endpoint taken from the community library pybirdbuddy (BB_URL).
const ENDPOINTS = [
  { host: 'graphql.app-api.prod.aws.mybirdbuddy.com', path: '/graphql' },
];

// Fields verified against pybirdbuddy's POSTCARD_REANALYZE and schema snapshot;
// see docs/birdbuddy-api.md for pinned sources. MediaVideo.contentUrl requires size.
// Identification does not collect or share the postcard.
const POSTCARD_FIELDS = `
  id createdAt inferenceExecutionMode reanalyzeAvailability
  feeder { ... on Feeder { id } }
  medias {
    __typename thumbnailUrl
    ... on MediaImage { contentUrl(size: ORIGINAL) }
    ... on MediaVideo { contentUrl(size: ORIGINAL) }
  }
  sightingReportPreview { sightings {
    __typename
    ... on SightingRecognizedBird { species { ... on Species { id name } } }
    ... on SightingRecognizedBirdUnlocked { species { ... on Species { id name } } }
  } }`;

function postcard(node) {
  if (!node || node.__typename !== 'FeedItemNewPostcard') return null;
  const media = (node.medias || []).find(m => m.__typename === 'MediaImage');
  const video = (node.medias || []).find(m => m.__typename === 'MediaVideo');
  const sightings = (node.sightingReportPreview && node.sightingReportPreview.sightings) || [];
  const species = new Map();
  for (const sighting of sightings) {
    if (['SightingRecognizedBird', 'SightingRecognizedBirdUnlocked'].includes(sighting.__typename)
      && sighting.species && sighting.species.id && sighting.species.name) {
      species.set(sighting.species.id, sighting.species);
    }
  }
  return {
    id: node.id,
    createdAt: node.createdAt,
    feederId: node.feeder && node.feeder.id,
    imageUrl: media && (media.contentUrl || media.thumbnailUrl),
    videoUrl: video && video.contentUrl,
    inferenceExecutionMode: node.inferenceExecutionMode,
    reanalyzeAvailability: node.reanalyzeAvailability,
    species: [...species.values()],
  };
}

function checkResponse({ status, json, retryAfter }, message) {
  if (status >= 200 && status < 300 && json && !json.errors?.length && json.data) return;
  const error = new Error(`${message}: ${firstError(json) || `HTTP ${status}`}`);
  error.code = (json && json.errors && json.errors[0]?.extensions?.code) || `HTTP_${status}`;
  error.status = status;
  if (retryAfter) {
    error.retryAfterMs = /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
  }
  throw error;
}

function postTo({ host, path }, body, token, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; HomeyBirdBuddy/0.1)',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = https.request({ host, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data), retryAfter: res.headers['retry-after'] });
        } catch (err) {
          const snippet = data.replace(/\s+/g, ' ').slice(0, 200);
          reject(new Error(`Invalid response from ${host}${path} (HTTP ${res.statusCode}): ${snippet}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Bird Buddy request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let workingEndpoint = null;

async function post(body, token, timeoutMs) {
  if (workingEndpoint) return postTo(workingEndpoint, body, token, timeoutMs);

  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const result = await postTo(endpoint, body, token, timeoutMs);
      workingEndpoint = endpoint;
      console.log(`Bird Buddy endpoint in use: ${endpoint.host}${endpoint.path}`);
      return result;
    } catch (err) {
      console.log(`Bird Buddy endpoint ${endpoint.host}${endpoint.path} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError;
}


// Downloads a (time-limited) media URL into a Buffer. Follows one redirect.
function download(url, redirects = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(res.headers.location, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Image download failed (HTTP ${res.statusCode})`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Image download timed out')));
    req.on('error', reject);
  });
}

function firstError(json) {
  return json && json.errors && json.errors[0] && json.errors[0].message;
}

// True when the server says our access token is missing, invalid or expired.
function isAuthFailure({ status, json }) {
  if (status === 401) return true;
  return Boolean(json && json.errors && json.errors.some(e => (
    (e.extensions && e.extensions.code === 'UNAUTHENTICATED')
    || /unauthenticated|unauthori[sz]ed|token|jwt|expired/i.test(e.message || '')
  )));
}

// Signs in with email + password. Returns { accessToken, refreshToken|null }.
// The password is only used here and (as a fallback) for re-login; see device.js.
async function signIn(email, password) {
  const build = fields => `mutation {
    authEmailSignIn(emailSignInInput: {email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)}}) {
      __typename
      ... on Auth { ${fields} }
    }
  }`;

  let { status, json } = await post({ query: build('accessToken refreshToken') });
  const apiError = firstError(json);
  if (apiError && /refreshToken/.test(apiError)) {
    // The server has no refreshToken field: fall back to the access token only.
    ({ status, json } = await post({ query: build('accessToken') }));
  }

  const result = json && json.data && json.data.authEmailSignIn;
  if (!result || !result.accessToken) {
    // Log what the server said (never the password) to help debugging.
    console.log(`Bird Buddy login failed (HTTP ${status}): ${JSON.stringify(json).slice(0, 500)}`);
    // A GraphQL error means our request is wrong, not the credentials.
    if (firstError(json)) throw new Error(`Bird Buddy API error: ${firstError(json)}`);
    const err = new Error(`Login failed${result && result.__typename ? ` (${result.__typename})` : ''}`);
    err.code = 'AUTH';
    throw err;
  }
  return { accessToken: result.accessToken, refreshToken: result.refreshToken || null };
}

class BirdBuddyClient {
  // Normally holds only tokens. email/password are only present on devices that
  // could not switch to tokens (fallback) and are used for re-login then.
  constructor({ accessToken, refreshToken, email, password, onTokens } = {}) {
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    this.email = email || null;
    this.password = password || null;
    this.onTokens = onTokens || null; // called whenever new tokens must be saved
  }

  static signIn(email, password) {
    return signIn(email, password);
  }

  forgetPassword() {
    this.email = null;
    this.password = null;
  }

  async setTokens({ accessToken, refreshToken }) {
    this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken; // refresh tokens may rotate
    if (this.onTokens) {
      await this.onTokens({ accessToken: this.accessToken, refreshToken: this.refreshToken });
    }
  }

  async refreshTokens() {
    if (!this.refreshToken) throw new Error('No refresh token available');
    const query = `mutation {
      authRefreshToken(refreshTokenInput: {token: ${JSON.stringify(this.refreshToken)}}) {
        __typename
        ... on Auth { accessToken refreshToken }
      }
    }`;
    const { status, json } = await post({ query });
    const result = json && json.data && json.data.authRefreshToken;
    if (!result || !result.accessToken) {
      console.log(`Bird Buddy token refresh failed (HTTP ${status}): ${JSON.stringify(json).slice(0, 300)}`);
      throw new Error(`Bird Buddy token refresh failed${firstError(json) ? `: ${firstError(json)}` : ''}`);
    }
    await this.setTokens(result);
  }

  // Checks that refreshing works, so the password can safely be dropped.
  async verifyRefresh() {
    if (!this.refreshToken) return false;
    try {
      await this.refreshTokens();
      return true;
    } catch (err) {
      return false;
    }
  }

  // Gets a new access token: refresh token first, password (if still stored) as fallback.
  async reauth() {
    if (this.refreshToken) {
      try {
        await this.refreshTokens();
        return;
      } catch (err) {
        if (!(this.email && this.password)) {
          err.code = 'AUTH';
          throw err;
        }
      }
    }
    if (this.email && this.password) {
      await this.setTokens(await signIn(this.email, this.password));
      return;
    }
    const err = new Error('Login expired: open the device and choose Repair to log in again');
    err.code = 'AUTH';
    throw err;
  }

  async ensureSession() {
    if (!this.accessToken) await this.reauth();
  }

  // Runs a GraphQL query; renews the session once if the token was rejected.
  async request(query, variables = {}, timeoutMs) {
    await this.ensureSession();
    let result = await post({ query, variables }, this.accessToken, timeoutMs);
    if (isAuthFailure(result)) {
      await this.reauth();
      result = await post({ query, variables }, this.accessToken, timeoutMs);
    }
    return result;
  }

  async getFeeders() {
    const query = `{ me { feeders {
      __typename
      ... on Node { id }
      ... on Feeder { name }
      ... on FeederForPrivate { battery { percentage } }
    } } }`;
    const { json } = await this.request(query);
    const feeders = json && json.data && json.data.me && json.data.me.feeders;
    if (!feeders) {
      const detail = firstError(json);
      throw new Error(`Could not read feeders from Bird Buddy${detail ? `: ${detail}` : ''}`);
    }
    return feeders;
  }

  // Read every new postcard since the previous poll, including unrecognized and
  // video-only visits. The account feed contains ALL feeders, so filter by ID.
  // Initial setup stops at the first page for this feeder, without analyzing history.
  async getPostcards({ feederId, since = null } = {}) {
    const cards = [];
    const cursors = new Set();
    let after = null;
    do {
      const result = await this.request(`query HomeyPostcards($after: String) {
        me { feed(first: 50, after: $after) {
          edges { cursor node { __typename ... on FeedItem {
            id createdAt
          } ... on FeedItemNewPostcard { ${POSTCARD_FIELDS} } } }
          pageInfo { hasNextPage endCursor }
        } }
      }`, { after });
      checkResponse(result, 'Could not read postcards');
      const feed = result.json.data.me && result.json.data.me.feed;
      if (!feed || !Array.isArray(feed.edges)) throw new Error('Missing Bird Buddy feed');
      const nodes = feed.edges.map(edge => edge && edge.node).filter(Boolean);
      for (const node of nodes) {
        const card = postcard(node);
        if (card && (!feederId || card.feederId === feederId)
          && (!since || Date.parse(card.createdAt) >= Date.parse(since))) cards.push(card);
      }
      const reachedCursor = since && nodes.some(n => Date.parse(n.createdAt) < Date.parse(since));
      if ((!since && cards.length) || reachedCursor || !feed.pageInfo?.hasNextPage) break;
      after = feed.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error('Bird Buddy feed pagination did not advance');
      cursors.add(after);
    } while (after);
    return [...new Map(cards.map(card => [card.id, card])).values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async getPostcard(feedItemId) {
    const result = await this.request(`query HomeyPostcard($feedItemId: ID!) {
      feedItem(feedItemId: $feedItemId) {
        __typename ... on FeedItemNewPostcard { ${POSTCARD_FIELDS} }
      }
    }`, { feedItemId });
    checkResponse(result, 'Could not read postcard');
    return postcard(result.json.data.feedItem);
  }

  // Same request as the free account's "Identify this visitor" button.
  async identifyPostcard(feedItemId) {
    const result = await this.request(`mutation HomeyIdentifyPostcard($feedItemId: ID!) {
      inferenceExternalPostcardReanalyze(feedItemId: $feedItemId) {
        updatedFeedItem { __typename ${POSTCARD_FIELDS} }
      }
    }`, { feedItemId }, 60000);
    checkResponse(result, 'Could not identify visitor');
    const card = postcard(result.json.data.inferenceExternalPostcardReanalyze?.updatedFeedItem);
    if (!card || card.id !== feedItemId) throw new Error('Missing identified Bird Buddy postcard');
    return card;
  }

  async getLatestPostcard(feederId) {
    const cards = await this.getPostcards({ feederId });
    return cards.find(card => card.imageUrl) || null;
  }

  // Signed video URLs are refreshed immediately before playback.
  async getLatestVideo(feederId) {
    const cards = await this.getPostcards({ feederId });
    const card = cards[0];
    return card && card.videoUrl ? { id: card.id, url: card.videoUrl } : null;
  }

  download(url) {
    return download(url);
  }
}

module.exports = BirdBuddyClient;
