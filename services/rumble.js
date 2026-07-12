// Rumble's official Live Stream API (v1.1) is a single, pre-authenticated
// URL you generate yourself at https://rumble.com/account/livestream-api
// The URL already embeds your user ID + live-stream key, so no separate
// client id/secret pair is sent on each request.
//
// RUMBLE_API_URL   - the full URL copied from the Rumble dashboard above
// RUMBLE_API_KEY    - optional, reserved for a future Rumble auth scheme;
//                      not required by the current public API but kept as
//                      an env var per project convention / forward-compat
// RUMBLE_CHANNEL    - optional, only needed if your Rumble account has
//                      multiple channels and you want to match a specific
//                      one's livestream entry by channel_id rather than
//                      just taking the first live entry returned

const RUMBLE_API_URL = process.env.RUMBLE_API_URL || '';
const RUMBLE_API_KEY = process.env.RUMBLE_API_KEY || '';
const RUMBLE_CHANNEL = process.env.RUMBLE_CHANNEL || '';

const MIN_INTERVAL_MS = 15000; // respect Rumble's update cadence, avoid hammering
const MAX_BACKOFF_MS = 2 * 60 * 1000;

let lastFetchAt = 0;
let backoffMs = 0;
let lastResult = { live: false, viewers: 0 };
let inFlight = null;

async function fetchRumbleData() {
  const headers = { Accept: 'application/json' };

  // Reserved for future Rumble auth requirements - harmless to include.
  if (RUMBLE_API_KEY) {
    headers['Authorization'] = `Bearer ${RUMBLE_API_KEY}`;
  }

  const res = await fetch(RUMBLE_API_URL, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Rumble API returned ${res.status}. Body preview: ${body.slice(0, 300)}`
    );
  }

  return res.json();
}

function pickLivestream(data) {
  const streams = Array.isArray(data.livestreams) ? data.livestreams : [];

  if (streams.length === 0) return null;

  if (RUMBLE_CHANNEL) {
    const matched = streams.find(
      (s) => String(s.channel_id) === String(RUMBLE_CHANNEL)
    );
    if (matched) return matched;
  }

  // Default: first livestream entry that's actually live
  return streams.find((s) => s.is_live) || null;
}

/**
 * Returns { live: boolean, viewers: number }
 */
async function getRumbleStatus() {
  if (!RUMBLE_API_URL) {
    console.error('[rumble] RUMBLE_API_URL is not set. Skipping Rumble check.');
    return { live: false, viewers: 0 };
  }

  const now = Date.now();

  // Respect a minimum interval between real network calls, backing off
  // further after consecutive failures.
  const effectiveInterval = Math.max(MIN_INTERVAL_MS, backoffMs);
  if (now - lastFetchAt < effectiveInterval) {
    return lastResult;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const data = await fetchRumbleData();
      const stream = pickLivestream(data);

      lastFetchAt = Date.now();
      backoffMs = 0; // reset backoff on success

      if (stream) {
        console.log(
          `[rumble] channel is LIVE with ${stream.watching_now} viewers.`
        );
        lastResult = { live: true, viewers: stream.watching_now || 0 };
      } else {
        console.log('[rumble] channel detected as OFFLINE.');
        lastResult = { live: false, viewers: 0 };
      }

      return lastResult;
    } catch (err) {
      console.error('[rumble] error:', err.message);
      lastFetchAt = Date.now();
      // Exponential backoff after failures, capped, so a temporary outage
      // doesn't cause a hot retry loop.
      backoffMs = backoffMs === 0 ? MIN_INTERVAL_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      // Serve last known good data rather than flipping straight to offline
      // on a single transient failure.
      return lastResult;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

module.exports = { getStatus: getRumbleStatus };
