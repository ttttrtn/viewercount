const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";

const YOUTUBE_VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || "";
const YOUTUBE_VIDEO_ID_2 = process.env.YOUTUBE_VIDEO_ID_2 || "";

const DEBUG = process.env.DEBUG_YOUTUBE === "true";

const RETRY_DELAY = 10000;
const CHAT_RETRY_DELAY = 5000;
const WATCHDOG_INTERVAL = 5 * 60 * 1000;

let innertubeClient = null;
let liveChat = null;

let stopped = true;
let starting = false;

let onMessageCb = null;
let onStatusCb = null;

let reconnectTimer = null;
let watchdogTimer = null;

let lastMessageTime = 0;
let currentVideoId = null;

const seenMessages = new Set();

/* ---------------------------------------------------------
   Logging
--------------------------------------------------------- */

function debugLog(...args) {
    if (DEBUG) {
        console.log("[youtubeChat][debug]", ...args);
    }
}

function log(...args) {
    console.log("[youtubeChat]", ...args);
}

/* ---------------------------------------------------------
   Configuration
--------------------------------------------------------- */

function isConfigured() {
    return Boolean(
        YOUTUBE_VIDEO_ID ||
        YOUTUBE_VIDEO_ID_2 ||
        (YOUTUBE_API_KEY && YOUTUBE_CHANNEL_ID)
    );
}

/* ---------------------------------------------------------
   YouTube client
--------------------------------------------------------- */

async function getClient() {
    if (!innertubeClient) {
        log("Creating YouTube client...");

        innertubeClient = await Innertube.create({
            generate_session_locally: true
        });

        log("YouTube client ready");
    }

    return innertubeClient;
}

/* ---------------------------------------------------------
   Find currently live video
--------------------------------------------------------- */

