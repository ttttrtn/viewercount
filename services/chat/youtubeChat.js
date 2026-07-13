// YouTube live chat, via the pytchat-backed Python sidecar in
// /youtube-chat-service (pytchat has no equivalent maintained Node
// library and is explicitly requested, so - same pattern as TikTok -
// a small sidecar does the actual connecting and this module just
// polls it and re-emits new messages).
//
// YOUTUBE_CHANNEL_ID       - reused from the viewer-count config.
// YOUTUBE_CHAT_SERVICE_URL - base URL of the deployed sidecar, e.g.
//                             https://your-youtube-chat.onrender.com

const youtubeBadges = require('./badges/youtubeBadges');

const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
const YOUTUBE_CHAT_SERVICE_URL = (process.env.YOUTUBE_CHAT_SERVICE_URL || '').replace(/\/+$/, '');

const POLL_INTERVAL_MS = 4000;
const FETCH_TIMEOUT_MS = 4000;

let pollTimer = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let lastConnected = null;

function isConfigured() {
  return Boolean(YOUTUBE_CHANNEL_ID && YOUTUBE_CHAT_SERVICE_URL);
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
    const res = await fetchWithTimeout(
      `${YOUTUBE_CHAT_SERVICE_URL}/chat?channel_id=${encodeURIComponent(YOUTUBE_CHANNEL_ID)}`,
      FETCH_TIMEOUT_MS
    );

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
        username: m.author || 'unknown',
        message: m.message || '',
        color: null,
        timestamp: m.timestamp
          ? Math.floor(m.timestamp / (m.timestamp > 1e12 ? 1000 : 1))
          : Math.floor(Date.now() / 1000),
      };

      youtubeBadges
        .resolveBadges(m.badges)
        .then((badges) => onMessageCb({ ...base, badges }))
        .catch((err) => {
          console.error('[youtubeChat] badge resolution error:', err.message);
          onMessageCb({ ...base, badges: [] });
        });
    });
  } catch (err) {
    if (lastConnected !== false) {
      lastConnected = false;
      if (onStatusCb) onStatusCb({ connected: false, live: false });
    }
    console.error('[youtubeChat] error reaching sidecar:', err.message);
  } finally {
    if (!stopped) pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!YOUTUBE_CHANNEL_ID) {
    console.error('[youtubeChat] YOUTUBE_CHANNEL_ID is not set. Skipping YouTube chat.');
    return;
  }

  if (!YOUTUBE_CHAT_SERVICE_URL) {
    console.error(
      '[youtubeChat] YOUTUBE_CHAT_SERVICE_URL is not set. Deploy /youtube-chat-service and point this at it.'
    );
    return;
  }

  pollOnce();
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
}

module.exports = { start, stop, isConfigured };
