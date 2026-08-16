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
const CHAT_ATTEMPTS = 4;
const RETRY_DELAY = 5000;
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
    name
) {
    let timer;

    const timeoutPromise =
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    new Error(
                        `${name} timed out after ${ms}ms`
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
   EXTRACT VIDEO IDS FROM HTML
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
            "Searching YouTube streams page..."
        );

        debugLog(
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
            "Streams page video IDs:",
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
   CHECK IF VIDEO IS LIVE
========================================================= */

async function isVideoLive(videoId) {
    try {
        const url =
            `https://www.youtube.com/watch?v=${videoId}`;

        const response =
            await withTimeout(
                fetch(
                    url,
                    {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

                            "Accept-Language":
                                "en-US,en;q=0.9"
                        }
                    }
                ),
                REQUEST_TIMEOUT,
                `YouTube video ${videoId}`
            );

        if (!response.ok) {
            return false;
        }

        const html =
            await response.text();

        const liveIndicators = [
            '"isLiveNow":true',
            '"isLive":true',
            '"isLiveContent":true',
            '"liveBroadcastDetails"',
            "LIVE_NOW",
            "watching now"
        ];

        return liveIndicators.some(
            indicator =>
                html.includes(indicator)
        );

    } catch (err) {
        debugLog(
            "Live check failed:",
            videoId,
            err?.message || err
        );

        return false;
    }
}

/* =========================================================
   FIND LIVE VIDEO FROM STREAMS PAGE
========================================================= */

async function resolveFromStreamsPage() {
    const ids =
        await searchStreamsPage();

    if (!ids.length) {
        log(
            "No video IDs found on streams page"
        );

        return null;
    }

    /*
     * Check every discovered video for
     * an active live broadcast.
     */
    for (const videoId of ids) {
        debugLog(
            "Checking stream:",
            videoId
        );

        if (
            await isVideoLive(videoId)
        ) {
            log(
                "Found active livestream:",
                videoId
            );

            return videoId;
        }
    }

    /*
     * YouTube sometimes doesn't expose the
     * live flag in the normal HTML.
     *
     * Try the newest stream with youtubei.js
     * as a second-level check.
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

            const details =
                info.basic_info || {};

            debugLog(
                "youtubei.js video:",
                videoId,
                details.title || ""
            );

            /*
             * getLiveChat() is the strongest
             * indication that the video currently
             * exposes a live chat.
             */
            try {
                const chat =
                    await withTimeout(
                        info.getLiveChat(),
                        REQUEST_TIMEOUT,
                        "info.getLiveChat()"
                    );

                if (chat) {
                    log(
                        "Found livestream with live chat:",
                        videoId
                    );

                    try {
                        chat.stop();
                    } catch {}

                    return videoId;
                }
            } catch (err) {
                debugLog(
                    "Live chat unavailable for:",
                    videoId,
                    err?.message || err
                );
            }

        } catch (err) {
            debugLog(
                "youtubei.js check failed:",
                videoId,
                err?.message || err
            );
        }
    }

    /*
     * Last fallback: use the newest stream.
     */
    log(
        "No explicit live stream detected; using newest stream:",
        ids[0]
    );

    return ids[0];
}

/* =========================================================
   OFFICIAL API FALLBACK
========================================================= */

