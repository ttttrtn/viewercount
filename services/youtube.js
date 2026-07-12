// YouTube Data API v3, using only an API key (no OAuth), which limits us
// to public endpoints. The quota-efficient strategy here:
//
//   1. While we don't know of a live video, use search.list (100 quota
//      units) to check if the channel is currently live and grab that
//      broadcast's videoId - but only every OFFLINE_POLL_MS, since this
//      call is expensive relative to the default 10,000 units/day quota.
//
//   2. Once we have a live videoId, switch to videos.list with
//      part=liveStreamingDetails (1 quota unit) to read concurrentViewers
//      on a much shorter interval (LIVE_POLL_MS) - cheap enough to poll
//      frequently while actually live.
//
//   3. If videos.list stops reporting concurrentViewers, the stream has
//      ended - drop back to the expensive search.list check on the slow
//      interval.
//
// This keeps steady-state (offline) quota usage low while still reacting
// quickly to viewer count changes during an active stream.

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

const OFFLINE_POLL_MS = 5 * 60 * 1000; // 5 minutes between expensive live-checks
const LIVE_POLL_MS = 15 * 1000; // 15 seconds between cheap viewer-count checks
const MAX_BACKOFF_MS = 30 * 60 * 1000; // cap backoff at 30 minutes

let cachedVideoId = null;
let lastCheckAt = 0;
let backoffMs = 0;
let lastResult = { live: false, viewers: 0 };
let inFlight = null;

async function findLiveVideoId() {
  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet` +
    `&channelId=${encodeURIComponent(YOUTUBE_CHANNEL_ID)}` +
    `&eventType=live&type=video&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `YouTube search.list returned ${res.status}. Body preview: ${body.slice(
        0,
        300
      )}`
    );
  }

  const data = await res.json();
  const item = data.items && data.items[0];
  return item ? item.id.videoId : null;
}

async function getViewerCountForVideo(videoId) {
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails` +
    `&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(
      YOUTUBE_API_KEY
    )}`;

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `YouTube videos.list returned ${res.status}. Body preview: ${body.slice(
        0,
        300
      )}`
    );
  }

  const data = await res.json();
  const video = data.items && data.items[0];
  const details = video && video.liveStreamingDetails;

  if (details && details.concurrentViewers !== undefined) {
    return parseInt(details.concurrentViewers, 10) || 0;
  }

  return null; // stream has ended or is no longer live
}

/**
 * Returns { live: boolean, viewers: number }
 */
async function getYoutubeStatus() {
  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
    console.error(
      '[youtube] YOUTUBE_API_KEY / YOUTUBE_CHANNEL_ID not set. Skipping YouTube check.'
    );
    return { live: false, viewers: 0 };
  }

  const now = Date.now();
  const pollInterval = cachedVideoId ? LIVE_POLL_MS : OFFLINE_POLL_MS;
  const effectiveInterval = Math.max(pollInterval, backoffMs);

  if (now - lastCheckAt < effectiveInterval) {
    return lastResult;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      if (cachedVideoId) {
        // Cheap path: we believe we're live, just refresh the viewer count.
        const viewers = await getViewerCountForVideo(cachedVideoId);

        if (viewers === null) {
          console.log('[youtube] livestream ended.');
          cachedVideoId = null;
          lastResult = { live: false, viewers: 0 };
        } else {
          console.log(`[youtube] LIVE with ${viewers} viewers.`);
          lastResult = { live: true, viewers };
        }
      } else {
        // Expensive path: check if the channel just went live.
        const videoId = await findLiveVideoId();

        if (videoId) {
          cachedVideoId = videoId;
          const viewers = await getViewerCountForVideo(videoId);
          console.log(`[youtube] detected LIVE (video ${videoId}).`);
          lastResult = { live: true, viewers: viewers || 0 };
        } else {
          console.log('[youtube] channel detected as OFFLINE.');
          lastResult = { live: false, viewers: 0 };
        }
      }

      lastCheckAt = Date.now();
      backoffMs = 0;
      return lastResult;
    } catch (err) {
      console.error('[youtube] error:', err.message);
      lastCheckAt = Date.now();
      // Exponential backoff after API errors (e.g. quota exceeded, 5xx)
      backoffMs =
        backoffMs === 0 ? OFFLINE_POLL_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      // Keep serving last known good data instead of flipping to offline
      // on a transient error.
      return lastResult;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

module.exports = { getStatus: getYoutubeStatus };
