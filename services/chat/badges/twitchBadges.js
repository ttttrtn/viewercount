// Real Twitch chat badge resolution.
//
// Twitch IRC's `badges` tag on PRIVMSG only gives you `set_id/version` pairs
// (e.g. "moderator/1,subscriber/12") - it does NOT include badge titles or
// image URLs. To turn those into real assets, Twitch's official Helix API
// provides two endpoints (https://dev.twitch.tv/docs/api/reference/):
//
//   GET /helix/chat/badges/global               - badges usable in any channel
//   GET /helix/chat/badges?broadcaster_id=<id>  - this channel's custom
//                                                  badges (subscriber tiers,
//                                                  bits, etc.)
//
// Both require an app access token, which is the same client-credentials
// flow already used in services/twitch.js for viewer counts. We keep a
// separate tiny token helper here rather than importing that module, so this
// stays a self-contained, drop-in badge module.

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_USERNAME = (process.env.TWITCH_USERNAME || '').toLowerCase();
const DEBUG_BADGES = process.env.DEBUG_BADGES === 'true';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // Twitch badge sets rarely change; refresh every 6h

let appToken = null;
let appTokenExpiresAt = 0;
let broadcasterId = null;

// set_id -> Map(version_id -> { title, imageUrl })
let globalBadgeSets = new Map();
let channelBadgeSets = new Map();
let loaded = false;
let loadPromise = null;

async function getAppAccessToken() {
  const now = Date.now();
  if (appToken && now < appTokenExpiresAt - 60000) return appToken;

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error('Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET');
  }

  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(
    TWITCH_CLIENT_ID
  )}&client_secret=${encodeURIComponent(TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`;

  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Twitch token request failed: ${res.status}`);
  }
  const data = await res.json();
  appToken = data.access_token;
  appTokenExpiresAt = now + data.expires_in * 1000;
  return appToken;
}

function helixHeaders(token) {
  return { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
}

async function fetchBroadcasterId(token) {
  if (!TWITCH_USERNAME) return null;
  const res = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(TWITCH_USERNAME)}`,
    { headers: helixHeaders(token) }
  );
  if (!res.ok) {
    console.error(`[twitchBadges] Get Users failed: ${res.status}`);
    return null;
  }
  const data = await res.json();
  return data.data && data.data[0] ? data.data[0].id : null;
}

function badgeSetsFromResponse(json) {
  const map = new Map();
  (json.data || []).forEach((set) => {
    const versions = new Map();
    (set.versions || []).forEach((v) => {
      versions.set(String(v.id), {
        title: v.title || set.set_id,
        // 2x is a good balance of crispness vs. size for an OBS overlay
        imageUrl: v.image_url_2x || v.image_url_1x || v.image_url_4x,
      });
    });
    map.set(set.set_id, versions);
  });
  return map;
}

async function fetchGlobalBadges(token) {
  const res = await fetch('https://api.twitch.tv/helix/chat/badges/global', {
    headers: helixHeaders(token),
  });
  if (!res.ok) {
    console.error(`[twitchBadges] Get Global Chat Badges failed: ${res.status}`);
    return new Map();
  }
  return badgeSetsFromResponse(await res.json());
}

async function fetchChannelBadges(token, bId) {
  if (!bId) return new Map();
  const res = await fetch(
    `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(bId)}`,
    { headers: helixHeaders(token) }
  );
  if (!res.ok) {
    console.error(`[twitchBadges] Get Channel Chat Badges failed: ${res.status}`);
    return new Map();
  }
  return badgeSetsFromResponse(await res.json());
}

async function load() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.error('[twitchBadges] TWITCH_CLIENT_ID/SECRET not set - badge metadata unavailable, badges will be dropped.');
    loaded = true;
    return;
  }

  try {
    const token = await getAppAccessToken();
    if (!broadcasterId) {
      broadcasterId = await fetchBroadcasterId(token);
    }
    const [globalSets, channelSets] = await Promise.all([
      fetchGlobalBadges(token),
      fetchChannelBadges(token, broadcasterId),
    ]);
    globalBadgeSets = globalSets;
    channelBadgeSets = channelSets;
    loaded = true;

    if (DEBUG_BADGES) {
      console.log(
        `[twitchBadges] loaded ${globalBadgeSets.size} global badge sets, ${channelBadgeSets.size} channel badge sets.`
      );
    }
  } catch (err) {
    console.error('[twitchBadges] failed to load badge sets:', err.message);
    loaded = true; // don't spin forever retrying on every message; periodic refresh will retry
  }
}

function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) loadPromise = load().finally(() => { loadPromise = null; });
  return loadPromise;
}

function startAutoRefresh() {
  setInterval(() => {
    loaded = false;
    ensureLoaded();
  }, REFRESH_INTERVAL_MS);
}

/**
 * Resolves a single (setId, versionId) pair to { id, name, imageUrl } or
 * null if unknown. Channel-specific sets (subscriber tiers, bits, custom
 * channel badges) take priority over global ones, matching Twitch's own
 * documented resolution order.
 */
async function resolveBadge(setId, versionId) {
  await ensureLoaded();

  const channelSet = channelBadgeSets.get(setId);
  const fromChannel = channelSet && channelSet.get(versionId);
  if (fromChannel) {
    return { id: setId, name: fromChannel.title, imageUrl: fromChannel.imageUrl };
  }

  const globalSet = globalBadgeSets.get(setId);
  const fromGlobal = globalSet && globalSet.get(versionId);
  if (fromGlobal) {
    return { id: setId, name: fromGlobal.title, imageUrl: fromGlobal.imageUrl };
  }

  if (DEBUG_BADGES) {
    console.log(`[twitchBadges] no metadata found for ${setId}/${versionId}`);
  }
  return null;
}

module.exports = { resolveBadge, ensureLoaded, startAutoRefresh };
