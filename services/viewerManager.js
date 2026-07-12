const twitch = require('./twitch');
const kick = require('./kick');
const rumble = require('./rumble');
const youtube = require('./youtube');
const tiktok = require('./tiktok');

// Each service module exposes getStatus() -> Promise<{ live, viewers }>.
// This manager fans out to all of them in parallel, retries a service
// once if it throws unexpectedly, caches the combined result briefly to
// avoid hammering upstream APIs on every single overlay poll, and always
// serves the last known good data if a refresh temporarily fails.

const CACHE_TTL_MS = 5000; // matches the frontend's 5s poll interval

const PLATFORMS = [
  { key: 'twitch', service: twitch },
  { key: 'kick', service: kick },
  { key: 'rumble', service: rumble },
  { key: 'tiktok', service: tiktok },
  { key: 'youtube', service: youtube },
];

let cachedResponse = buildEmptyResponse();
let cachedAt = 0;
let inFlight = null;

function buildEmptyResponse() {
  const response = { total: 0, updated: Math.floor(Date.now() / 1000) };
  for (const { key } of PLATFORMS) {
    response[key] = 0;
    response[`${key}Live`] = false;
  }
  return response;
}

async function getStatusWithRetry(service, key) {
  try {
    return await service.getStatus();
  } catch (err) {
    console.error(`[viewerManager] ${key} threw, retrying once:`, err.message);
    try {
      return await service.getStatus();
    } catch (err2) {
      console.error(`[viewerManager] ${key} failed again:`, err2.message);
      return { live: false, viewers: 0 };
    }
  }
}

async function refreshAll() {
  const results = await Promise.all(
    PLATFORMS.map(({ service, key }) => getStatusWithRetry(service, key))
  );

  const response = { updated: Math.floor(Date.now() / 1000) };
  let total = 0;

  results.forEach((result, i) => {
    const { key } = PLATFORMS[i];
    const viewers = result && typeof result.viewers === 'number' ? result.viewers : 0;
    const live = Boolean(result && result.live);

    response[key] = viewers;
    response[`${key}Live`] = live;

    if (live) {
      total += viewers;
    }
  });

  response.total = total;
  return response;
}

/**
 * Public entry point used by the Express route. Cached for CACHE_TTL_MS
 * and de-duplicates concurrent callers into a single in-flight refresh.
 */
async function getViewerCounts() {
  const now = Date.now();

  if (now - cachedAt < CACHE_TTL_MS) {
    return cachedResponse;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = refreshAll()
    .then((result) => {
      cachedResponse = result;
      cachedAt = Date.now();
      inFlight = null;
      return result;
    })
    .catch((err) => {
      console.error('[viewerManager] refresh failed entirely:', err.message);
      inFlight = null;
      return cachedResponse;
    });

  return inFlight;
}

module.exports = { getViewerCounts };
