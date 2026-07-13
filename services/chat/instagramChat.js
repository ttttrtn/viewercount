// Reads Instagram Live comments.
//
// Instagram publishes no official API for reading Live comments, and
// every unofficial method relies on undocumented, frequently-changing
// private endpoints that require a logged-in session. Hardcoding one of
// those endpoints here would (a) violate the "don't hardcode undocumented
// endpoints" requirement this integration was built under, and (b) break
// silently and unpredictably whenever Instagram changes its private API,
// with no upstream changelog to react to.
//
// Instead, this module is a small, isolated adapter around a comments
// source *you* point it at:
//
//   INSTAGRAM_LIVE_COMMENTS_URL - a URL that returns JSON in the shape
//       { "live": true, "messages": [ { "username": "...", "text": "..." } ] }
//     This can be:
//       - a small self-hosted scraper/bridge you control and can update
//         independently as Instagram changes (recommended - keeps that
//         churn out of this repo),
//       - a third-party Instagram Live-comments API you've subscribed to,
//       - or a browser-automation session you run yourself that replays
//         comments it observes to this shape.
//   INSTAGRAM_USERNAME / INSTAGRAM_SESSION - available for a bridge you
//     write yourself to use however it needs; unused directly by this
//     module.
//
// This keeps Instagram fully isolated (as required) and means an
// Instagram-side breakage only requires updating your bridge, never this
// codebase.

const INSTAGRAM_LIVE_COMMENTS_URL = process.env.INSTAGRAM_LIVE_COMMENTS_URL || '';

const POLL_INTERVAL_MS = 5000;
const FETCH_TIMEOUT_MS = 4000;
const SEEN_ID_CACHE_SIZE = 300;

let pollTimer = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let lastLive = null;
let warnedNoBridge = false;
const seenMessageIds = new Set();
const seenOrder = [];

function isConfigured() {
  return Boolean(INSTAGRAM_LIVE_COMMENTS_URL);
}

function markSeen(id) {
  seenMessageIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > SEEN_ID_CACHE_SIZE) {
    const oldest = seenOrder.shift();
    seenMessageIds.delete(oldest);
  }
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
    const res = await fetchWithTimeout(INSTAGRAM_LIVE_COMMENTS_URL, FETCH_TIMEOUT_MS);

    if (!res.ok) throw new Error(`bridge returned ${res.status}`);

    const data = await res.json();
    const live = Boolean(data.live);

    if (live !== lastLive) {
      lastLive = live;
      if (onStatusCb) onStatusCb({ connected: true, live });
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    messages.forEach((m) => {
      const id = m.id || `${m.username}-${m.text || m.message}-${m.timestamp || ''}`;
      if (seenMessageIds.has(id)) return;
      markSeen(id);

      if (onMessageCb) {
        onMessageCb({
          username: m.username || 'unknown',
          message: m.text || m.message || '',
          color: null,
          timestamp: m.timestamp || Math.floor(Date.now() / 1000),
        });
      }
    });
  } catch (err) {
    if (lastLive !== false) {
      lastLive = false;
      if (onStatusCb) onStatusCb({ connected: false, live: false });
    }
    console.error('[instagramChat] error reaching bridge:', err.message);
  } finally {
    if (!stopped) pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!INSTAGRAM_LIVE_COMMENTS_URL) {
    if (!warnedNoBridge) {
      warnedNoBridge = true;
      console.log(
        '[instagramChat] INSTAGRAM_LIVE_COMMENTS_URL is not set - Instagram has no official Live-comments ' +
          'API, so this integration stays idle until you point it at a bridge you control. See the comment ' +
          'at the top of services/chat/instagramChat.js.'
      );
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
