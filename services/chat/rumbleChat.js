// Reads Rumble live chat.
// Filters out specific spam domains/links.

const RUMBLE_API_URL = process.env.RUMBLE_API_URL || '';
const RUMBLE_API_KEY = process.env.RUMBLE_API_KEY || '';
const RUMBLE_CHANNEL = process.env.RUMBLE_CHANNEL || '';

const POLL_INTERVAL_MS = 15000;
const MAX_BACKOFF_MS = 2 * 60 * 1000;
const SEEN_ID_CACHE_SIZE = 300;

// Regex to match the specified spam messages
const SPAM_PATTERN = /casinohunters\.cc|discord\.gg\/casinohunters/i;

let pollTimer = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let backoffMs = 0;
let lastLive = null;
const seenMessageIds = new Set();
const seenOrder = [];

function isConfigured() {
  return Boolean(RUMBLE_API_URL);
}

function markSeen(id) {
  seenMessageIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > SEEN_ID_CACHE_SIZE) {
    const oldest = seenOrder.shift();
    seenMessageIds.delete(oldest);
  }
}

function pickLivestream(data) {
  const streams = Array.isArray(data.livestreams) ? data.livestreams : [];
  if (streams.length === 0) return null;

  if (RUMBLE_CHANNEL) {
    const matched = streams.find((s) => String(s.channel_id) === String(RUMBLE_CHANNEL));
    if (matched) return matched;
  }

  return streams.find((s) => s.is_live) || null;
}

function extractMessages(stream) {
  if (!stream) return [];

  const candidates = [
    stream.chat && stream.chat.recent_messages,
    stream.chat && stream.chat.messages,
    stream.chat_messages,
    stream.recent_chat_messages,
    stream.chat,
  ];

  const found = candidates.find((c) => Array.isArray(c));
  return found || [];
}

async function pollOnce() {
  if (!RUMBLE_API_URL) return;

  try {
    const headers = { Accept: 'application/json' };
    if (RUMBLE_API_KEY) headers.Authorization = `Bearer ${RUMBLE_API_KEY}`;

    const res = await fetch(RUMBLE_API_URL, { headers });

    if (!res.ok) {
      throw new Error(`API returned ${res.status}`);
    }

    const data = await res.json();
    const stream = pickLivestream(data);
    const live = Boolean(stream);

    if (live !== lastLive) {
      lastLive = live;
      if (onStatusCb) onStatusCb({ connected: true, live });
    }

    backoffMs = 0;

    const messages = extractMessages(stream);
    messages.forEach((m) => {
      const id = m.id || m.message_id || `${m.username}-${m.created_on || m.timestamp}-${m.text || m.message}`;
      if (seenMessageIds.has(id)) return;
      
      const text = m.text || m.message || '';
      
      // Filter out spam
      if (SPAM_PATTERN.test(text)) {
        markSeen(id); // Mark as seen so we don't re-process it
        return;
      }

      markSeen(id);

      if (onMessageCb) {
        const createdAt = m.created_on ? Date.parse(m.created_on) : null;
        onMessageCb({
          username: m.username || m.user || 'unknown',
          message: text || (m.rant ? `[Rant] ${m.text || ''}` : ''),
          color: null,
          timestamp: createdAt ? Math.floor(createdAt / 1000) : Math.floor(Date.now() / 1000),
        });
      }
    });
  } catch (err) {
    console.error('[rumbleChat] error:', err.message);
    if (lastLive !== false) {
      lastLive = false;
      if (onStatusCb) onStatusCb({ connected: false, live: false });
    }
    backoffMs = backoffMs === 0 ? POLL_INTERVAL_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  } finally {
    if (!stopped) {
      pollTimer = setTimeout(pollOnce, Math.max(POLL_INTERVAL_MS, backoffMs));
    }
  }
}

function start(onMessage, onStatus) {
  onMessageCb = onMessage;
  onStatusCb = onStatus;
  stopped = false;

  if (!RUMBLE_API_URL) {
    console.error('[rumbleChat] RUMBLE_API_URL is not set. Skipping Rumble chat.');
    return;
  }

  pollOnce();
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
}

module.exports = { start, stop, isConfigured };
