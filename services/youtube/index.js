// YouTube service entry point. Orchestrates:
//   - the official YouTube Data API v3 (./officialProvider.js), preferred
//     whenever it's healthy,
//   - an unofficial fallback provider (./fallbackProvider.js), used only
//     when the official API fails or can't supply a viewer count,
//   - quota-aware polling intervals, exponential backoff, a switch
//     cooldown to prevent flapping between sources, and a grace period
//     that keeps serving last-known-good data if both sources fail.
//
// Public API: getStatus() -> Promise<{ live, viewers, source, fallbackActive }>
// This matches the shape viewerManager.js expects from every platform
// service, extended with `source`/`fallbackActive` so the API route can
// surface youtubeSource / youtubeFallbackActive as required.

const { config, validateConfig } = require('./config');
const log = require('./logger');
const officialProvider = require('./officialProvider');
const fallbackProvider = require('./fallbackProvider');

validateConfig(log);

// --- Persistent state across polls ---------------------------------------
let cachedVideoId = null; // last known-live video id (cheap-path hint for both providers)
let officialBackoffMs = 0;
let lastOfficialAttemptAt = 0;
let lastFallbackAttemptAt = 0;
let currentSource = null; // 'official' | 'fallback' | null (never determined yet)
let lastSwitchAt = 0;
let bothFailingSince = null;
let lastGoodResult = { live: false, viewers: 0 }; // last result we actually served
let inFlight = null;

function canLeaveFallback(now) {
  return now - lastSwitchAt >= config.SOURCE_SWITCH_COOLDOWN_MS;
}

function switchSource(source, now) {
  if (currentSource !== source) {
    log.info(
      source === 'official'
        ? 'Switching back to the official API.'
        : 'Switching to fallback provider.'
    );
    currentSource = source;
    lastSwitchAt = now;
  }
}

function handleBothFailed(now) {
  if (bothFailingSince === null) {
    bothFailingSince = now;
  }
  log.info('Both providers unavailable.');

  const staleFor = now - bothFailingSince;
  if (staleFor > config.STALE_CACHE_MS) {
    const seconds = config.STALE_CACHE_MS / 1000;
    const label = seconds >= 1 ? `${seconds}s` : `${config.STALE_CACHE_MS}ms`;
    log.info(`No successful update in over ${label} - reporting stream offline.`);
    cachedVideoId = null;
    return { live: false, viewers: 0 };
  }

  log.info(`Serving cached value (${lastGoodResult.viewers} viewers).`);
  return { live: lastGoodResult.live, viewers: lastGoodResult.viewers };
}

