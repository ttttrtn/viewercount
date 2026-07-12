// Centralized configuration for the YouTube service. Everything here is
// overridable via environment variables so operators can tune polling /
// failover behavior without touching code.

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
const DEBUG_YOUTUBE = /^true$/i.test(process.env.DEBUG_YOUTUBE || '');

const config = {
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  DEBUG_YOUTUBE,

  // How often to run the expensive search.list check while we believe the
  // channel is offline (search.list costs 100 quota units vs. 1 for videos.list).
  OFFLINE_POLL_MS: intFromEnv('YOUTUBE_OFFLINE_POLL_MS', 5 * 60 * 1000),

  // How often to refresh the viewer count while we believe the channel is live.
  LIVE_POLL_MS: intFromEnv('YOUTUBE_LIVE_POLL_MS', 15 * 1000),

  // Cap on exponential backoff after repeated official-API errors.
  MAX_BACKOFF_MS: intFromEnv('YOUTUBE_MAX_BACKOFF_MS', 30 * 60 * 1000),

  // Per-request timeout for calls to the official API.
  REQUEST_TIMEOUT_MS: intFromEnv('YOUTUBE_REQUEST_TIMEOUT_MS', 10 * 1000),

  // Minimum time a source (official/fallback) must remain the active,
  // healthy source before we're willing to switch away from it again.
  // This is what prevents rapid flip-flopping between providers.
  SOURCE_SWITCH_COOLDOWN_MS: intFromEnv(
    'YOUTUBE_SOURCE_SWITCH_COOLDOWN_MS',
    2 * 60 * 1000
  ),

  // While running on the fallback provider, how often to retry the
  // official API in the background to see if it has recovered.
  RECOVERY_CHECK_MS: intFromEnv('YOUTUBE_RECOVERY_CHECK_MS', 60 * 1000),

  // If BOTH providers fail, keep serving the last known-good result for
  // this long before finally reporting the channel as offline.
  STALE_CACHE_MS: intFromEnv('YOUTUBE_STALE_CACHE_MS', 3 * 60 * 1000),
};

// A canonical YouTube channel ID is "UC" followed by 22 URL-safe base64-ish
// characters (24 chars total). This is a soft check purely for surfacing
// misconfiguration early - we still attempt API calls either way, since
// YouTube occasionally introduces new ID formats.
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

function validateConfig(log) {
  if (!YOUTUBE_API_KEY) {
    log.warn(
      'YOUTUBE_API_KEY is not set. The official YouTube Data API will be skipped entirely and the fallback provider will be used whenever possible.'
    );
  }

  if (!YOUTUBE_CHANNEL_ID) {
    log.warn(
      'YOUTUBE_CHANNEL_ID is not set. YouTube live detection is disabled until this is configured.'
    );
  } else if (!CHANNEL_ID_PATTERN.test(YOUTUBE_CHANNEL_ID)) {
    log.warn(
      `YOUTUBE_CHANNEL_ID ("${YOUTUBE_CHANNEL_ID}") does not look like a standard channel ID ` +
        '(expected "UC" followed by 22 characters). Double check you copied the Channel ID, ' +
        'not a @handle, custom URL, or username - those will cause search.list to silently return zero results.'
    );
  }

  if (DEBUG_YOUTUBE) {
    log.info('DEBUG_YOUTUBE is enabled - verbose YouTube logging is ON.');
  }
}

module.exports = { config, validateConfig, CHANNEL_ID_PATTERN };
