require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_USERNAME = (process.env.TWITCH_USERNAME || '').toLowerCase();
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const KICK_USERNAME = (process.env.KICK_USERNAME || '').toLowerCase();

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

// ---------- Kick OAuth token cache (official public API) ----------
let kickToken = null;
let kickTokenExpiresAt = 0; // epoch ms

async function getKickToken() {
  const now = Date.now();

  // Reuse cached token if still valid (with 60s safety margin)
  if (kickToken && now < kickTokenExpiresAt - 60000) {
    return kickToken;
  }

  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
    throw new Error('Missing Kick credentials');
  }

  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kick token request failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  kickToken = data.access_token;
  kickTokenExpiresAt = now + data.expires_in * 1000;

  return kickToken;
}

async function fetchKickChannel(token) {
  return fetch(
    `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(
      KICK_USERNAME
    )}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }
  );
}

async function getKickViewers() {
  try {
    if (!KICK_USERNAME) {
      console.error(
        'KICK_USERNAME is not set (empty string). Skipping Kick check.'
      );
      return { viewers: 0, live: false };
    }

    if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
      console.error(
        'KICK_CLIENT_ID / KICK_CLIENT_SECRET not set. Skipping Kick check.'
      );
      return { viewers: 0, live: false };
    }

    const token = await getKickToken();
    let res = await fetchKickChannel(token);

    if (res.status === 401) {
      // Token invalid/expired unexpectedly - force refresh once
      kickToken = null;
      kickTokenExpiresAt = 0;
      const freshToken = await getKickToken();
      res = await fetchKickChannel(freshToken);
    }

    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => '');
      console.error(
        `Kick API returned ${res.status} for "${KICK_USERNAME}". Body preview:`,
        bodyPreview.slice(0, 300)
      );
      return { viewers: 0, live: false };
    }

    const json = await res.json();
    const channel = json.data && json.data[0];
    const stream = channel && channel.stream;

    if (stream && stream.is_live) {
      console.log(
        `Kick: "${KICK_USERNAME}" is LIVE with ${stream.viewer_count} viewers.`
      );
      return { viewers: stream.viewer_count || 0, live: true };
    }

    console.log(`Kick: "${KICK_USERNAME}" detected as OFFLINE.`);
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
  console.log('--- Config check ---');
  console.log('TWITCH_CLIENT_ID set:', Boolean(TWITCH_CLIENT_ID));
  console.log('TWITCH_CLIENT_SECRET set:', Boolean(TWITCH_CLIENT_SECRET));
  console.log('TWITCH_USERNAME:', TWITCH_USERNAME || '(empty)');
  console.log('KICK_CLIENT_ID set:', Boolean(KICK_CLIENT_ID));
  console.log('KICK_CLIENT_SECRET set:', Boolean(KICK_CLIENT_SECRET));
  console.log('KICK_USERNAME:', KICK_USERNAME || '(empty)');
  console.log('---------------------');
});
