require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_USERNAME = (process.env.TWITCH_USERNAME || '').toLowerCase();
const KICK_USERNAME = process.env.KICK_USERNAME || '';

// ---------- Twitch OAuth token cache ----------
let twitchToken = null;
let twitchTokenExpiresAt = 0; // epoch ms

async function getTwitchToken() {
  const now = Date.now();

  // Reuse cached token if still valid (with 60s safety margin)
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
    throw new Error(`Twitch token request failed: ${res.status}`);
  }

  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpiresAt = now + data.expires_in * 1000;

  return twitchToken;
}

async function getTwitchViewers() {
  try {
    if (!TWITCH_USERNAME) return { viewers: 0, live: false };

    const token = await getTwitchToken();

    const res = await fetch(
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

    if (res.status === 401) {
      // Token invalid/expired unexpectedly - force refresh once
      twitchToken = null;
      twitchTokenExpiresAt = 0;
      const freshToken = await getTwitchToken();
      const retry = await fetch(
        `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(
          TWITCH_USERNAME
        )}`,
        {
          headers: {
            'Client-Id': TWITCH_CLIENT_ID,
            Authorization: `Bearer ${freshToken}`,
          },
        }
      );
      if (!retry.ok) return { viewers: 0, live: false };
      const retryData = await retry.json();
      const stream = retryData.data && retryData.data[0];
      return stream
        ? { viewers: stream.viewer_count, live: true }
        : { viewers: 0, live: false };
    }

    if (!res.ok) return { viewers: 0, live: false };

    const data = await res.json();
    const stream = data.data && data.data[0];
    return stream
      ? { viewers: stream.viewer_count, live: true }
      : { viewers: 0, live: false };
  } catch (err) {
    console.error('Twitch error:', err.message);
    return { viewers: 0, live: false };
  }
}

// ---------- Kick integration ----------
async function getKickViewers() {
  try {
    if (!KICK_USERNAME) return { viewers: 0, live: false };

    const res = await fetch(
      `https://kick.com/api/v2/channels/${encodeURIComponent(KICK_USERNAME)}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      }
    );

    if (!res.ok) return { viewers: 0, live: false };

    const data = await res.json();

    if (data && data.livestream && data.livestream.is_live) {
      return { viewers: data.livestream.viewer_count || 0, live: true };
    }

    return { viewers: 0, live: false };
  } catch (err) {
    console.error('Kick error:', err.message);
    return { viewers: 0, live: false };
  }
}

// ---------- Server-side cache for /api/viewers ----------
const CACHE_TTL_MS = 5000; // 5 second refresh interval
let cachedResult = {
  twitch: 0,
  kick: 0,
  total: 0,
  twitchLive: false,
  kickLive: false,
};
let cachedAt = 0;
let inFlight = null;

async function fetchViewerCounts() {
  const [twitchResult, kickResult] = await Promise.all([
    getTwitchViewers(),
    getKickViewers(),
  ]);

  return {
    twitch: twitchResult.viewers,
    kick: kickResult.viewers,
    total: twitchResult.viewers + kickResult.viewers,
    twitchLive: twitchResult.live,
    kickLive: kickResult.live,
  };
}

async function getViewerCounts() {
  const now = Date.now();

  if (now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchViewerCounts()
    .then((result) => {
      cachedResult = result;
      cachedAt = Date.now();
      inFlight = null;
      return result;
    })
    .catch((err) => {
      console.error('Viewer fetch error:', err.message);
      inFlight = null;
      return cachedResult;
    });

  return inFlight;
}

// ---------- Routes ----------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/viewers', async (req, res) => {
  try {
    const counts = await getViewerCounts();
    res.set('Cache-Control', 'no-store');
    res.json(counts);
  } catch (err) {
    console.error('API error:', err.message);
    res.json({
      twitch: 0,
      kick: 0,
      total: 0,
      twitchLive: false,
      kickLive: false,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Viewer counter overlay running on port ${PORT}`);
});
