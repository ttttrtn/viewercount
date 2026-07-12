// Unofficial fallback data source, used only when the official YouTube
// Data API v3 is unavailable (quota exhausted, invalid credentials,
// network failure, 5xx, timeout, or missing concurrentViewers).
//
// Backed by youtubei.js (https://github.com/LuanRT/YouTube.js), an actively
// maintained client for YouTube's internal "InnerTube" API - the same API
// youtube.com itself uses. It's a structured JSON API, not HTML scraping,
// which is why it was chosen over scraping the watch/channel pages
// directly (scraping is only used here as a last-resort, and youtubei.js
// itself does not rely on it for the fields we need).
//
// This module is intentionally isolated behind the same
// { live, viewers, videoId } shape as officialProvider.js, so it can be
// swapped for a different fallback implementation later without touching
// index.js.

const log = require('./logger');
const { config } = require('./config');

class FallbackProviderError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'FallbackProviderError';
    this.cause = cause;
  }
}

let innertubePromise = null;

function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      // Lazy-required so a missing/broken dependency can't prevent the
      // rest of the app (or the official provider) from working.
      const { Innertube } = require('youtubei.js');
      return Innertube.create({ generate_session_locally: true });
    })().catch((err) => {
      innertubePromise = null; // allow retrying on the next call
      throw err;
    });
  }
  return innertubePromise;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Turns strings like "1.2K watching", "3,412 watching now", "854 watching"
// into a best-effort numeric estimate. Returns null if unparseable.
function parseApproxViewerCount(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB]?)/i);
  if (!match) return null;

  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;

  const suffix = (match[2] || '').toUpperCase();
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(num * multiplier);
}

// Extracts { live, viewers } from a youtubei.js VideoInfo (getBasicInfo/getInfo result).
function readLiveInfoFromVideo(info) {
  const basicInfo = info && info.basic_info;
  if (!basicInfo) return { live: false, viewers: null };

  const live = Boolean(basicInfo.is_live);
  if (!live) return { live: false, viewers: null };

  // For live videos, view_count on basic_info represents the current
  // concurrent viewer count (not lifetime views).
  let viewers = null;
  if (typeof basicInfo.view_count === 'number') {
    viewers = basicInfo.view_count;
  } else if (typeof basicInfo.view_count === 'string') {
    viewers = parseApproxViewerCount(basicInfo.view_count);
  }

  return { live: true, viewers };
}

async function checkVideoById(yt, videoId) {
  log.debug(`Fallback: checking cached video ${videoId} via getBasicInfo.`);
  const info = await withTimeout(
    yt.getBasicInfo(videoId),
    config.REQUEST_TIMEOUT_MS,
    'fallback getBasicInfo'
  );
  const { live, viewers } = readLiveInfoFromVideo(info);
  log.debug(`Fallback getBasicInfo(${videoId}) -> live=${live} viewers=${viewers}`);
  return live ? { live: true, viewers, videoId } : null;
}

// Scans the channel's videos for one currently flagged as live. Used when
// we don't already have a candidate video id (e.g. official search.list
// never got a chance to run). youtubei.js's channel video items expose an
// `is_live` flag on the live badge / thumbnail overlay; we check a couple
// of shapes defensively since this is unofficial, undocumented surface
// that can shift between library versions.
async function findLiveVideoOnChannel(yt, channelId) {
  log.debug(`Fallback: browsing channel ${channelId} for a live video.`);
  const channel = await withTimeout(
    yt.getChannel(channelId),
    config.REQUEST_TIMEOUT_MS,
    'fallback getChannel'
  );

  const candidateLists = [];
  if (channel && Array.isArray(channel.videos)) candidateLists.push(channel.videos);
  if (channel && channel.videos && Array.isArray(channel.videos.videos)) {
    candidateLists.push(channel.videos.videos);
  }

  for (const list of candidateLists) {
    for (const item of list) {
      const isLive =
        item.is_live === true ||
        item.is_live_now === true ||
        (Array.isArray(item.badges) &&
          item.badges.some((b) => /live/i.test(b && (b.label || b.text || ''))));

      if (isLive && item.id) {
        const viewers =
          parseApproxViewerCount(
            (item.short_view_count_text && item.short_view_count_text.text) ||
              (item.view_count && item.view_count.text) ||
              null
          );
        log.debug(`Fallback: found live video ${item.id} on channel browse, approx viewers=${viewers}`);
        return { live: true, viewers, videoId: item.id };
      }
    }
  }

  log.debug('Fallback: no live video found while browsing channel.');
  return null;
}

/**
 * Returns { live, viewers, videoId } - the same shape officialProvider
 * produces - or throws FallbackProviderError if the fallback itself is
 * unavailable (e.g. dependency missing, InnerTube session failed, or
 * every lookup strategy errored).
 */
async function checkFallback({ channelId, videoId }) {
  let yt;
  try {
    yt = await getInnertube();
  } catch (err) {
    throw new FallbackProviderError(`Fallback provider failed to initialize: ${err.message}`, err);
  }

  const errors = [];

  if (videoId) {
    try {
      const result = await checkVideoById(yt, videoId);
      if (result) return result;
      // Known video isn't live anymore - fall through to a channel-level
      // check in case the stream rotated to a new video id.
    } catch (err) {
      errors.push(`getBasicInfo: ${err.message}`);
    }
  }

  if (channelId) {
    try {
      const result = await findLiveVideoOnChannel(yt, channelId);
      if (result) return result;
    } catch (err) {
      errors.push(`getChannel: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    throw new FallbackProviderError(`Fallback provider lookups failed: ${errors.join('; ')}`);
  }

  // No error, just genuinely not live.
  return { live: false, viewers: null, videoId: null };
}

module.exports = { checkFallback, FallbackProviderError, parseApproxViewerCount };
