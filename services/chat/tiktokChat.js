// TikTok LIVE chat, via the combined TikTok+Nimo Python sidecar (see
// /platform-sidecar). The sidecar buffers incoming CommentEvents and
// exposes them at GET /tiktok/chat, which this module polls and
// re-emits as normalized messages.
//
// PLATFORM_SIDECAR_URL - reused from the viewer-count config.

const tiktokBadges = require('./badges/tiktokBadges');

const TIKTOK_SERVICE_URL = (process.env.PLATFORM_SIDECAR_URL || '').replace(/\/+$/, '');

// Poll fast while connected/live so chat feels real-time; back off
// while offline so the sidecar (and this loop) isn't hammered for no
// reason between streams.
const LIVE_POLL_INTERVAL_MS = 3000;
const OFFLINE_POLL_INTERVAL_MS = 15000;
const FETCH_TIMEOUT_MS = 4000;

let pollTimer = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let lastConnected = null;

function isConfigured() {
  return Boolean(TIKTOK_SERVICE_URL);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function pollOnce() {
  try {
    const res = await fetchWithTimeout(`${TIKTOK_SERVICE_URL}/tiktok/chat`, FETCH_TIMEOUT_MS);

    if (!res.ok) {
      throw new Error(`sidecar returned ${res.status}`);
    }

    const data = await res.json();
    const connected = Boolean(data.live);

    if (connected !== lastConnected) {
      lastConnected = connected;
      if (onStatusCb) onStatusCb({ connected: true, live: connected });
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    messages.forEach((m) => {
      if (!onMessageCb) return;
      const base = {
        username: m.nickname || m.username || 'unknown',
        message: m.comment || m.message || '',
        color: null,
        timestamp: Math.floor(Date.now() / 1000),
      };

      tiktokBadges
        .resolveBadges(m.badges)
        .then((badges) => onMessageCb({ ...base, badges }))
        .catch((err) => {
          console.error('[tiktokChat] badge resolution error:', err.message);
          onMessageCb({ ...base, badges: [] });
        });
    });
  } catch (err) {
    if (lastConnected !== false) {
      lastConnected = false;
      if (onStatusCb) onStatusCb({ connected: false, live: false });
    }
    console.error('[tiktokChat] error reaching sidecar:', err.message);
  } finally {
    if (!stopped) pollTimer = setTimeout(pollOnce, lastConnected ? LIVE_POLL_INTERVAL_MS : OFFLINE_POLL_INTERVAL_MS);
  }
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!TIKTOK_SERVICE_URL) {
    console.error('[tiktokChat] PLATFORM_SIDECAR_URL is not set. Skipping TikTok chat.');
    return;
  }

  pollOnce();
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
}

module.exports = { start, stop, isConfigured };
