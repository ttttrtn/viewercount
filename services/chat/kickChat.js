// Reads live Kick chat.
//
// Kick has no official chat WebSocket in its public OAuth API (that API
// only covers channel/stream metadata - see services/kick.js). Chat is
// delivered through Kick's own Pusher app, the same one kick.com's
// website connects to. Reading it requires no authentication - it's the
// identical public event stream every logged-out viewer's browser
// receives - but it does require a numeric "chatroom_id" for the
// channel, which we resolve from Kick's public channel-lookup endpoint.
//
// KICK_USERNAME    - reused from the viewer-count config, the channel slug.
// KICK_CHATROOM_ID  - optional override. Kick's chatroom-lookup endpoint
//                      sits behind Cloudflare and can occasionally reject
//                      server-side requests; if that happens, look up
//                      "chatroom":{"id": ...} at
//                      https://kick.com/api/v2/channels/<slug> in a
//                      browser and set this env var directly.
//
// The Pusher app key below is the public key Kick's own frontend uses to
// open the chat socket - it is not a secret, it's embedded in every page
// load of kick.com. If Kick ever rotates it, override with
// KICK_PUSHER_APP_KEY.

const WebSocket = require('ws');
const kickBadges = require('./badges/kickBadges');

const DEBUG_BADGES = process.env.DEBUG_BADGES === 'true';

const KICK_USERNAME = (process.env.KICK_USERNAME || '').toLowerCase();
const KICK_CHATROOM_ID_OVERRIDE = process.env.KICK_CHATROOM_ID || '';
const PUSHER_APP_KEY = process.env.KICK_PUSHER_APP_KEY || '32cbd69e4b950bf97679';
const PUSHER_URL = `wss://ws-us2.pusher.com/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const CHATROOM_LOOKUP_RETRY_MS = 30000;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pingInterval = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let chatroomId = null;
let subscriberBadges = [];
let subscriberBadgesLastFetch = 0;
const SUBSCRIBER_BADGES_REFRESH_MS = 6 * 60 * 60 * 1000; // channel's badge art rarely changes

function isConfigured() {
  return Boolean(KICK_USERNAME);
}

async function resolveChatroomId() {
  if (KICK_CHATROOM_ID_OVERRIDE) return KICK_CHATROOM_ID_OVERRIDE;

  try {
    const data = await fetchChannelData();
    const id = data && data.chatroom && data.chatroom.id;

    if (!id) throw new Error('response had no chatroom.id');

    return String(id);
  } catch (err) {
    console.error(
      `[kickChat] could not auto-resolve chatroom id for "${KICK_USERNAME}": ${err.message}. ` +
        'Set KICK_CHATROOM_ID manually (see comment at top of services/chat/kickChat.js) to bypass this lookup.'
    );
    return null;
  }
}

async function fetchChannelData() {
  const res = await fetch(
    `https://kick.com/api/v2/channels/${encodeURIComponent(KICK_USERNAME)}`,
    {
      headers: {
        Accept: 'application/json',
        // A browser-like UA improves the odds of getting past Kick's
        // bot mitigation for this read-only lookup.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    }
  );

  if (!res.ok) {
    throw new Error(`channel lookup returned ${res.status}`);
  }

  const data = await res.json();

  // Real per-channel subscriber badge tiers (months + actual uploaded badge
  // image) - used to resolve real subscriber badge icons. Cached here since
  // it's the same endpoint kickChat.js already hits for chatroom_id.
  if (Array.isArray(data.subscriber_badges)) {
    subscriberBadges = data.subscriber_badges;
    subscriberBadgesLastFetch = Date.now();
  }

  return data;
}

async function refreshSubscriberBadgesIfStale() {
  if (Date.now() - subscriberBadgesLastFetch < SUBSCRIBER_BADGES_REFRESH_MS) return;
  try {
    await fetchChannelData();
  } catch (err) {
    console.error('[kickChat] failed to refresh subscriber badge tiers:', err.message);
  }
}

function scheduleReconnect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  console.log(`[kickChat] reconnecting in ${delay}ms...`);
  reconnectTimer = setTimeout(connect, delay);
}

async function connect() {
  if (stopped) return;

  if (!chatroomId) {
    chatroomId = await resolveChatroomId();
    if (!chatroomId) {
      // Keep retrying the lookup on a slow interval rather than giving up.
      reconnectTimer = setTimeout(connect, CHATROOM_LOOKUP_RETRY_MS);
      return;
    }
  }

  ws = new WebSocket(PUSHER_URL);

  ws.on('open', () => {
    console.log(`[kickChat] Pusher socket open, subscribing to chatroom ${chatroomId}...`);
  });

  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch (_err) {
      return;
    }

    if (parsed.event === 'pusher:connection_established') {
      ws.send(
        JSON.stringify({
          event: 'pusher:subscribe',
          data: { channel: `chatrooms.${chatroomId}.v2` },
        })
      );
      // Kick has used both "chatrooms.<id>" and "chatrooms.<id>.v2" channel
      // names across versions - subscribe to both so a version change on
      // Kick's end doesn't silently break chat.
      ws.send(
        JSON.stringify({
          event: 'pusher:subscribe',
          data: { channel: `chatrooms.${chatroomId}` },
        })
      );

      reconnectAttempt = 0;
      if (onStatusCb) onStatusCb({ connected: true });

      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        }
      }, 30000);
      return;
    }

    if (
      parsed.event === 'App\\Events\\ChatMessageEvent' ||
      parsed.event === 'App\\Events\\ChatMessageSentEvent'
    ) {
      try {
        const payload = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
        const message = payload.message || payload;
        const sender = payload.sender || payload.user || {};
        const rawBadges = (sender.identity && sender.identity.badges) || [];

        if (DEBUG_BADGES && rawBadges.length) {
          console.log(`[kickChat] Raw badges for ${sender.username}: ${JSON.stringify(rawBadges)}`);
        }

        refreshSubscriberBadgesIfStale();

        kickBadges
          .resolveBadges(rawBadges, subscriberBadges)
          .then((badges) => {
            if (onMessageCb) {
              onMessageCb({
                username: sender.username || 'unknown',
                message: message.message || message.content || '',
                color: (sender.identity && sender.identity.color) || null,
                timestamp: Math.floor(Date.now() / 1000),
                badges,
              });
            }
          })
          .catch((err) => {
            console.error('[kickChat] badge resolution error:', err.message);
            if (onMessageCb) {
              onMessageCb({
                username: sender.username || 'unknown',
                message: message.message || message.content || '',
                color: (sender.identity && sender.identity.color) || null,
                timestamp: Math.floor(Date.now() / 1000),
                badges: [],
              });
            }
          });
      } catch (err) {
        console.error('[kickChat] failed to parse chat message payload:', err.message);
      }
    }
  });

  ws.on('close', () => {
    console.log('[kickChat] connection closed.');
    clearInterval(pingInterval);
    if (onStatusCb) onStatusCb({ connected: false });
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[kickChat] error:', err.message);
  });
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;
  chatroomId = null;

  if (!KICK_USERNAME) {
    console.error('[kickChat] KICK_USERNAME is not set. Skipping Kick chat.');
    return;
  }

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
