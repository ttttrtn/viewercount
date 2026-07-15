// Wraps the official YouTube Data API v3 (search.list + videos.list).
//
// Exports a single async function, `checkOfficial()`, which returns:
//   {
//     live: boolean,
//     viewers: number | null,   // null means "live, but no viewer count available"
//     videoId: string | null,
//     broadcastState: 'live' | 'upcoming' | 'completed' | 'none',
//     viewersMissing: boolean,  // true if we're live but concurrentViewers was absent
//   }
//
// or throws a YoutubeApiError describing *why* it failed, so the caller
// (index.js) can decide whether to retry, back off, or fail over to the
// unofficial fallback provider.
//
// Reliability/quota notes (read this before touching retry logic):
//   - search.list costs 100 quota units per call; videos.list costs ~1-7
//     depending on `part`. The daily default project quota is 10,000 units,
//     so search.list is by far the biggest cost driver here. Everything in
//     this file is written to call search.list as rarely as possible.
//   - Transient errors (network, timeout, 5xx) are retried in-process with
//     exponential backoff + jitter, honoring a `Retry-After` header if the
//     API sends one.
//   - quotaExceeded is NOT retried in-process. Retrying a quota error just
//     burns more requests against an already-exhausted (or throttled)
//     project and can trip additional per-second/per-minute rate limits.
//     Instead we open a circuit breaker until the next quota reset
//     (midnight Pacific, per YouTube's published reset schedule) and fail
//     fast for every call in between so the caller can lean on the
//     fallback provider without hammering Google.
//   - A minimum interval is enforced between search.list calls regardless
//     of how often checkOfficial() is invoked by the poller, since that's
//     the call that actually costs real quota.

const { config } = require('./config');
const log = require('./logger');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// ---- Tunables (all overridable via config.js; sane defaults if absent) ----
const MAX_RETRIES = config.YT_MAX_RETRIES ?? 4;
const BASE_RETRY_DELAY_MS = config.YT_BASE_RETRY_DELAY_MS ?? 500;
const MAX_RETRY_DELAY_MS = config.YT_MAX_RETRY_DELAY_MS ?? 30_000;
// Floor on time between two search.list calls, independent of poll cadence.
const MIN_SEARCH_INTERVAL_MS = config.YT_MIN_SEARCH_INTERVAL_MS ?? 5 * 60 * 1000; // 5 min

// Only these categories represent transient conditions worth retrying.
// auth / not_configured / malformed are all "retrying won't help" - either
// the key is bad, the request is bad, or the response can't be parsed.
const RETRYABLE_CATEGORIES = new Set(['network', 'timeout', 'server']);

class YoutubeApiError extends Error {
  constructor(message, category, extra = {}) {
    super(message);
    this.name = 'YoutubeApiError';
    // category is one of:
    //   'not_configured' | 'auth' | 'quota' | 'network' | 'timeout' |
    //   'server' | 'malformed' | 'quota_circuit_open'
    this.category = category;
    Object.assign(this, extra);
  }
}

// ---- Quota circuit breaker state ---------------------------------------
// Once we see a real quotaExceeded response, we stop calling the API
// entirely until the quota resets, rather than retrying and burning more
// requests (and risking additional throttling) against an exhausted quota.
let quotaResetAt = 0; // epoch ms; 0 = circuit closed

function nextPacificMidnightUtcMs(from = new Date()) {
  // YouTube/Google Cloud quotas reset at midnight Pacific Time. Rather than
  // hardcode a fixed UTC offset (which breaks across DST), ask Intl for the
  // Pacific wall-clock date/time and reconstruct the next midnight from it.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(from);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const y = get('year');
  const mo = get('month');
  const d = get('day');
  const h = get('hour') === 24 ? 0 : get('hour');
  const mi = get('minute');
  const s = get('second');

  // Milliseconds until the Pacific wall clock ticks over to the next day.
  const secondsIntoDay = h * 3600 + mi * 60 + s;
  const msUntilMidnight = (24 * 3600 - secondsIntoDay) * 1000;

  return from.getTime() + msUntilMidnight;
}

