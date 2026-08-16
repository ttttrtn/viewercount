const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const STREAMS_URL =
    "https://www.youtube.com/@RealMalikGPT/streams";

const VIDEO_ID =
    process.env.YOUTUBE_VIDEO_ID || "";

const VIDEO_ID_2 =
    process.env.YOUTUBE_VIDEO_ID_2 || "";

const DEBUG =
    process.env.DEBUG_YOUTUBE === "true";

const RETRY_DELAY = 10000;
const WATCHDOG_TIME = 5 * 60 * 1000;

let youtube = null;
let liveChat = null;
let currentVideoId = null;

let stopped = true;
let starting = false;

let reconnectTimer = null;
let watchdogTimer = null;

let lastMessageTime = Date.now();

let onMessageCb = null;
let onStatusCb = null;

const seenMessages = new Set();


function debug(...args) {
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


function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


function isConfigured() {
    return Boolean(
        VIDEO_ID ||
        VIDEO_ID_2 ||
        STREAMS_URL
    );
}


/* =========================================
   YOUTUBE CLIENT
========================================= */

async function getYoutube() {
    if (!youtube) {
        log("Creating YouTube client...");

        youtube = await Innertube.create({
            generate_session_locally: true
        });

        log("YouTube client ready");
    }

    return youtube;
}


/* =========================================
   FIND VIDEO IDS FROM /STREAMS
========================================= */

async function findVideoIds() {
    try {
        log(
            "Searching:",
            STREAMS_URL
        );

        const response = await fetch(
            STREAMS_URL,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const html =
            await response.text();

        const ids = new Set();

        const regex =
            /"videoId":"([A-Za-z0-9_-]{11})"/g;

        let match;

        while (
            (match = regex.exec(html))
        ) {
            ids.add(match[1]);
        }

        const result = [
            ...ids
        ];

        debug(
            "Found video IDs:",
            result
        );

        return result;

    } catch (err) {
        console.error(
            "[youtubeChat] Stream search failed:",
            err.message
        );

        return [];
    }
}


/* =========================================
   GET VIDEO IDS
========================================= */

async function getVideoIds() {
    const ids = [];

    if (VIDEO_ID) {
        ids.push(VIDEO_ID);
    }

    if (VIDEO_ID_2) {
        ids.push(VIDEO_ID_2);
    }

    const discovered =
        await findVideoIds();

    ids.push(...discovered);

    return [
        ...new Set(
            ids.filter(Boolean)
        )
    ];
}


/* =========================================
   GET LIVE CHAT
========================================= */

async function getChat(videoId) {
    const yt =
        await getYoutube();

    log(
        "Trying YouTube video:",
        videoId
    );

    const info =
        await yt.getInfo(videoId);

    if (!info) {
        throw new Error(
            "Could not get video info"
        );
    }

    debug(
        "Video info loaded:",
        videoId
    );

    const chat =
        await info.getLiveChat();

    if (!chat) {
        throw new Error(
            "No live chat available"
        );
    }

    return chat;
}


/* =========================================
   PARSE TEXT
========================================= */

function extractText(message) {
    if (!message) {
        return "";
    }

    if (
        typeof message === "string"
    ) {
        return message;
    }

    if (
        typeof message.simpleText ===
        "string"
    ) {
        return message.simpleText;
    }

    if (
        Array.isArray(message.runs)
    ) {
        return message.runs
            .map(run => {
                if (
                    typeof run.text ===
                    "string"
                ) {
                    return run.text;
                }

                if (run.emoji) {
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

    return "";
}


/* =========================================
   PARSE CHAT ITEM
========================================= */

async function parseItem(item) {
    try {
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
                ?.map(x => x.text || "")
                .join("") ||
            renderer.author?.name ||
            "Unknown";

        const message =
            extractText(
                renderer.message
            );

        if (!message) {
            debug(
                "Ignoring chat item without text"
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
            seenMessages.size > 5000
        ) {
            const first =
                seenMessages
                    .values()
                    .next()
                    .value;

            if (first) {
                seenMessages.delete(first);
            }
        }

        let badges = [];

        try {
            badges =
                await youtubeBadges.resolveBadges(
                    renderer.authorBadges || []
                );
        } catch (err) {
            debug(
                "Badge error:",
                err.message
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

        log(
            "MESSAGE:",
            username,
            "=>",
            message
        );

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
        console.error(
            "[youtubeChat] Parse error:",
            err.message
        );
    }
}


/* =========================================
   HANDLE UPDATE
========================================= */

function handleUpdate(action) {
    lastMessageTime =
        Date.now();

    resetWatchdog();

    try {
        debug(
            "CHAT UPDATE received"
        );

        if (
            Array.isArray(
                action?.actions
            )
        ) {
            for (
                const entry of action.actions
            ) {
                const item =
                    entry?.item ||
                    entry
                        ?.addChatItemAction
                        ?.item;

                if (item) {
                    parseItem(item);
                }
            }

            return;
        }

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

        if (item) {
            parseItem(item);
        }

    } catch (err) {
        console.error(
            "[youtubeChat] Update error:",
            err.message
        );
    }
}


/* =========================================
   WATCHDOG
========================================= */

function resetWatchdog() {
    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
    }

    if (stopped) {
        return;
    }

    watchdogTimer =
        setTimeout(
            () => {
                const inactive =
                    Date.now() -
                    lastMessageTime >
                    WATCHDOG_TIME;

                if (
                    inactive &&
                    liveChat
                ) {
                    log(
                        "Watchdog reconnecting YouTube chat..."
                    );

                    disconnect();

                    scheduleReconnect(2000);

                    return;
                }

                resetWatchdog();
            },
            WATCHDOG_TIME
        );
}


/* =========================================
   DISCONNECT
========================================= */

function disconnect() {
    if (liveChat) {
        try {
            liveChat.stop();
        } catch {}
    }

    liveChat = null;
    currentVideoId = null;
}


/* =========================================
   STATUS
========================================= */

function status(
    connected,
    live
) {
    onStatusCb?.({
        connected,
        live
    });
}


/* =========================================
   RECONNECT
========================================= */

function scheduleReconnect(
    delay = RETRY_DELAY
) {
    if (
        stopped ||
        reconnectTimer
    ) {
        return;
    }

    reconnectTimer =
        setTimeout(
            () => {
                reconnectTimer = null;

                start();
            },
            delay
        );
}


/* =========================================
   START
========================================= */

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
        const videoIds =
            await getVideoIds();

        if (!videoIds.length) {
            throw new Error(
                "No YouTube video IDs found"
            );
        }

        log(
            "Video IDs:",
            videoIds.join(", ")
        );

        for (
            const videoId of videoIds
        ) {
            if (stopped) {
                return;
            }

            try {
                const chat =
                    await getChat(
                        videoId
                    );

                liveChat = chat;
                currentVideoId =
                    videoId;

                lastMessageTime =
                    Date.now();

                /* -------------------------
                   CHAT UPDATE
                ------------------------- */

                chat.on(
                    "chat-update",
                    handleUpdate
                );

                /* -------------------------
                   DIRECT MESSAGE FALLBACK
                ------------------------- */

                chat.on(
                    "message",
                    message => {
                        lastMessageTime =
                            Date.now();

                        resetWatchdog();

                        debug(
                            "DIRECT MESSAGE received"
                        );

                        parseItem(
                            message
                        );
                    }
                );

                /* -------------------------
                   ERROR
                ------------------------- */

                chat.on(
                    "error",
                    err => {
                        console.error(
                            "[youtubeChat] Chat error:",
                            err?.message ||
                            err
                        );

                        if (!stopped) {
                            disconnect();

                            status(
                                false,
                                false
                            );

                            scheduleReconnect(
                                2000
                            );
                        }
                    }
                );

                /* -------------------------
                   END
                ------------------------- */

                chat.on(
                    "end",
                    () => {
                        log(
                            "YouTube chat ended"
                        );

                        disconnect();

                        status(
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

                /* -------------------------
                   START CHAT
                ------------------------- */

                log(
                    "Starting YouTube live chat..."
                );

                await chat.start();

                log(
                    "YouTube live chat STARTED:",
                    videoId
                );

                status(
                    true,
                    true
                );

                resetWatchdog();

                return;

            } catch (err) {
                console.error(
                    "[youtubeChat]",
                    videoId,
                    "failed:",
                    err?.message ||
                    err
                );

                disconnect();
            }
        }

        status(
            false,
            false
        );

        scheduleReconnect();

    } catch (err) {
        console.error(
            "[youtubeChat]",
            err?.message ||
            err
        );

        status(
            false,
            false
        );

        scheduleReconnect();

    } finally {
        starting = false;
    }
}


/* =========================================
   STOP
========================================= */

function stop() {
    stopped = true;

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

    disconnect();

    status(
        false,
        false
    );
}


/* =========================================
   EXPORT
========================================= */

module.exports = {
    start,
    stop,
    isConfigured
};
    start,
    stop,
    isConfigured
};