async function resolveFromOfficialApi() {
    if (
        !YOUTUBE_API_KEY ||
        !YOUTUBE_CHANNEL_ID
    ) {
        return null;
    }

    try {
        debugLog(
            "Trying YouTube official API..."
        );

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
            const text =
                await response.text()
                    .catch(() => "");

            debugLog(
                "YouTube API:",
                response.status,
                text
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
            "Official API failed:",
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
     * Explicit IDs first.
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
     * MAIN METHOD:
     *
     * Search:
     * https://www.youtube.com/@RealMalikGPT/streams
     */
    const streamsVideo =
        await resolveFromStreamsPage();

    if (streamsVideo) {
        ids.push(
            streamsVideo
        );
    }

    /*
     * API is now only a fallback.
     * This prevents API quota problems from
     * blocking stream discovery.
     */
    if (!ids.length) {
        const apiVideo =
            await resolveFromOfficialApi();

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
    debugLog(
        "Loading video:",
        videoId
    );

    const info =
        await withTimeout(
            youtube.getInfo(videoId),
            REQUEST_TIMEOUT,
            "youtube.getInfo()"
        );

    debugLog(
        "Video info loaded:",
        videoId
    );

    const chat =
        await withTimeout(
            info.getLiveChat(),
            REQUEST_TIMEOUT,
            "info.getLiveChat()"
        );

    if (!chat) {
        throw new Error(
            "No live chat available"
        );
    }

    return chat;
}

/* =========================================================
   RETRY CHAT
========================================================= */

async function getLiveChatWithRetry(
    youtube,
    videoId
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= CHAT_ATTEMPTS;
        attempt++
    ) {
        if (stopped) {
            throw new Error(
                "Chat stopped"
            );
        }

        try {
            log(
                `Connecting to YouTube chat ${attempt}/${CHAT_ATTEMPTS}:`,
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
                `Attempt ${attempt}/${CHAT_ATTEMPTS}:`,
                err?.message || err
            );

            if (
                attempt <
                CHAT_ATTEMPTS
            ) {
                await sleep(
                    RETRY_DELAY
                );
            }
        }
    }

    throw (
        lastError ||
        new Error(
            "Unable to connect to YouTube chat"
        )
    );
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
            "Status callback error:",
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
            "Watchdog: reconnecting YouTube chat"
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
        `Reconnect scheduled in ${delay}ms`
    );

    reconnectTimer =
        setTimeout(
            async () => {
                reconnectTimer = null;

                try {
                    await start();
                } catch (err) {
                    debugLog(
                        "Reconnect error:",
                        err?.message || err
                    );
                }
            },
            delay
        );
}

/* =========================================================
   ATTACH CHAT
========================================================= */

function attachChat(
    chat,
    videoId
) {
    liveChat = chat;
    currentVideoId = videoId;

    lastMessageTime =
        Date.now();

    chat.on(
        "chat-update",
        action => {
            lastMessageTime =
                Date.now();

            resetWatchdog();

            handleChatUpdate(
                action
            );
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

    sendStatus(
        true,
        true
    );

    resetWatchdog();

    log(
        "YouTube chat connected:",
        videoId
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
        return;
    }

    starting = true;
    stopped = false;

    try {
        if (!isConfigured()) {
            log(
                "YouTube chat not configured"
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

        debugLog(
            "Video IDs:",
            videoIds
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
                    await getLiveChatWithRetry(
                        youtube,
                        videoId
                    );

                if (!chat) {
                    continue;
                }

                attachChat(
                    chat,
                    videoId
                );

                return;

            } catch (err) {
                console.error(
                    `[youtubeChat] ${videoId}:`,
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
   CHAT PARSER
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
            "handleChatUpdate:",
            err?.message || err
        );
    }
}

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

        if (
            Array.isArray(
                renderer.message?.runs
            )
        ) {
            message =
                renderer.message.runs
                    .map(run => {
                        if (
                            run.text
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

        if (
            !message &&
            typeof renderer.message ===
                "string"
        ) {
            message =
                renderer.message;
        }

        if (!message.trim()) {
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
            const first =
                seenMessages
                    .values()
                    .next()
                    .value;

            if (first) {
                seenMessages.delete(
                    first
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

        onMessageCb?.({
            username,
            message,
            badges,
            color: null,

            timestamp:
                Math.floor(
                    Date.now() / 1000
                ),

            type:
                renderer.purchaseAmountText
                    ? "superchat"
                    : renderer.headerSubtext
                        ? "membership"
                        : "message",

            amount:
                renderer
                    .purchaseAmountText
                    ?.simpleText ||
                null
        });

    } catch (err) {
        debugLog(
            "parseAction:",
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
