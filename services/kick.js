const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const KICK_USERNAME = (process.env.KICK_USERNAME || '').toLowerCase();

let kickToken = null;
let kickTokenExpiresAt = 0; // epoch ms

async function getKickToken() {
  const now = Date.now();

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
    throw new Error(
      `Kick token request failed: ${res.status} ${body.slice(0, 200)}`
    );
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

/**
 * Returns { live: boolean, viewers: number }
 */
async function getKickStatus() {
  try {
    if (!KICK_USERNAME) {
      console.error('[kick] KICK_USERNAME is not set. Skipping Kick check.');
      return { live: false, viewers: 0 };
    }

    if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
      console.error(
        '[kick] KICK_CLIENT_ID / KICK_CLIENT_SECRET not set. Skipping Kick check.'
      );
      return { live: false, viewers: 0 };
    }

    const token = await getKickToken();
    let res = await fetchKickChannel(token);

    if (res.status === 401) {
      kickToken = null;
      kickTokenExpiresAt = 0;
      const freshToken = await getKickToken();
      res = await fetchKickChannel(freshToken);
    }

    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => '');
      console.error(
        `[kick] API returned ${res.status} for "${KICK_USERNAME}". Body preview:`,
        bodyPreview.slice(0, 300)
      );
      return { live: false, viewers: 0 };
    }

    const json = await res.json();
    const channel = json.data && json.data[0];
    const stream = channel && channel.stream;

    if (stream && stream.is_live) {
      console.log(
        `[kick] "${KICK_USERNAME}" is LIVE with ${stream.viewer_count} viewers.`
      );
      return { live: true, viewers: stream.viewer_count || 0 };
    }

    console.log(`[kick] "${KICK_USERNAME}" detected as OFFLINE.`);
    return { live: false, viewers: 0 };
  } catch (err) {
    console.error('[kick] error:', err.message);
    return { live: false, viewers: 0 };
  }
}

module.exports = { getStatus: getKickStatus };
