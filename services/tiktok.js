// TikTok has no official public API for live viewer counts. This project
// uses TikTokLive.py (isaackogan/TikTokLive) running as a small, separate
// Python service (see /tiktok-service), since that library is Python-only.
//
// This module is just a thin HTTP client: it polls the Python service's
// /status endpoint and normalizes the response into the same
// { live, viewers } shape every other service in this project uses.
//
// TIKTOK_SERVICE_URL - base URL of the deployed Python service, e.g.
//                       https://your-tiktok-service.onrender.com
//                       (deploy tiktok-service/ as its own Render web
//                       service - see README for instructions)

const TIKTOK_SERVICE_URL = (process.env.TIKTOK_SERVICE_URL || '').replace(
  /\/+$/,
  ''
);

const FETCH_TIMEOUT_MS = 4000;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns { live: boolean, viewers: number }
 */
async function getTikTokStatus() {
  if (!TIKTOK_SERVICE_URL) {
    console.error(
      '[tiktok] TIKTOK_SERVICE_URL is not set. Skipping TikTok check.'
    );
    return { live: false, viewers: 0 };
  }

  try {
    const res = await fetchWithTimeout(
      `${TIKTOK_SERVICE_URL}/status`,
      FETCH_TIMEOUT_MS
    );

    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => '');
      console.error(
        `[tiktok] sidecar service returned ${res.status}. Body preview:`,
        bodyPreview.slice(0, 300)
      );
      return { live: false, viewers: 0 };
    }

    const data = await res.json();
    const live = Boolean(data.live);
    const viewers = live ? parseInt(data.viewers, 10) || 0 : 0;

    if (live) {
      console.log(`[tiktok] is LIVE with ${viewers} viewers.`);
    } else {
      console.log('[tiktok] detected as OFFLINE.');
    }

    return { live, viewers };
  } catch (err) {
    console.error('[tiktok] error reaching sidecar service:', err.message);
    return { live: false, viewers: 0 };
  }
}

module.exports = { getStatus: getTikTokStatus };
