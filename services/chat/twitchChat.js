// Reads live Twitch chat over Twitch IRC (WebSocket transport).
//
// Twitch allows fully anonymous, read-only IRC connections using a
// "justinfan#####" login and no password - this is the same mechanism
// browser-based chat readers use, and it still receives the `tags`
// capability (username display color, badges, etc.) because those are
// public per-message metadata, not account-specific data. So no
// TWITCH_CLIENT_ID/SECRET/OAuth token is required just to *read* chat
// (only the existing viewer-count service needs those, for Helix).
//
// TWITCH_USERNAME (already defined for the viewer-count service) is
// reused here as the channel to join.

const WebSocket = require('ws');
const twitchBadges = require('./badges/twitchBadges');
const badgeCache = require('./badges/badgeCache');

const DEBUG_BADGES = process.env.DEBUG_BADGES === 'true';

const TWITCH_USERNAME = (process.env.TWITCH_USERNAME || '').toLowerCase();
const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pingInterval = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;

function isConfigured() {
  return Boolean(TWITCH_USERNAME);
}

function parseTags(tagString) {
  const tags = {};
  if (!tagString) return tags;
  tagString
    .replace(/^@/, '')
    .split(';')
    .forEach((pair) => {
      const [key, value = ''] = pair.split('=');
      tags[key] = value.replace(/\\s/g, ' ');
    });
  return tags;
}

function parsePrivmsg(line) {
  // Example:
  // @badge-info=;color=#9146FF;display-name=User123;badges=moderator/1,subscriber/12;...  :user123!user123@user123.tmi.twitch.tv PRIVMSG #channel :Hello!
  let tagString = '';
  let rest = line;

  if (line.startsWith('@')) {
    const spaceIdx = line.indexOf(' ');
    tagString = line.slice(0, spaceIdx);
    rest = line.slice(spaceIdx + 1);
  }

  const privmsgMatch = rest.match(/^:(\S+)!\S+ PRIVMSG #\S+ :(.*)$/);
  if (!privmsgMatch) return null;

  const tags = parseTags(tagString);
  const loginName = privmsgMatch[1];
  const message = privmsgMatch[2];

  return {
    username: tags['display-name'] || loginName,
    message,
    color: tags.color || null,
    timestamp: Math.floor(Date.now() / 1000),
    rawBadges: tags.badges || '', // e.g. "moderator/1,subscriber/12" - resolved async below
  };
}

// Turns the raw "set/version,set/version" IRC badges tag into real,
// resolved badge objects using Twitch's own Helix badge metadata (no
// hardcoded/guessed titles or assets).
async function resolveBadges(rawBadges) {
  if (!rawBadges) return [];

  const pairs = rawBadges
    .split(',')
    .map((pair) => pair.split('/'))
    .filter(([setId, versionId]) => setId && versionId);

  const resolved = await Promise.all(
    pairs.map(async ([setId, versionId]) => {
      const meta = await twitchBadges.resolveBadge(setId, versionId);
      if (!meta) return null;

      const icon = await badgeCache.ensureCached('twitch', setId, versionId, meta.imageUrl);

      return {
        id: setId,
        name: meta.name,
        platform: 'twitch',
        version: versionId,
        icon: icon || undefined,
      };
    })
  );

  const badges = resolved.filter(Boolean);

  if (DEBUG_BADGES) {
    console.log(`[twitchChat] Raw badges: ${rawBadges}`);
    console.log(`[twitchChat] Parsed: ${badges.map((b) => b.name).join(', ') || '(none)'}`);
  }

  return badges;
}

function scheduleReconnect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  console.log(`[twitchChat] reconnecting in ${delay}ms...`);
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  if (stopped || !TWITCH_USERNAME) return;

  const randomSuffix = Math.floor(Math.random() * 90000) + 10000;
  const anonymousNick = `justinfan${randomSuffix}`;

  ws = new WebSocket(IRC_URL);

  ws.on('open', () => {
    console.log('[twitchChat] connected, joining channel...');
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE'); // ignored for anonymous logins, but harmless
    ws.send(`NICK ${anonymousNick}`);
    ws.send(`JOIN #${TWITCH_USERNAME}`);

    reconnectAttempt = 0;
    if (onStatusCb) onStatusCb({ connected: true });

    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send('PING :keepalive');
    }, 4 * 60 * 1000);
  });

  ws.on('message', (data) => {
    const text = data.toString();
    text.split('\r\n').forEach((line) => {
      if (!line) return;

      if (line.startsWith('PING')) {
        ws.send('PONG :tmi.twitch.tv');
        return;
      }

      if (line.includes('PRIVMSG')) {
        const parsed = parsePrivmsg(line);
        if (!parsed || !onMessageCb) return;

        const { rawBadges, ...base } = parsed;
        resolveBadges(rawBadges)
          .then((badges) => onMessageCb({ ...base, badges }))
          .catch((err) => {
            console.error('[twitchChat] badge resolution error:', err.message);
            onMessageCb({ ...base, badges: [] });
          });
      }
    });
  });

  ws.on('close', () => {
    console.log('[twitchChat] connection closed.');
    clearInterval(pingInterval);
    if (onStatusCb) onStatusCb({ connected: false });
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[twitchChat] error:', err.message);
  });
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!TWITCH_USERNAME) {
    console.error('[twitchChat] TWITCH_USERNAME is not set. Skipping Twitch chat.');
    return;
  }

  twitchBadges.ensureLoaded();
  twitchBadges.startAutoRefresh();

  connect();
}

function stop() {
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingInterval);
  if (ws) {
    try {
      ws.close();
    } catch (_err) {
      /* noop */
    }
  }
}

module.exports = { start, stop, isConfigured };
