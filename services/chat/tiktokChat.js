// TikTok LIVE chat, via the same TikTokLive.py Python sidecar already
// used for viewer counts (see /tiktok-service). The sidecar now also
// buffers incoming CommentEvents and exposes them at GET /chat, which
// this module polls and re-emits as normalized messages.
//
// TIKTOK_SERVICE_URL - reused from the viewer-count config.

const TIKTOK_SERVICE_URL = (process.env.TIKTOK_SERVICE_URL || '').replace(/\/+$/, '');

const POLL_INTERVAL_MS = 3000;
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
    const res = await fetchWithTimeout(`${TIKTOK_SERVICE_URL}/chat`, FETCH_TIMEOUT_MS);

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
      if (onMessageCb) {
        onMessageCb({
          username: m.nickname || m.username || 'unknown',
          message: m.comment || m.message || '',
          color: null,
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    });
  } catch (err) {
    if (lastConnected !== false) {
      lastConnected = false;
      if (onStatusCb) onStatusCb({ connected: false, live: false });
    }
    console.error('[tiktokChat] error reaching sidecar:', err.message);
  } finally {
    if (!stopped) pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!TIKTOK_SERVICE_URL) {
    console.error('[tiktokChat] TIKTOK_SERVICE_URL is not set. Skipping TikTok chat.');
    return;
  }

  pollOnce();
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
}

module.exports = { start, stop, isConfigured };