function openQuotaCircuit() {
  quotaResetAt = nextPacificMidnightUtcMs();
  log.info(
    `YouTube quota exhausted - suppressing further official-API calls until ${new Date(quotaResetAt).toISOString()}`
  );
}

function quotaCircuitOpen() {
  return Date.now() < quotaResetAt;
}

// ---- Backoff helpers -----------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs != null) {
    // Server told us explicitly how long to wait - respect that over our
    // own schedule, but still cap it so a huge Retry-After can't stall the
    // whole poller indefinitely.
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  const exp = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  // Full jitter: uniform random in [0, exp]. Avoids every poller instance
  // (if you ever run more than one) retrying in lockstep.
  return Math.random() * exp;
}

function parseRetryAfter(res) {
  const header = res && res.headers && res.headers.get && res.headers.get('retry-after');
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

async function fetchJson(url, label) {
  if (quotaCircuitOpen()) {
    throw new YoutubeApiError(
      `${label} skipped - quota circuit open until ${new Date(quotaResetAt).toISOString()}`,
      'quota_circuit_open',
      { resetAt: quotaResetAt }
    );
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fetchJsonOnce(url, label);
    } catch (err) {
      if (err instanceof YoutubeApiError && err.category === 'quota') {
        openQuotaCircuit();
        throw err;
      }

      const retryable = err instanceof YoutubeApiError && RETRYABLE_CATEGORIES.has(err.category);
      if (!retryable || attempt >= MAX_RETRIES) {
        throw err;
      }

      const delay = backoffDelay(attempt, err.retryAfterMs);
      log.debug(
        `${label} failed with retryable error (${err.category}), retrying in ${Math.round(delay)}ms ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}

async function fetchJsonOnce(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

  log.debug(`Requesting ${label}: ${url.replace(config.YOUTUBE_API_KEY, 'REDACTED')}`);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new YoutubeApiError(`${label} timed out after ${config.REQUEST_TIMEOUT_MS}ms`, 'timeout');
    }
    throw new YoutubeApiError(`${label} network error: ${err.message}`, 'network');
  } finally {
    clearTimeout(timeout);
  }

  log.debug(`${label} responded with HTTP ${res.status}`);

  const retryAfterMs = parseRetryAfter(res);

  const bodyText = await res.text().catch(() => '');
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch (err) {
    throw new YoutubeApiError(
      `${label} returned unparseable JSON (HTTP ${res.status}): ${bodyText.slice(0, 200)}`,
      'malformed'
    );
  }

  if (!res.ok) {
    const reason =
      (body &&
        body.error &&
        Array.isArray(body.error.errors) &&
        body.error.errors[0] &&
        body.error.errors[0].reason) ||
      null;
    const apiMessage = (body && body.error && body.error.message) || bodyText.slice(0, 200);

    log.debug(`${label} error body:`, JSON.stringify(body).slice(0, 500));

    if (res.status === 403 && reason === 'quotaExceeded') {
      throw new YoutubeApiError(`${label} quota exceeded: ${apiMessage}`, 'quota', { status: res.status, reason });
    }
    if (res.status === 400 && reason === 'keyInvalid') {
      throw new YoutubeApiError(`${label} rejected the API key: ${apiMessage}`, 'auth', { status: res.status, reason });
    }
    if (res.status === 403 && (reason === 'accessNotConfigured' || reason === 'forbidden')) {
      throw new YoutubeApiError(
        `${label} access denied (is the YouTube Data API v3 enabled for this key, and does the key have no restrictions blocking it?): ${apiMessage}`,
        'auth',
        { status: res.status, reason }
      );
    }
    if (res.status === 401) {
      throw new YoutubeApiError(`${label} unauthorized: ${apiMessage}`, 'auth', { status: res.status, reason });
    }
    if (res.status === 429) {
      // Rate limited (distinct from daily quotaExceeded) - always retryable.
      throw new YoutubeApiError(`${label} rate limited (HTTP 429): ${apiMessage}`, 'server', {
        status: res.status,
        reason,
        retryAfterMs,
      });
    }
    if (res.status >= 500) {
      throw new YoutubeApiError(`${label} server error (HTTP ${res.status}): ${apiMessage}`, 'server', {
        status: res.status,
        reason,
        retryAfterMs,
      });
    }

    throw new YoutubeApiError(`${label} failed (HTTP ${res.status}): ${apiMessage}`, 'server', {
      status: res.status,
      reason,
      retryAfterMs,
    });
  }

  if (!body) {
    throw new YoutubeApiError(`${label} returned an empty body`, 'malformed');
  }

  return body;
}

/**
 * search.list: finds a currently-live broadcast for the configured channel.
 * Costs 100 quota units - only call this while we don't already know of a
 * live video (see index.js polling strategy) - and even then, no more
 * often than MIN_SEARCH_INTERVAL_MS, enforced below regardless of how
 * eagerly the caller polls.
 */
let lastSearchAt = 0;

async function findLiveVideoId() {
  const sinceLastSearch = Date.now() - lastSearchAt;
  if (lastSearchAt !== 0 && sinceLastSearch < MIN_SEARCH_INTERVAL_MS) {
    const waitMs = MIN_SEARCH_INTERVAL_MS - sinceLastSearch;
    throw new YoutubeApiError(
      `search.list throttled - called ${Math.round(sinceLastSearch / 1000)}s after the last search ` +
        `(minimum interval ${Math.round(MIN_SEARCH_INTERVAL_MS / 1000)}s). Try again in ${Math.round(waitMs / 1000)}s.`,
      'throttled',
      { retryAfterMs: waitMs }
    );
  }

  const url =
    `${API_BASE}/search?part=snippet` +
    `&channelId=${encodeURIComponent(config.YOUTUBE_CHANNEL_ID)}` +
    `&eventType=live&type=video&order=date&maxResults=1` +
    `&key=${encodeURIComponent(config.YOUTUBE_API_KEY)}`;

  lastSearchAt = Date.now();
  const data = await fetchJson(url, 'search.list');

  if (!Array.isArray(data.items)) {
    throw new YoutubeApiError('search.list response missing "items" array', 'malformed');
  }

  const item = data.items[0];
  const videoId = item && item.id && item.id.videoId ? item.id.videoId : null;

  log.debug('search.list items found:', data.items.length, 'videoId:', videoId);

  return videoId;
}

/**
 * Classifies a video's broadcast lifecycle from videos.list fields.
 * NOTE: the "testing" broadcast status only exists on the LiveBroadcasts
 * resource (liveBroadcasts.list), which requires OAuth as the broadcaster -
 * it isn't visible through API-key/public access, so it can't be
 * distinguished here. We treat anything that isn't clearly
 * live/upcoming/completed as 'none' and log the raw fields under debug so
 * it's still inspectable.
 */
function classifyBroadcastState(video) {
  const snippet = video.snippet || {};
  const details = video.liveStreamingDetails || {};

  if (details.actualEndTime) return 'completed';
  if (details.actualStartTime && !details.actualEndTime) return 'live';
  if (details.scheduledStartTime && !details.actualStartTime) return 'upcoming';
  if (snippet.liveBroadcastContent === 'live') return 'live';
  if (snippet.liveBroadcastContent === 'upcoming') return 'upcoming';
  return 'none';
}

/**
 * videos.list with part=liveStreamingDetails,snippet,status: cheap (1 quota
 * unit) way to read concurrentViewers plus enough metadata to correctly
 * classify the broadcast's lifecycle state. `fields` is set to trim the
 * response to only what we actually read - doesn't change the quota cost,
 * but cuts payload size/parse time on every poll.
 */
async function getVideoDetails(videoId) {
  const url =
    `${API_BASE}/videos?part=snippet,liveStreamingDetails,status` +
    `&id=${encodeURIComponent(videoId)}` +
    `&fields=${encodeURIComponent('items(snippet(liveBroadcastContent),liveStreamingDetails)')}` +
    `&key=${encodeURIComponent(config.YOUTUBE_API_KEY)}`;

  const data = await fetchJson(url, 'videos.list');

  if (!Array.isArray(data.items)) {
    throw new YoutubeApiError('videos.list response missing "items" array', 'malformed');
  }

  const video = data.items[0];

  if (!video) {
    // Video was deleted/privatized between the search and this lookup.
    return { broadcastState: 'none', viewers: null, viewersMissing: false };
  }

  const details = video.liveStreamingDetails || {};
  const broadcastState = classifyBroadcastState(video);

  log.debug('videos.list liveStreamingDetails:', JSON.stringify(details));
  log.debug('videos.list classified broadcastState:', broadcastState);

  if (broadcastState !== 'live') {
    return { broadcastState, viewers: null, viewersMissing: false };
  }

  // KEY FIX: concurrentViewers can be legitimately absent from the API
  // response *while the stream is still live* - YouTube documents this as
  // happening when the count hasn't refreshed yet or is temporarily
  // unavailable. Earlier logic treated a missing concurrentViewers as
  // "the stream ended", which caused false "offline" reports during real
  // live streams. We now keep broadcastState as the source of truth for
  // live/offline, and treat a missing viewer count as a *separate*,
  // recoverable condition (viewersMissing) that the orchestrator can fill
  // in from the fallback provider without declaring the channel offline.
  if (details.concurrentViewers === undefined) {
    return { broadcastState: 'live', viewers: null, viewersMissing: true };
  }

  const viewers = parseInt(details.concurrentViewers, 10);
  return {
    broadcastState: 'live',
    viewers: Number.isFinite(viewers) ? viewers : null,
    viewersMissing: !Number.isFinite(viewers),
  };
}

async function checkOfficial(cachedVideoId) {
  if (!config.YOUTUBE_API_KEY || !config.YOUTUBE_CHANNEL_ID) {
    throw new YoutubeApiError(
      'YOUTUBE_API_KEY / YOUTUBE_CHANNEL_ID not configured',
      'not_configured'
    );
  }

  if (quotaCircuitOpen()) {
    throw new YoutubeApiError(
      `Quota circuit open - suppressing official-API calls until ${new Date(quotaResetAt).toISOString()}`,
      'quota_circuit_open',
      { resetAt: quotaResetAt }
    );
  }

  // Cheap path: we already know of a (probably) live video, just refresh it.
  if (cachedVideoId) {
    const details = await getVideoDetails(cachedVideoId);

    if (details.broadcastState === 'live') {
      return {
        live: true,
        viewers: details.viewers,
        videoId: cachedVideoId,
        broadcastState: 'live',
        viewersMissing: details.viewersMissing,
      };
    }

    // The cached video is no longer live (ended, or was never live to begin
    // with) - fall through to a fresh search below instead of assuming the
    // whole channel is offline off a single video's state.
    log.debug(
      `Cached video ${cachedVideoId} is no longer live (state: ${details.broadcastState}). Re-searching.`
    );
  }

  // Expensive path: search for a currently-live broadcast on the channel.
  // Subject to MIN_SEARCH_INTERVAL_MS throttling inside findLiveVideoId();
  // a 'throttled' YoutubeApiError propagates up so the caller can fail over
  // to the unofficial provider for this cycle instead of forcing a search.
  log.info('Searching for active live broadcast...');
  const videoId = await findLiveVideoId();

  if (!videoId) {
    log.info('No active live broadcast detected.');
    return { live: false, viewers: null, videoId: null, broadcastState: 'none', viewersMissing: false };
  }

  log.info(`Live video detected: ${videoId}`);
  const details = await getVideoDetails(videoId);

  if (details.broadcastState !== 'live') {
    // search.list said "live" but videos.list disagrees (rare race between
    // the two endpoints' indexing). Trust the more detailed videos.list
    // result and report offline rather than a stale/incorrect video id.
    log.debug(
      `search.list reported ${videoId} as live but videos.list classified it as ${details.broadcastState}.`
    );
    return { live: false, viewers: null, videoId: null, broadcastState: details.broadcastState, viewersMissing: false };
  }

  return {
    live: true,
    viewers: details.viewers,
    videoId,
    broadcastState: 'live',
    viewersMissing: details.viewersMissing,
  };
}

// Exposed mainly for tests/monitoring - lets index.js log/report quota
// circuit state without reaching into module internals.
function getQuotaCircuitState() {
  return { open: quotaCircuitOpen(), resetAt: quotaResetAt || null };
}

module.exports = { checkOfficial, YoutubeApiError, getQuotaCircuitState };
