const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const YOUTUBE_STREAMS_URL =
    "https://www.youtube.com/@RealMalikGPT/streams";

const YOUTUBE_API_KEY =
    process.env.YOUTUBE_API_KEY || "";

const YOUTUBE_CHANNEL_ID =
    process.env.YOUTUBE_CHANNEL_ID || "";

const YOUTUBE_VIDEO_ID =
    process.env.YOUTUBE_VIDEO_ID || "";

const YOUTUBE_VIDEO_ID_2 =
    process.env.YOUTUBE_VIDEO_ID_2 || "";

const DEBUG =
    process.env.DEBUG_YOUTUBE === "true";

const REQUEST_TIMEOUT = 15000;
const CHAT_RETRY_ATTEMPTS = 4;
const CHAT_RETRY_DELAY = 5000;
const RECONNECT_DELAY = 10000;
const WATCHDOG_INTERVAL = 5 * 60 * 1000;

let innertubeClient = null;
let liveChat = null;

let stopped = true;
let starting = false;

let currentVideoId = null;

let onMessageCb = null;
let onStatusCb = null;

let reconnectTimer = null;
let watchdogTimer = null;

let lastMessageTime = 0;

const seenMessages = new Set();

/* =========================================================
   LOGGING
========================================================= */

function debugLog(...args) {
    if (DEBUG) {
        console.log(
            "[youtubeChat][debug]",
            ...args
        );
    }
}

