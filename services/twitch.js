const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_USERNAME = (process.env.TWITCH_USERNAME || '').toLowerCase();

let twitchToken = null;
let twitchTokenExpiresAt = 0; // epoch ms

async function getTwitchToken() {
  const now = Date.now();

  if (twitchToken && now < twitchTokenExpiresAt - 60000) {
    return twitchToken;
  }

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error('Missing Twitch credentials');
  }

  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(
    TWITCH_CLIENT_ID
  )}&client_secret=${encodeURIComponent(
    TWITCH_CLIENT_SECRET
  )}&grant_type=client_credentials`;

  const res = await fetch(url, { method: 'POST' });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Twitch token request failed: ${res.status} ${body.slice(0, 200)}`
    );
  }

  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpiresAt = now + data.expires_in * 1000;

  return twitchToken;
}

async function fetchTwitchStream(token) {
  return fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(
      TWITCH_USERNAME
    )}`,
    {
      headers: {
        'Client-Id': TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

/**
 * Returns { live: boolean, viewers: number }
 * Every platform service in this project exposes this same shape,
 * so viewerManager.js can treat them interchangeably.
 */
async function getTwitchStatus() {
  try {
    if (!TWITCH_USERNAME) {
      console.error(
        '[twitch] TWITCH_USERNAME is not set. Skipping Twitch check.'
      );
      return { live: false, viewers: 0 };
    }

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
      console.error(
        '[twitch] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set. Skipping Twitch check.'
      );
      return { live: false, viewers: 0 };
    }

    const token = await getTwitchToken();
    let res = await fetchTwitchStream(token);

    if (res.status === 401) {
      console.error('[twitch] API returned 401. Forcing token refresh.');
      twitchToken = null;
      twitchTokenExpiresAt = 0;
      const freshToken = await getTwitchToken();
      res = await fetchTwitchStream(freshToken);
    }

    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => '');
      console.error(
        `[twitch] API returned ${res.status} for "${TWITCH_USERNAME}". Body preview:`,
        bodyPreview.slice(0, 300)
      );
      return { live: false, viewers: 0 };
    }

    const data = await res.json();
    const stream = data.data && data.data[0];

    if (stream) {
      console.log(
        `[twitch] "${TWITCH_USERNAME}" is LIVE with ${stream.viewer_count} viewers.`
      );
      return { live: true, viewers: stream.viewer_count };
    }

    console.log(`[twitch] "${TWITCH_USERNAME}" detected as OFFLINE.`);
    return { live: false, viewers: 0 };
  } catch (err) {
    console.error('[twitch] error:', err.message);
    return { live: false, viewers: 0 };
  }
}

module.exports = { getStatus: getTwitchStatus };
