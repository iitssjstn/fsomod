// Twitch API: OAuth, Helix (channel points) en EventSub (webhooks).
const db = require('./db');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EVENTSUB_SECRET = process.env.EVENTSUB_SECRET;

const SCOPES = ['bits:read', 'channel:read:redemptions', 'channel:manage:redemptions'];
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    force_verify: 'true',
  });
  return `https://id.twitch.tv/oauth2/authorize?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const exchangeCode = code => tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI });

// --- App access token (voor EventSub-webhooks) ---
let appToken = null;
async function getAppToken() {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.token;
  const data = await tokenRequest({ grant_type: 'client_credentials' });
  appToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return appToken.token;
}

// --- User token met automatische refresh ---
async function refreshUser(user) {
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: user.refreshToken });
  return db.upsertUser(user.id, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenExpiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
}

async function helix(method, path, { user, body, query } = {}) {
  const url = `https://api.twitch.tv/helix${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  const doFetch = async token => fetch(url, {
    method,
    headers: {
      'Client-Id': CLIENT_ID,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let token = user ? user.accessToken : await getAppToken();
  if (user && user.tokenExpiresAt && user.tokenExpiresAt < Date.now() + 60_000) {
    user = await refreshUser(user); token = user.accessToken;
  }
  let res = await doFetch(token);
  if (res.status === 401 && user) {
    user = await refreshUser(user);
    res = await doFetch(user.accessToken);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`Helix ${method} ${path} → ${res.status}: ${data?.message || text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function getUserInfo(accessToken) {
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error('users error: ' + JSON.stringify(data));
  return data.data[0];
}

// --- EventSub ---
const EVENT_TYPES = [
  { type: 'channel.cheer', version: '1' },
  { type: 'channel.channel_points_custom_reward_redemption.add', version: '1' },
];

async function subscribeEvents(broadcasterId) {
  const results = [];
  for (const ev of EVENT_TYPES) {
    try {
      await helix('POST', '/eventsub/subscriptions', {
        body: {
          type: ev.type,
          version: ev.version,
          condition: { broadcaster_user_id: broadcasterId },
          transport: { method: 'webhook', callback: `${BASE_URL}/eventsub`, secret: EVENTSUB_SECRET },
        },
      });
      results.push({ type: ev.type, ok: true });
    } catch (e) {
      // 409 = bestaat al: prima
      results.push({ type: ev.type, ok: e.status === 409, error: e.status === 409 ? null : e.message });
    }
  }
  return results;
}

async function listSubscriptions(broadcasterId) {
  const out = [];
  let cursor;
  do {
    const data = await helix('GET', '/eventsub/subscriptions', { query: cursor ? { after: cursor } : {} });
    out.push(...data.data.filter(s => s.condition?.broadcaster_user_id === broadcasterId));
    cursor = data.pagination?.cursor;
  } while (cursor);
  return out;
}

async function unsubscribeAll(broadcasterId) {
  for (const s of await listSubscriptions(broadcasterId)) {
    await helix('DELETE', '/eventsub/subscriptions', { query: { id: s.id } }).catch(() => {});
  }
}

// --- Channel points rewards ---
const createReward = (user, body) =>
  helix('POST', '/channel_points/custom_rewards', { user, query: { broadcaster_id: user.id }, body }).then(d => d.data[0]);

const updateReward = (user, rewardId, body) =>
  helix('PATCH', '/channel_points/custom_rewards', { user, query: { broadcaster_id: user.id, id: rewardId }, body }).then(d => d.data[0]);

const deleteReward = (user, rewardId) =>
  helix('DELETE', '/channel_points/custom_rewards', { user, query: { broadcaster_id: user.id, id: rewardId } });

const setRedemptionStatus = (user, rewardId, redemptionId, status) =>
  helix('PATCH', '/channel_points/custom_rewards/redemptions', {
    user,
    query: { broadcaster_id: user.id, reward_id: rewardId, id: redemptionId },
    body: { status }, // 'FULFILLED' of 'CANCELED' (= punten terug)
  });

module.exports = {
  BASE_URL, EVENTSUB_SECRET, authorizeUrl, exchangeCode, getUserInfo,
  subscribeEvents, listSubscriptions, unsubscribeAll,
  createReward, updateReward, deleteReward, setRedemptionStatus,
};
