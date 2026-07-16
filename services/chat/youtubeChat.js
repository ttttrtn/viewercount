// YouTube live chat via the Python sidecar.
//
// Environment variables:
//
// YOUTUBE_VIDEO_ID         - Current YouTube Live video ID
//                            Example: sNnMeQsXXXk
//
// YOUTUBE_CHAT_SERVICE_URL - Base URL of the deployed sidecar
//                            Example:
//                            https://yt-56tm.onrender.com

const youtubeBadges = require('./badges/youtubeBadges');

const YOUTUBE_VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || '';
const YOUTUBE_CHAT_SERVICE_URL = (
  process.env.YOUTUBE_CHAT_SERVICE_URL || ''
).replace(/\/+$/, '');

const POLL_INTERVAL_MS = 4000;
const FETCH_TIMEOUT_MS = 4000;

let pollTimer = null;
let stopped = false;

let onMessageCb = null;
let onStatusCb = null;

let lastConnected = null;

// Prevent duplicate messages
const seenMessages = new Set();

function isConfigured() {
  return Boolean(
    YOUTUBE_VIDEO_ID &&
    YOUTUBE_CHAT_SERVICE_URL
  );
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function pollOnce() {

  try {

    const res = await fetchWithTimeout(
      `${YOUTUBE_CHAT_SERVICE_URL}/chat?video_id=${encodeURIComponent(YOUTUBE_VIDEO_ID)}`,
      FETCH_TIMEOUT_MS
    );

    if (!res.ok) {
      throw new Error(`Sidecar returned ${res.status}`);
    }

    const data = await res.json();

    const connected = Boolean(data.live);

    if (connected !== lastConnected) {
      lastConnected = connected;

      if (onStatusCb) {
        onStatusCb({
          connected,
          live: connected
        });
      }
    }

    const messages = Array.isArray(data.messages)
      ? data.messages
      : [];

    for (const m of messages) {

      const id =
        m.id ||
        `${m.author}:${m.timestamp}:${m.message}`;

      if (seenMessages.has(id)) {
        continue;
      }

      seenMessages.add(id);

      if (seenMessages.size > 1000) {
        seenMessages.clear();
      }

      const base = {
        username: m.author || "Unknown",
        message: m.message || "",
        color: null,
        timestamp: m.timestamp
          ? Math.floor(
              m.timestamp /
                (m.timestamp > 1e12 ? 1000 : 1)
            )
          : Math.floor(Date.now() / 1000)
      };

      try {

        const badges =
          await youtubeBadges.resolveBadges(
            m.badges
          );

        onMessageCb?.({
          ...base,
          badges
        });

      } catch (err) {

        console.error(
          "[youtubeChat] Badge error:",
          err.message
        );

        onMessageCb?.({
          ...base,
          badges: []
        });
      }
    }

  } catch (err) {

    if (lastConnected !== false) {

      lastConnected = false;

      onStatusCb?.({
        connected: false,
        live: false
      });
    }

    console.error(
      "[youtubeChat]",
      err.message
    );

  } finally {

    if (!stopped) {
      pollTimer = setTimeout(
        pollOnce,
        POLL_INTERVAL_MS
      );
    }
  }
}

function start(onMessage, onStatus) {

  onMessageCb = onMessage;
  onStatusCb = onStatus;

  stopped = false;

  if (!YOUTUBE_VIDEO_ID) {

    console.error(
      "[youtubeChat] Missing YOUTUBE_VIDEO_ID."
    );

    return;
  }

  if (!YOUTUBE_CHAT_SERVICE_URL) {

    console.error(
      "[youtubeChat] Missing YOUTUBE_CHAT_SERVICE_URL."
    );

    return;
  }

  console.log(
    `[youtubeChat] Watching video ${YOUTUBE_VIDEO_ID}`
  );

  pollOnce();
}

function stop() {

  stopped = true;

  clearTimeout(pollTimer);
}

module.exports = {
  start,
  stop,
  isConfigured
};
