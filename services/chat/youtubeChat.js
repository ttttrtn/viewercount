const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";
// Optional: if set, skips discovery entirely and connects directly to this video's chat.
const YOUTUBE_VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || "";
const DEBUG = process.env.DEBUG_YOUTUBE === "true";

let innertubeClient = null;
let liveChat = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let watchdogTimer = null;
let lastMessageTime = Date.now();
const seenMessages = new Set();
const WATCHDOG_INTERVAL = 60000;

function debugLog(...args) {
    if (DEBUG) console.log("[youtubeChat] [debug]", ...args);
}

function isConfigured() {
    return Boolean(YOUTUBE_VIDEO_ID) || Boolean(YOUTUBE_API_KEY && YOUTUBE_CHANNEL_ID);
}

async function getClient() {
    if (!innertubeClient) innertubeClient = await Innertube.create();
    return innertubeClient;
}

// Resolves the current live video ID via the official Data API. This is the
// one place we spend quota (a single search.list call, ~100 units) because
// Innertube's unofficial channel-live detection proved unreliable in
// practice (false negatives even while confirmed live via the official API).
// Everything after this - reading chat itself - stays on Innertube, no key
// needed for that part.
async function resolveLiveVideoId() {
    if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) return null;
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&eventType=live&type=video&order=date&maxResults=1&key=${YOUTUBE_API_KEY}`;
        debugLog("Requesting search.list:", url.replace(YOUTUBE_API_KEY, "REDACTED"));
        const res = await fetch(url);
        debugLog(`search.list responded with HTTP ${res.status}`);
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            console.error(`[youtubeChat] YouTube API error ${res.status}: ${text}`);
            return null;
        }
        const data = await res.json();
        const videoId = data.items?.[0]?.id?.videoId || null;
        debugLog(`search.list items found: ${data.items?.length ?? 0} videoId: ${videoId}`);
        if (!videoId) {
            console.warn("[youtubeChat] No live broadcast found for channel right now.");
        }
        return videoId;
    } catch (err) {
        console.error("[youtubeChat] resolveLiveVideoId error:", err.message);
        return null;
    }
}

function safeRetry(fn, delayMs) {
    const ms = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 5000;
    setTimeout(fn, ms);
}

async function start(onMessage, onStatus) {
    onMessageCb = onMessage;
    onStatusCb = onStatus;
    stopped = false;
    lastMessageTime = Date.now();
    resetWatchdog();

    if (!isConfigured()) {
        console.warn("[youtubeChat] Not configured (missing YOUTUBE_VIDEO_ID or YOUTUBE_API_KEY/YOUTUBE_CHANNEL_ID) - skipping.");
        onStatusCb?.({ connected: false, live: false });
        return;
    }

    try {
        const videoId = YOUTUBE_VIDEO_ID || await resolveLiveVideoId();

        if (!videoId) {
            onStatusCb?.({ connected: false, live: false });
            if (!stopped) safeRetry(() => start(onMessageCb, onStatusCb), 15000);
            return;
        }

        debugLog(`Connecting chat for videoId: ${videoId}`);
        const youtube = await getClient();
        const info = await youtube.getInfo(videoId);
        debugLog(`getInfo(${videoId}) resolved. Fetching live chat handle...`);
        liveChat = await info.getLiveChat();

        if (!liveChat) throw new Error("No live chat found for resolved video");

        debugLog("Live chat handle acquired, starting listener.");
        onStatusCb?.({ connected: true, live: true });

        liveChat.on("chat-update", (data) => {
            debugLog(`chat-update received, actions: ${data?.actions?.length ?? 0}`);
            if (data?.actions) {
                lastMessageTime = Date.now();
                for (const action of data.actions) parseAction(action);
            }
        });

        liveChat.on("end", () => {
            debugLog("liveChat 'end' event fired.");
            onStatusCb?.({ connected: false, live: false });
            if (!stopped) safeRetry(() => start(onMessageCb, onStatusCb), 5000);
        });

        await liveChat.start();
        debugLog("liveChat.start() resolved - listener is active.");
    } catch (err) {
        console.error("[youtubeChat] Start error:", err.message);
        onStatusCb?.({ connected: false, live: false });
        if (!stopped) safeRetry(() => start(onMessageCb, onStatusCb), 10000);
    }
}

function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
        if (!stopped && Date.now() - lastMessageTime > WATCHDOG_INTERVAL) {
            console.warn("[youtubeChat] Watchdog: No messages, reconnecting...");
            stop();
            safeRetry(() => start(onMessageCb, onStatusCb), 2000);
        } else {
            resetWatchdog();
        }
    }, WATCHDOG_INTERVAL);
}

async function parseAction(action) {
    const item =
        action.item ||
        action.addChatItemAction?.item ||
        action.replayChatItemAction?.actions?.[0]?.addChatItemAction?.item;

    const renderer =
        item?.liveChatTextMessageRenderer ||
        item?.liveChatPaidMessageRenderer ||
        item?.liveChatMembershipItemRenderer;

    if (!renderer) return;

    const username =
        renderer.authorName?.simpleText ||
        renderer.authorName?.runs?.map((x) => x.text).join("") ||
        "Unknown";

    const message =
        renderer.message?.runs?.map((x) => x.text || (x.emoji ? "ð" : "")).join("") || "";

    if (!message) return;

    const id = renderer.id || `${username}:${message}`;
    if (seenMessages.has(id)) return;
    seenMessages.add(id);
    if (seenMessages.size > 2000) seenMessages.clear();

    onMessageCb?.({
        username,
        message,
        badges: await youtubeBadges.resolveBadges(renderer.authorBadges || []),
        color: null,
        timestamp: Math.floor(Date.now() / 1000),
        type: renderer.purchaseAmountText ? "superchat" : "message",
        amount: renderer.purchaseAmountText?.simpleText || null,
    });
}

function stop() {
    stopped = true;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (liveChat) {
        try {
            liveChat.stop();
        } catch (e) {}
    }
}

module.exports = { start, stop, isConfigured };