function log(...args) {
    console.log(
        "[youtubeChat]",
        ...args
    );
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

async function withTimeout(
    promise,
    ms,
    label
) {
    let timer;

    const timeoutPromise =
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    new Error(
                        `${label} timed out after ${ms}ms`
                    )
                );
            }, ms);
        });

    try {
        return await Promise.race([
            promise,
            timeoutPromise
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/* =========================================================
   CONFIG
========================================================= */

function isConfigured() {
    return Boolean(
        YOUTUBE_STREAMS_URL ||
        YOUTUBE_VIDEO_ID ||
        YOUTUBE_VIDEO_ID_2 ||
        (
            YOUTUBE_API_KEY &&
            YOUTUBE_CHANNEL_ID
        )
    );
}

/* =========================================================
   YOUTUBE CLIENT
========================================================= */

async function getClient() {
    if (!innertubeClient) {
        log(
            "Creating YouTube client..."
        );

        innertubeClient =
            await Innertube.create({
                generate_session_locally: true
            });

        log(
            "YouTube client ready"
        );
    }

    return innertubeClient;
}

/* =========================================================
   EXTRACT VIDEO IDS
========================================================= */

function extractVideoIds(html) {
    const ids = new Set();

    const patterns = [
        /"videoId":"([a-zA-Z0-9_-]{11})"/g,
        /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g,
        /watch\?v=([a-zA-Z0-9_-]{11})/g,
        /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/g
    ];

    for (const pattern of patterns) {
        let match;

        while (
            (match = pattern.exec(html)) !== null
        ) {
            if (match[1]) {
                ids.add(match[1]);
            }
        }
    }

    return [...ids];
}

/* =========================================================
   SEARCH STREAMS PAGE
========================================================= */

async function searchStreamsPage() {
    try {
        log(
            "Searching:",
            YOUTUBE_STREAMS_URL
        );

        const response =
            await withTimeout(
                fetch(
                    YOUTUBE_STREAMS_URL,
                    {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

                            "Accept":
                                "text/html,application/xhtml+xml",

                            "Accept-Language":
                                "en-US,en;q=0.9"
                        }
                    }
                ),
                REQUEST_TIMEOUT,
                "YouTube streams page"
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const html =
            await response.text();

        const ids =
            extractVideoIds(html);

        debugLog(
            "Streams page IDs:",
            ids
        );

        return ids;

    } catch (err) {
        console.error(
            "[youtubeChat] Streams page error:",
            err?.message || err
        );

        return [];
    }
}

/* =========================================================
   CHECK VIDEO
========================================================= */

async function isVideoLive(videoId) {
    try {
        const response =
            await withTimeout(
                fetch(
                    `https://www.youtube.com/watch?v=${videoId}`,
                    {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
                        }
                    }
                ),
                REQUEST_TIMEOUT,
                "YouTube video"
            );

        if (!response.ok) {
            return false;
        }

        const html =
            await response.text();

        const indicators = [
            '"isLiveNow":true',
            '"isLive":true',
            '"isLiveContent":true',
            "LIVE_NOW",
            "liveBroadcastDetails"
        ];

        return indicators.some(
            x => html.includes(x)
        );

    } catch (err) {
        debugLog(
            "Live check error:",
            videoId,
            err?.message || err
        );

        return false;
    }
}

/* =========================================================
   RESOLVE STREAM
========================================================= */

async function resolveStreamFromPage() {
    const ids =
        await searchStreamsPage();

    if (!ids.length) {
        return null;
    }

    /*
     * First look for an explicitly live video.
     */
    for (const videoId of ids) {
        if (
            await isVideoLive(videoId)
        ) {
            log(
                "Found live YouTube video:",
                videoId
            );

            return videoId;
        }
    }

    /*
     * If YouTube's HTML does not expose the
     * live flag, use youtubei.js to determine
     * whether the video has live chat.
     */
    const youtube =
        await getClient();

    for (const videoId of ids) {
        try {
            const info =
                await withTimeout(
                    youtube.getInfo(videoId),
                    REQUEST_TIMEOUT,
                    "youtube.getInfo()"
                );

            if (!info) {
                continue;
            }

            try {
                const testChat =
                    await withTimeout(
                        info.getLiveChat(),
                        REQUEST_TIMEOUT,
                        "info.getLiveChat()"
                    );

                if (testChat) {
                    try {
                        testChat.stop();
                    } catch {}

                    log(
                        "Found video with live chat:",
                        videoId
                    );

                    return videoId;
                }

            } catch (err) {
                debugLog(
                    "No live chat:",
                    videoId,
                    err?.message || err
                );
            }

        } catch (err) {
            debugLog(
                "Video info error:",
                videoId,
                err?.message || err
            );
        }
    }

    /*
     * Last fallback.
     */
    log(
        "Using newest stream:",
        ids[0]
    );

    return ids[0];
}

/* =========================================================
   OFFICIAL API FALLBACK
========================================================= */

async function resolveFromOfficialAPI() {
    if (
        !YOUTUBE_API_KEY ||
        !YOUTUBE_CHANNEL_ID
    ) {
        return null;
    }

    try {
        const url =
            "https://www.googleapis.com/youtube/v3/search" +
            "?part=snippet" +
            `&channelId=${encodeURIComponent(
                YOUTUBE_CHANNEL_ID
            )}` +
            "&eventType=live" +
            "&type=video" +
            "&order=date" +
            "&maxResults=5" +
            `&key=${encodeURIComponent(
                YOUTUBE_API_KEY
            )}`;

        const response =
            await withTimeout(
                fetch(url),
                REQUEST_TIMEOUT,
                "YouTube API"
            );

        if (!response.ok) {
            debugLog(
                "Official API returned:",
                response.status
            );

            return null;
        }

        const data =
            await response.json();

        return (
            data.items?.[0]
                ?.id?.videoId ||
            null
        );

    } catch (err) {
        debugLog(
            "Official API error:",
            err?.message || err
        );

        return null;
    }
}

/* =========================================================
   GET VIDEO IDS
========================================================= */

async function getVideoIds() {
    const ids = [];

    /*
     * Explicit IDs.
     */
    if (YOUTUBE_VIDEO_ID) {
        ids.push(
            YOUTUBE_VIDEO_ID.trim()
        );
    }

    if (YOUTUBE_VIDEO_ID_2) {
        ids.push(
            YOUTUBE_VIDEO_ID_2.trim()
        );
    }

    /*
     * MAIN DISCOVERY METHOD.
     */
    const streamVideo =
        await resolveStreamFromPage();

    if (streamVideo) {
        ids.push(streamVideo);
    }

    /*
     * API only if necessary.
     */
    if (!ids.length) {
        const apiVideo =
            await resolveFromOfficialAPI();

        if (apiVideo) {
            ids.push(apiVideo);
        }
    }

    return [
        ...new Set(
            ids.filter(Boolean)
        )
    ];
}

/* =========================================================
   GET LIVE CHAT
========================================================= */

async function getLiveChat(
    youtube,
    videoId
) {
    log(
        "Loading YouTube video:",
        videoId
    );

    const info =
        await withTimeout(
            youtube.getInfo(videoId),
            REQUEST_TIMEOUT,
            "youtube.getInfo()"
        );

    debugLog(
        "Video info loaded"
    );

    log(
        "Getting live chat:"
    );

    const chat =
        await withTimeout(
            info.getLiveChat(),
            REQUEST_TIMEOUT,
            "info.getLiveChat()"
        );

    if (!chat) {
        throw new Error(
            "getLiveChat() returned no chat"
        );
    }

    return chat;
}

/* =========================================================
   CONNECT TO CHAT
========================================================= */

async function connectChat(
    youtube,
    videoId
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= CHAT_RETRY_ATTEMPTS;
        attempt++
    ) {
        if (stopped) {
            throw new Error(
                "YouTube chat stopped"
            );
        }

        try {
            log(
                `Connecting to chat (${attempt}/${CHAT_RETRY_ATTEMPTS}):`,
                videoId
            );

            const chat =
                await getLiveChat(
                    youtube,
                    videoId
                );

            return chat;

        } catch (err) {
            lastError = err;

            console.error(
                "[youtubeChat]",
                `Chat attempt ${attempt} failed:`,
                err?.message || err
            );

            if (
                attempt <
                CHAT_RETRY_ATTEMPTS
            ) {
                await sleep(
                    CHAT_RETRY_DELAY
                );
            }
        }
    }

    throw (
        lastError ||
        new Error(
            "Unable to connect to live chat"
        )
    );
}

/* =========================================================
   START CHAT
========================================================= */

async function attachChat(
    chat,
    videoId
) {
    liveChat = chat;
    currentVideoId = videoId;

    lastMessageTime =
        Date.now();

    log(
        "Preparing YouTube chat:",
        videoId
    );

    /*
     * Standard youtubei.js chat update.
     */
    chat.on(
        "chat-update",
        action => {
            lastMessageTime =
                Date.now();

            resetWatchdog();

            debugLog(
                "CHAT UPDATE received"
            );

            handleChatUpdate(
                action
            );
        }
    );

    /*
     * Some versions/events expose
     * messages separately.
     */
    chat.on(
        "message",
        message => {
            lastMessageTime =
                Date.now();

            resetWatchdog();

            debugLog(
                "DIRECT MESSAGE received"
            );

            parseAction(
                message
            );
        }
    );

    chat.on(
        "error",
        err => {
            console.error(
                "[youtubeChat] Chat error:",
                err?.message || err
            );

            if (!stopped) {
                disconnectChat();

                sendStatus(
                    false,
                    false
                );

                scheduleReconnect(
                    2000
                );
            }
        }
    );

    chat.on(
        "end",
        () => {
            log(
                "YouTube chat ended:",
                videoId
            );

            if (
                liveChat === chat
            ) {
                liveChat = null;
                currentVideoId = null;
            }

            sendStatus(
                false,
                false
            );

            if (!stopped) {
                scheduleReconnect(
                    3000
                );
            }
        }
    );

    /*
     * CRITICAL:
     * Actually start the live chat.
     */
    log(
        "Starting YouTube live chat..."
    );

    await withTimeout(
        chat.start(),
        REQUEST_TIMEOUT,
        "liveChat.start()"
    );

    log(
        "YouTube live chat STARTED:",
        videoId
    );

    sendStatus(
        true,
        true
    );

    resetWatchdog();
}

/* =========================================================
   STATUS
========================================================= */

function sendStatus(
    connected,
    live
) {
    try {
        onStatusCb?.({
            connected,
            live
        });
    } catch (err) {
        debugLog(
            "Status error:",
            err?.message || err
        );
    }
}

/* =========================================================
   WATCHDOG
========================================================= */

function resetWatchdog() {
    if (watchdogTimer) {
        clearTimeout(
            watchdogTimer
        );
    }

    if (stopped) {
        return;
    }

    watchdogTimer =
        setTimeout(
            watchdogCheck,
            WATCHDOG_INTERVAL
        );
}

function watchdogCheck() {
    if (stopped) {
        return;
    }

    const inactive =
        Date.now() -
        lastMessageTime >
        WATCHDOG_INTERVAL;

    if (
        inactive &&
        liveChat
    ) {
        log(
            "Watchdog: no chat messages for 5 minutes"
        );

        disconnectChat();

        sendStatus(
            false,
            false
        );

        scheduleReconnect(
            2000
        );

        return;
    }

    resetWatchdog();
}

/* =========================================================
   DISCONNECT
========================================================= */

function disconnectChat() {
    if (liveChat) {
        try {
            liveChat.stop();
        } catch {}
    }

    liveChat = null;
    currentVideoId = null;
}

/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect(
    delay = RECONNECT_DELAY
) {
    if (
        stopped ||
        reconnectTimer
    ) {
        return;
    }

    debugLog(
        "Reconnect scheduled:",
        delay
    );

    reconnectTimer =
        setTimeout(
            async () => {
                reconnectTimer = null;

                try {
                    await start();
                } catch (err) {
                    debugLog(
                        "Reconnect failed:",
                        err?.message || err
                    );
                }
            },
            delay
        );
}

/* =========================================================
   START
========================================================= */

async function start(
    onMessage,
    onStatus
) {
    if (onMessage) {
        onMessageCb =
            onMessage;
    }

    if (onStatus) {
        onStatusCb =
            onStatus;
    }

    if (starting) {
        debugLog(
            "YouTube start already running"
        );

        return;
    }

    starting = true;
    stopped = false;

    try {
        if (!isConfigured()) {
            log(
                "YouTube chat is not configured"
            );

            sendStatus(
                false,
                false
            );

            return;
        }

        disconnectChat();

        const youtube =
            await getClient();

        const videoIds =
            await getVideoIds();

        if (!videoIds.length) {
            throw new Error(
                "No YouTube video IDs found"
            );
        }

        log(
            "YouTube videos to try:",
            videoIds.join(", ")
        );

        for (
            const videoId of videoIds
        ) {
            if (stopped) {
                return;
            }

            try {
                log(
                    "Trying YouTube video:",
                    videoId
                );

                const chat =
                    await connectChat(
                        youtube,
                        videoId
                    );

                await attachChat(
                    chat,
                    videoId
                );

                return;

            } catch (err) {
                console.error(
                    `[youtubeChat] ${videoId} failed:`,
                    err?.message || err
                );
            }
        }

        sendStatus(
            false,
            false
        );

        if (!stopped) {
            scheduleReconnect(
                RECONNECT_DELAY
            );
        }

    } catch (err) {
        console.error(
            "[youtubeChat]",
            err?.message || err
        );

        sendStatus(
            false,
            false
        );

        if (!stopped) {
            scheduleReconnect(
                RECONNECT_DELAY
            );
        }

    } finally {
        starting = false;
    }
}

/* =========================================================
   CHAT UPDATE HANDLER
========================================================= */

function handleChatUpdate(
    action
) {
    try {
        if (
            Array.isArray(
                action?.actions
            )
        ) {
            for (
                const item of action.actions
            ) {
                parseAction(item);
            }
        } else {
            parseAction(action);
        }
    } catch (err) {
        debugLog(
            "handleChatUpdate error:",
            err?.message || err
        );
    }
}

/* =========================================================
   PARSE MESSAGE
========================================================= */

async function parseAction(
    action
) {
    try {
        const item =
            action?.item ||
            action
                ?.addChatItemAction
                ?.item ||
            action
                ?.replayChatItemAction
                ?.actions?.[0]
                ?.addChatItemAction
                ?.item;

        if (!item) {
            debugLog(
                "No chat item found"
            );

            return;
        }

        const renderer =
            item.liveChatTextMessageRenderer ||
            item.liveChatPaidMessageRenderer ||
            item.liveChatMembershipItemRenderer ||
            item;

        const username =
            renderer.authorName
                ?.simpleText ||
            renderer.authorName
                ?.runs
                ?.map(
                    x =>
                        x.text || ""
                )
                .join("") ||
            renderer.author?.name ||
            "Unknown";

        let message = "";

        /*
         * Normal YouTube text.
         */
        if (
            Array.isArray(
                renderer.message?.runs
            )
        ) {
            message =
                renderer.message.runs
                    .map(run => {
                        if (
                            typeof run.text ===
                            "string"
                        ) {
                            return run.text;
                        }

                        if (
                            run.emoji
                        ) {
                            return (
                                run.emoji
                                    .shortcuts?.[0] ||
                                run.emoji.emojiId ||
                                "😀"
                            );
                        }

                        return "";
                    })
                    .join("");
        }

        /*
         * Some youtubei.js objects use
         * toString/simpleText.
         */
        if (
            !message &&
            typeof renderer.message
                ?.simpleText ===
                "string"
        ) {
            message =
                renderer.message.simpleText;
        }

        if (
            !message &&
            typeof renderer.message ===
                "string"
        ) {
            message =
                renderer.message;
        }

        if (
            !message.trim()
        ) {
            debugLog(
                "Chat item had no readable message"
            );

            return;
        }

        const id =
            renderer.id ||
            `${username}:${message}`;

        if (
            seenMessages.has(id)
        ) {
            return;
        }

        seenMessages.add(id);

        if (
            seenMessages.size >
            5000
        ) {
            const oldest =
                seenMessages
                    .values()
                    .next()
                    .value;

            if (oldest) {
                seenMessages.delete(
                    oldest
                );
            }
        }

        let badges = [];

        try {
            badges =
                await youtubeBadges.resolveBadges(
                    renderer.authorBadges ||
                    []
                );
        } catch (err) {
            debugLog(
                "Badge error:",
                err?.message || err
            );
        }

        const type =
            renderer.purchaseAmountText
                ? "superchat"
                : renderer.headerSubtext
                    ? "membership"
                    : "message";

        const amount =
            renderer
                .purchaseAmountText
                ?.simpleText ||
            null;

        debugLog(
            "MESSAGE:",
            username,
            message
        );

        /*
         * Send to your existing chat manager.
         */
        onMessageCb?.({
            username,
            message,
            badges,
            color: null,

            timestamp:
                Math.floor(
                    Date.now() / 1000
                ),

            type,
            amount
        });

    } catch (err) {
        debugLog(
            "parseAction error:",
            err?.message || err
        );
    }
}

/* =========================================================
   STOP
========================================================= */

function stop() {
    stopped = true;
    starting = false;

    if (reconnectTimer) {
        clearTimeout(
            reconnectTimer
        );

        reconnectTimer = null;
    }

    if (watchdogTimer) {
        clearTimeout(
            watchdogTimer
        );

        watchdogTimer = null;
    }

    disconnectChat();

    sendStatus(
        false,
        false
    );

    debugLog(
        "YouTube chat stopped"
    );
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    start,
    stop,
    isConfigured
};
    start,
    stop,
    isConfigured
};