async function refreshOnce() {
  const now = Date.now();

  if (!config.YOUTUBE_API_KEY || !config.YOUTUBE_CHANNEL_ID) {
    // Nothing to poll for at all - stay quiet instead of spamming errors
    // every tick (validateConfig already warned once at startup).
    return { live: false, viewers: 0, source: 'official', fallbackActive: false };
  }

  const officialInterval =
    currentSource === 'fallback'
      ? config.RECOVERY_CHECK_MS
      : cachedVideoId
      ? config.LIVE_POLL_MS
      : config.OFFLINE_POLL_MS;
  const officialDue = now - lastOfficialAttemptAt >= Math.max(officialInterval, officialBackoffMs);

  let officialAttempted = false;
  let officialSucceeded = false;
  let officialResult = null;

  if (officialDue) {
    officialAttempted = true;
    lastOfficialAttemptAt = now;
    try {
      officialResult = await officialProvider.checkOfficial(cachedVideoId);
      officialSucceeded = true;
      officialBackoffMs = 0;
      cachedVideoId = officialResult.videoId;

      log.debug(
        `Official check result: live=${officialResult.live} videoId=${officialResult.videoId} ` +
          `viewers=${officialResult.viewers} viewersMissing=${officialResult.viewersMissing} ` +
          `broadcastState=${officialResult.broadcastState}`
      );

      if (officialResult.live) {
        if (officialResult.viewersMissing) {
          log.debug('Channel is live but concurrentViewers was absent from the API response.');
        } else {
          log.info(`Current viewers: ${officialResult.viewers}`);
          log.info('Official API successful.');
        }
      } else {
        log.debug(`Official API reports channel offline (state: ${officialResult.broadcastState}).`);
      }
    } catch (err) {
      officialBackoffMs =
        officialBackoffMs === 0 ? config.OFFLINE_POLL_MS : Math.min(officialBackoffMs * 2, config.MAX_BACKOFF_MS);
      log.error(`Official API failed: ${err.message}`);
      log.debug(`Official API failure category: ${err.category || 'unknown'}`);
    }
  }

  const needsFallbackForOutage = officialAttempted && !officialSucceeded;
  const needsFallbackForViewers = officialSucceeded && officialResult.live && officialResult.viewersMissing;
  const fallbackInterval = cachedVideoId ? config.LIVE_POLL_MS : config.OFFLINE_POLL_MS;
  const stickingWithFallback =
    !officialAttempted && currentSource === 'fallback' && now - lastFallbackAttemptAt >= fallbackInterval;

  let fallbackAttempted = false;
  let fallbackSucceeded = false;
  let fallbackResult = null;

  if (needsFallbackForOutage || needsFallbackForViewers || stickingWithFallback) {
    fallbackAttempted = true;
    lastFallbackAttemptAt = now;
    try {
      fallbackResult = await fallbackProvider.checkFallback({
        channelId: config.YOUTUBE_CHANNEL_ID,
        videoId: cachedVideoId,
      });
      fallbackSucceeded = true;
      if (fallbackResult.videoId) cachedVideoId = fallbackResult.videoId;
      log.debug(
        `Fallback check result: live=${fallbackResult.live} videoId=${fallbackResult.videoId} viewers=${fallbackResult.viewers}`
      );
      if (fallbackResult.live) {
        log.info(`Fallback provider returned ${fallbackResult.viewers ?? 0} viewers.`);
      }
    } catch (err) {
      log.error(`Fallback provider failed: ${err.message}`);
    }
  }

  // --- Compose the final result + source bookkeeping ----------------------
  let result;

  if (officialSucceeded && !(officialResult.live && officialResult.viewersMissing)) {
    if (currentSource === null || currentSource === 'official' || canLeaveFallback(now)) {
      switchSource('official', now);
      result = { live: officialResult.live, viewers: officialResult.live ? officialResult.viewers || 0 : 0 };
    } else if (fallbackSucceeded) {
      log.debug('Official API recovered but staying on fallback until the switch cooldown elapses.');
      result = { live: fallbackResult.live, viewers: fallbackResult.live ? fallbackResult.viewers || 0 : 0 };
    } else {
      result = { live: lastGoodResult.live, viewers: lastGoodResult.viewers };
    }
    bothFailingSince = null;
  } else if (officialSucceeded && officialResult.live && officialResult.viewersMissing) {
    if (fallbackSucceeded && fallbackResult.viewers !== null && fallbackResult.viewers !== undefined) {
      switchSource('fallback', now);
      result = { live: true, viewers: fallbackResult.viewers };
    } else {
      // Official confirms we're live, but neither source has a viewer
      // number right now - keep the channel marked live (this is the fix
      // for the original bug) and hold the last known viewer count rather
      // than dropping to 0.
      log.debug('No viewer count available from either source this tick; holding last known count.');
      result = { live: true, viewers: lastGoodResult.viewers || 0 };
    }
    bothFailingSince = null;
  } else if (needsFallbackForOutage) {
    if (fallbackSucceeded) {
      switchSource('fallback', now);
      result = { live: fallbackResult.live, viewers: fallbackResult.live ? fallbackResult.viewers || 0 : 0 };
      bothFailingSince = null;
    } else {
      result = handleBothFailed(now);
    }
  } else if (fallbackAttempted) {
    if (fallbackSucceeded) {
      result = { live: fallbackResult.live, viewers: fallbackResult.live ? fallbackResult.viewers || 0 : 0 };
      bothFailingSince = null;
    } else {
      result = handleBothFailed(now);
    }
  } else {
    // Nothing was due this tick - serve the last computed result.
    result = { live: lastGoodResult.live, viewers: lastGoodResult.viewers };
  }

  lastGoodResult = result;

  return {
    live: result.live,
    viewers: result.viewers,
    source: currentSource || 'official',
    fallbackActive: currentSource === 'fallback',
  };
}

/**
 * Returns { live, viewers, source, fallbackActive }. Never throws - all
 * failure handling happens internally so a YouTube outage can't take down
 * the rest of the overlay.
 */
async function getStatus() {
  if (inFlight) return inFlight;

  inFlight = refreshOnce()
    .catch((err) => {
      // Should be unreachable (refreshOnce catches its own provider
      // errors), but guard against anything unexpected regardless.
      log.error(`Unexpected error in YouTube service: ${err.message}`);
      return {
        live: lastGoodResult.live,
        viewers: lastGoodResult.viewers,
        source: currentSource || 'official',
        fallbackActive: currentSource === 'fallback',
      };
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

module.exports = { getStatus };
