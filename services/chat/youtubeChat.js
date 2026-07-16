const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const YOUTUBE_VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || "";
let liveChat = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let watchdogTimer = null;
let lastMessageTime = Date.now();
const seenMessages = new Set();
const WATCHDOG_INTERVAL = 60000;

function isConfigured() { return Boolean(YOUTUBE_VIDEO_ID); }

async function start(onMessage, onStatus) {
    onMessageCb = onMessage;
    onStatusCb = onStatus;
    stopped = false;
    lastMessageTime = Date.now();
    resetWatchdog();

    try {
        const youtube = await Innertube.create();
        const info = await youtube.getInfo(YOUTUBE_VIDEO_ID);
        liveChat = await info.getLiveChat();

        if (!liveChat) throw new Error("No live chat found");

        onStatusCb?.({ connected: true, live: true });
        
        liveChat.on("chat-update", (data) => {
            if (data?.actions) {
                lastMessageTime = Date.now();
                for (const action of data.actions) parseAction(action);
            }
        });

        liveChat.on("end", () => {
            onStatusCb?.({ connected: false, live: false });
            if (!stopped) setTimeout(() => start(onMessageCb, onStatusCb), 5000);
        });

        await liveChat.start();
    } catch (err) {
        console.error("[youtubeChat] Start error:", err.message);
        onStatusCb?.({ connected: false, live: false });
    }
}

function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(async () => {
        if (!stopped && Date.now() - lastMessageTime > WATCHDOG_INTERVAL) {
            console.warn("[youtubeChat] Watchdog: No messages, reconnecting...");
            stop();
            setTimeout(() => start(onMessageCb, onStatusCb), 2000);
        } else {
            resetWatchdog();
        }
    }, WATCHDOG_INTERVAL);
}

async function parseAction(action) {
    const item = action.item || action.addChatItemAction?.item || action.replayChatItemAction?.actions?.[0]?.addChatItemAction?.item;
    const renderer = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer || item?.liveChatMembershipItemRenderer;
    if (!renderer) return;

    const username = renderer.authorName?.simpleText || renderer.authorName?.runs?.map(x => x.text).join("") || "Unknown";
    const message = renderer.message?.runs?.map(x => x.text || (x.emoji ? "😀" : "")).join("") || "";
    if (!message) return;

    const id = renderer.id || `${username}:${message}`;
    if (seenMessages.has(id)) return;
    seenMessages.add(id);
    if (seenMessages.size > 2000) seenMessages.clear();

    onMessageCb?.({
        username, message, badges: await youtubeBadges.resolveBadges(renderer.authorBadges || []),
        color: null, timestamp: Math.floor(Date.now() / 1000),
        type: renderer.purchaseAmountText ? "superchat" : "message",
        amount: renderer.purchaseAmountText?.simpleText || null
    });
}

function stop() {
    stopped = true;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (liveChat) { try { liveChat.stop(); } catch (e) {} }
}

module.exports = { start, stop, isConfigured };