async function resolveLiveVideoId() {
    if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
        debugLog("YouTube API discovery disabled");
        return null;
    }

    try {
        const url =
            "https://www.googleapis.com/youtube/v3/search" +
            `?part=snippet` +
            `&channelId=${encodeURIComponent(YOUTUBE_CHANNEL_ID)}` +
            `&eventType=live` +
            `&type=video` +
            `&order=date` +
            `&maxResults=5` +
            `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

        debugLog("Searching for live YouTube video...");

        const response = await fetch(url);

        if (!response.ok) {
            const text = await response.text().catch(() => "");

            debugLog(
                "YouTube API error:",
                response.status,
                text
            );

            return null;
        }

        const data = await response.json();

        const video =
            data.items?.find(
                item => item?.id?.videoId
            );

        if (!video) {
            debugLog("No live video found through API");
            return null;
        }

        const videoId = video.id.videoId;

        debugLog(
            "Live video discovered:",
            videoId
        );

        return videoId;

    } catch (err) {
        debugLog(
            "resolveLiveVideoId error:",
            err?.message || err
        );

        return null;
    }
}

/* ---------------------------------------------------------
   Build list of possible videos
--------------------------------------------------------- */

async function getVideoIds() {
    const ids = [];

    if (YOUTUBE_VIDEO_ID) {
        ids.push(YOUTUBE_VIDEO_ID.trim());
    }

    if (YOUTUBE_VIDEO_ID_2) {
        ids.push(YOUTUBE_VIDEO_ID_2.trim());
    }

    const discovered = await resolveLiveVideoId();

    if (discovered) {
        ids.push(discovered);
    }

    return [
        ...new Set(
            ids.filter(Boolean)
        )
    ];
}

/* ---------------------------------------------------------
   Get live chat
--------------------------------------------------------- */

async function getLiveChat(youtube, videoId) {
    debugLog(
        "Loading video:",
        videoId
    );

    const info =
        await youtube.getInfo(videoId);

    debugLog(
        "Video information loaded:",
        videoId
    );

    if (!info) {
        throw new Error(
            "YouTube returned no video information"
        );
    }

    debugLog(
        "Requesting live chat:",
        videoId
    );

    const chat =
        await info.getLiveChat();

    if (!chat) {
        throw new Error(
            "This video does not currently expose a live chat"
        );
    }

    return chat;
}

/* ---------------------------------------------------------
   Retry live chat
--------------------------------------------------------- */

async function getLiveChatWithRetry(
    youtube,
    videoId,
    attempts = 6
) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (stopped) {
            throw new Error(
                "YouTube chat stopped"
            );
        }

        try {
            debugLog(
                `Chat attempt ${attempt}/${attempts}:`,
                videoId
            );

            const chat =
                await getLiveChat(
                    youtube,
                    videoId
                );

            debugLog(
                "Live chat successfully obtained:",
                videoId
            );

            return chat;

        } catch (err) {
            lastError = err;

            debugLog(
                `Chat attempt ${attempt}/${attempts} failed:`,
                err?.message || err
            );

            if (attempt < attempts) {
                await sleep(
                    CHAT_RETRY_DELAY
                );
            }
        }
    }

    throw lastError ||
        new Error(
            "Unable to obtain live chat"
        );
}

/* ---------------------------------------------------------
   Sleep helper
--------------------------------------------------------- */

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

/* ---------------------------------------------------------
   Status
--------------------------------------------------------- */

function sendStatus(connected, live) {
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

/* ---------------------------------------------------------
   Reconnect
--------------------------------------------------------- */

function scheduleReconnect(delay = RETRY_DELAY) {
    if (stopped) {
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    debugLog(
        `Reconnect scheduled in ${delay}ms`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        start(
            onMessageCb,
            onStatusCb
        ).catch(err => {
            debugLog(
                "Reconnect start error:",
                err?.message || err
            );
        });

    }, delay);
}

/* ---------------------------------------------------------
   Watchdog
--------------------------------------------------------- */

function resetWatchdog() {
    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
    }

    if (stopped) {
        return;
    }

    watchdogTimer = setTimeout(
        watchdogCheck,
        WATCHDOG_INTERVAL
    );
}

function watchdogCheck() {
    if (stopped) {
        return;
    }

    const inactive =
        Date.now() - lastMessageTime >
        WATCHDOG_INTERVAL;

    if (inactive && liveChat) {
        log(
            "Watchdog: no YouTube messages for 5 minutes, reconnecting..."
        );

        disconnectChat();

        scheduleReconnect(2000);

        return;
    }

    resetWatchdog();
}

/* ---------------------------------------------------------
   Disconnect current chat
--------------------------------------------------------- */

function disconnectChat() {
    if (!liveChat) {
        return;
    }

    try {
        liveChat.stop();
    } catch (err) {
        debugLog(
            "Chat stop error:",
            err?.message || err
        );
    }

    liveChat = null;
    currentVideoId = null;
}

/* ---------------------------------------------------------
   Attach chat listeners
--------------------------------------------------------- */

function attachChat(chat, videoId) {
    liveChat = chat;
    currentVideoId = videoId;

    lastMessageTime = Date.now();

    chat.on(
        "chat-update",
        action => {
            lastMessageTime = Date.now();

            resetWatchdog();

            handleChatUpdate(action);
        }
    );

    chat.on(
        "end",
        () => {
            debugLog(
                "YouTube live chat ended:",
                videoId
            );

            if (liveChat === chat) {
                liveChat = null;
                currentVideoId = null;
            }

            sendStatus(false, false);

            if (!stopped) {
                scheduleReconnect(3000);
            }
        }
    );

    sendStatus(true, true);

    resetWatchdog();

    debugLog(
        "YouTube chat connected:",
        videoId
    );
}

/* ---------------------------------------------------------
   Start
--------------------------------------------------------- */

async function start(
    onMessage,
    onStatus
) {
    if (onMessage) {
        onMessageCb = onMessage;
    }

    if (onStatus) {
        onStatusCb = onStatus;
    }

    if (starting) {
        debugLog(
            "Start already in progress"
        );

        return;
    }

    stopped = false;
    starting = true;

    try {
        if (!isConfigured()) {
            console.warn(
                "[youtubeChat] Missing YouTube configuration"
            );

            sendStatus(false, false);

            return;
        }

        disconnectChat();

        const youtube =
            await getClient();

        const videoIds =
            await getVideoIds();

        if (!videoIds.length) {
            throw new Error(
                "No YouTube live video IDs found"
            );
        }

        debugLog(
            "Videos to try:",
            videoIds.join(", ")
        );

        let connected = false;

        for (const videoId of videoIds) {
            if (stopped) {
                break;
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

                connected = true;

                break;

            } catch (err) {
                debugLog(
                    `Failed video ${videoId}:`,
                    err?.message || err
                );
            }
        }

        if (!connected && !stopped) {
            throw new Error(
                "No available YouTube chat"
            );
        }

    } catch (err) {
        console.error(
            "[youtubeChat]",
            err?.message || err
        );

        sendStatus(false, false);

        if (!stopped) {
            scheduleReconnect(
                RETRY_DELAY
            );
        }

    } finally {
        starting = false;
    }
}

/* ---------------------------------------------------------
   Chat update
--------------------------------------------------------- */

function handleChatUpdate(action) {
    try {
        if (
            action?.actions &&
            Array.isArray(action.actions)
        ) {
            for (const item of action.actions) {
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

/* ---------------------------------------------------------
   Parse message
--------------------------------------------------------- */

async function parseAction(action) {
    try {
        const item =
            action?.item ||
            action?.addChatItemAction?.item ||
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
            renderer.authorName?.simpleText ||
            renderer.authorName?.runs
                ?.map(x => x.text || "")
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
                        if (run.text) {
                            return run.text;
                        }

                        if (run.emoji) {
                            return (
                                run.emoji.shortcuts?.[0] ||
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
            typeof renderer.message === "string"
        ) {
            message = renderer.message;
        }

        if (!message.trim()) {
            return;
        }

        const id =
            renderer.id ||
            `${username}:${message}:${Date.now()}`;

        if (seenMessages.has(id)) {
            return;
        }

        seenMessages.add(id);

        if (seenMessages.size > 5000) {
            const first =
                seenMessages.values().next().value;

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
            debugLog(
                "Badge error:",
                err?.message || err
            );
        }

        const isSuperChat =
            Boolean(
                renderer.purchaseAmountText
            );

        const isMembership =
            Boolean(
                renderer.headerSubtext
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

            type:
                isSuperChat
                    ? "superchat"
                    : isMembership
                        ? "membership"
                        : "message",

            amount:
                renderer.purchaseAmountText
                    ?.simpleText ||
                null
        });

    } catch (err) {
        debugLog(
            "parseAction error:",
            err?.message || err
        );
    }
}

/* ---------------------------------------------------------
   Stop
--------------------------------------------------------- */

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

    debugLog(
        "YouTube chat stopped"
    );

    sendStatus(false, false);
}

/* ---------------------------------------------------------
   Exports
--------------------------------------------------------- */

module.exports = {
    start,
    stop,
    isConfigured
};
