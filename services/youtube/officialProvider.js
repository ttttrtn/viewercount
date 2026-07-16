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

const { config } = require('./config');
const log = require('./logger');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

class YoutubeApiError extends Error {
  constructor(message, category, extra = {}) {
    super(message);
    this.name = 'YoutubeApiError';
    // category is one of:
    //   'not_configured' | 'auth' | 'quota' | 'network' | 'timeout' |
    //   'server' | 'malformed'
    this.category = category;
    Object.assign(this, extra);
  }
}

async function fetchJson(url, label) {
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
    if (res.status >= 500) {
      throw new YoutubeApiError(`${label} server error (HTTP ${res.status}): ${apiMessage}`, 'server', { status: res.status, reason });
    }

    throw new YoutubeApiError(`${label} failed (HTTP ${res.status}): ${apiMessage}`, 'server', { status: res.status, reason });
  }

  if (!body) {
    throw new YoutubeApiError(`${label} returned an empty body`, 'malformed');
  }

  return body;
}

/**
 * search.list: finds a currently-live broadcast for the configured channel.
 * Costs 100 quota units - only call this while we don't already know of a
 * live video (see index.js polling strategy).
 */
async function findLiveVideoId() {
  const url =
    `${API_BASE}/search?part=snippet` +
    `&channelId=${encodeURIComponent(config.YOUTUBE_CHANNEL_ID)}` +
    `&eventType=live&type=video&order=date&maxResults=1` +
    `&key=${encodeURIComponent(config.YOUTUBE_API_KEY)}`;

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
 * classify the broadcast's lifecycle state.
 */
async function getVideoDetails(videoId) {
  const url =
    `${API_BASE}/videos?part=snippet,liveStreamingDetails,status` +
    `&id=${encodeURIComponent(videoId)}` +
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

module.exports = { checkOfficial, YoutubeApiError };
