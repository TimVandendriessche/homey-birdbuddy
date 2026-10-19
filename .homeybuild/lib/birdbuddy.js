'use strict';

// Unofficial client for the Bird Buddy GraphQL API.
// The API is undocumented: if something breaks, this is the only file to fix.
// Query/field names are based on the community library "pybirdbuddy".

const https = require('https');

// Endpoint taken from the community library pybirdbuddy (BB_URL).
const ENDPOINTS = [
  { host: 'graphql.app-api.prod.aws.mybirdbuddy.com', path: '/graphql' },
];

function postTo({ host, path }, body, token) {
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
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (err) {
          const snippet = data.replace(/\s+/g, ' ').slice(0, 200);
          reject(new Error(`Invalid response from ${host}${path} (HTTP ${res.statusCode}): ${snippet}`));
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Bird Buddy request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let workingEndpoint = null;

async function post(body, token) {
  if (workingEndpoint) return postTo(workingEndpoint, body, token);

  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const result = await postTo(endpoint, body, token);
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
  async request(query) {
    await this.ensureSession();
    let result = await post({ query }, this.accessToken);
    if (isAuthFailure(result)) {
      await this.reauth();
      result = await post({ query }, this.accessToken);
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

  // Returns { id, createdAt, imageUrl } for the newest postcard with a photo, or null.
  async getLatestPostcard() {
    // contentUrl needs a "size" argument; the allowed values are not documented,
    // so try the likely ones and remember the first that the server accepts.
    const sizes = this.imageSize ? [this.imageSize] : ['ORIGINAL', 'LARGE', 'MEDIUM', 'SMALL'];
    const errors = [];
    let edges = null;

    for (const size of sizes) {
      const query = `{ me { feed(first: 10) { edges { node {
        __typename
        ... on FeedItemNewPostcard {
          id
          createdAt
          medias { __typename ... on MediaImage { thumbnailUrl contentUrl(size: ${size}) } }
        }
      } } } } }`;
      const { json } = await this.request(query);
      edges = json && json.data && json.data.me && json.data.me.feed && json.data.me.feed.edges;
      if (edges) {
        this.imageSize = size;
        break;
      }
      const message = json && json.errors && json.errors[0] && json.errors[0].message;
      errors.push(`${size}: ${message || 'no data'}`);
      // Only keep trying other sizes if the problem is the size value itself.
      if (!message || !/MediaImageSize|enum/i.test(message)) break;
    }
    if (!edges) throw new Error(`Could not read feed from Bird Buddy: ${errors.join(' | ')}`);

    const cards = edges
      .map(e => e && e.node)
      .filter(n => n && n.__typename === 'FeedItemNewPostcard')
      .map(n => {
        const media = (n.medias || []).find(m => m && (m.contentUrl || m.thumbnailUrl));
        return media ? { id: n.id, createdAt: n.createdAt, imageUrl: media.contentUrl || media.thumbnailUrl } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return cards[0] || null;
  }

  // Returns { id, url } for the video of the newest postcard, or null when it has none.
  // Video URLs are time-limited, so ask again right before playing.
  async getLatestVideo() {
    // The exact video field is undocumented: try with and without a "size" argument.
    const selections = this.videoSelection
      ? [this.videoSelection]
      : ['contentUrl', 'contentUrl(size: ORIGINAL)', 'contentUrl(size: LARGE)', 'contentUrl(size: MEDIUM)'];
    const errors = [];
    let edges = null;

    for (const selection of selections) {
      const query = `{ me { feed(first: 10) { edges { node {
        __typename
        ... on FeedItemNewPostcard {
          id
          createdAt
          medias { __typename ... on MediaVideo { ${selection} } }
        }
      } } } } }`;
      const { json } = await this.request(query);
      edges = json && json.data && json.data.me && json.data.me.feed && json.data.me.feed.edges;
      if (edges) {
        this.videoSelection = selection;
        break;
      }
      const message = json && json.errors && json.errors[0] && json.errors[0].message;
      errors.push(`${selection}: ${message || 'no data'}`);
      if (!message || !/contentUrl|argument|size|enum/i.test(message)) break;
    }
    if (!edges) throw new Error(`Could not read video from Bird Buddy: ${errors.join(' | ')}`);

    const newest = edges
      .map(e => e && e.node)
      .filter(n => n && n.__typename === 'FeedItemNewPostcard')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!newest) return null;
    const video = (newest.medias || []).find(m => m && m.__typename === 'MediaVideo' && m.contentUrl);
    return video ? { id: newest.id, url: video.contentUrl } : null;
  }

  download(url) {
    return download(url);
  }
}

module.exports = BirdBuddyClient;
