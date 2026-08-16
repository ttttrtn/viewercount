// Reads Nimo TV live chat.
//
// Nimo has no official public API for live chat, so this integration
// pairs with the combined TikTok+Nimo Python sidecar (see
// /platform-sidecar), which drives a headless Playwright/Chromium page
// against the live room and buffers the username/message pairs it reads
// off the chat panel's DOM. This module just polls that sidecar's
// GET /nimo/chat endpoint and re-emits the results as normalized
// messages - the exact same split used for TikTok
// (see services/chat/tiktokChat.js).
//
// PLATFORM_SIDECAR_URL - base URL of the deployed /platform-sidecar
//   service, e.g. https://viewer-counter-sidecar.onrender.com
//   (same URL used for TikTok - shared with services/tiktok.js)

const NIMO_SERVICE_URL = (process.env.PLATFORM_SIDECAR_URL || '').replace(/\/+$/, '');

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
let warnedNoService = false;

function isConfigured() {
  return Boolean(NIMO_SERVICE_URL);
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
    const res = await fetchWithTimeout(`${NIMO_SERVICE_URL}/nimo/chat`, FETCH_TIMEOUT_MS);

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
      onMessageCb({
        username: m.username || 'unknown',
        message: m.message || '',
        color: null,
        timestamp: Math.floor(Date.now() / 1000),
        badges: [],
      });
    });
  } catch (err) {
    if (lastConnected !== false) {
      lastConnected = false;
      if (onStatusCb) onStatusCb({ connected: false, live: false });
    }
    console.error('[nimoChat] error reaching sidecar:', err.message);
  } finally {
    if (!stopped) pollTimer = setTimeout(pollOnce, lastConnected ? LIVE_POLL_INTERVAL_MS : OFFLINE_POLL_INTERVAL_MS);
  }
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!NIMO_SERVICE_URL) {
    if (!warnedNoService) {
      warnedNoService = true;
      console.log('[nimoChat] PLATFORM_SIDECAR_URL is not set. Skipping Nimo chat.');
    }
    return;
  }

  pollOnce();
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
}

module.exports = { start, stop, isConfigured };
