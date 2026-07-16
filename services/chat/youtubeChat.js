const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";
// Optional: if set, skips channel lookup and connects directly to this video's chat.
const YOUTUBE_VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || "";

let innertubeClient = null;
let liveChat = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let watchdogTimer = null;
let lastMessageTime = Date.now();
const seenMessages = new Set();
const WATCHDOG_INTERVAL = 60000;

function isConfigured() {
    return Boolean(YOUTUBE_VIDEO_ID) || Boolean(YOUTUBE_CHANNEL_ID);
}

async function getClient() {
    if (!innertubeClient) innertubeClient = await Innertube.create();
    return innertubeClient;
}

// Resolves the current live video ID for a channel using Innertube only -
// no official Data API / API key required. Tries a few known access
// patterns since youtubei.js's channel-tab shape has changed across
// versions (it mirrors YouTube's internal API, not a stable contract).
async function resolveLiveVideoId() {
    if (!YOUTUBE_CHANNEL_ID) return null;
    try {
        const youtube = await getClient();
        const channel = await youtube.getChannel(YOUTUBE_CHANNEL_ID);

        let candidates = [];

        // Pattern 1: dedicated "Live" tab, if the installed version exposes it.
        if (typeof channel.getLiveStreams === "function") {
            try {
                const liveTab = await channel.getLiveStreams();
                candidates = liveTab?.videos || liveTab?.items || [];
            } catch (e) {
                console.warn("[youtubeChat] getLiveStreams() failed, falling back:", e.message);
            }
        }

        // Pattern 2: fall back to the channel's default video list and
        // filter for whichever entries are flagged as currently live.
        if (!candidates.length) {
            const videosTab = typeof channel.getVideos === "function"
                ? await channel.getVideos()
                : null;
            candidates = videosTab?.videos || videosTab?.items || channel?.videos || [];
        }

        const liveVideo = candidates.find(
            (v) => v?.is_live === true || v?.isLiveNow === true || v?.is_live_now === true || v?.badges?.some?.((b) => /live now/i.test(b?.label || ""))
        );

        const videoId = liveVideo?.id || liveVideo?.video_id || liveVideo?.videoId || null;
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
        console.warn("[youtubeChat] Not configured (missing YOUTUBE_VIDEO_ID or YOUTUBE_CHANNEL_ID) - skipping.");
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

        const youtube = await getClient();
        const info = await youtube.getInfo(videoId);
        liveChat = await info.getLiveChat();

        if (!liveChat) throw new Error("No live chat found for resolved video");

        onStatusCb?.({ connected: true, live: true });

        liveChat.on("chat-update", (data) => {
            if (data?.actions) {
                lastMessageTime = Date.now();
                for (const action of data.actions) parseAction(action);
            }
        });

        liveChat.on("end", () => {
            onStatusCb?.({ connected: false, live: false });
            if (!stopped) safeRetry(() => start(onMessageCb, onStatusCb), 5000);
        });

        await liveChat.start();
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
