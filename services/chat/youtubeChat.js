//
// YouTube Live Chat via youtubei.js 17.2+
//

const { Innertube } = require("youtubei.js");

const youtubeBadges = require("./badges/youtubeBadges");


const YOUTUBE_VIDEO_ID =
    process.env.YOUTUBE_VIDEO_ID || "";


// ... (keep your existing requires and YOUTUBE_VIDEO_ID)

let liveChat = null;
let stopped = false;
let onMessageCb = null;
let onStatusCb = null;
let watchdogTimer = null; // New: Timer variable
let lastMessageTime = Date.now(); // New: Track activity

const seenMessages = new Set();
const WATCHDOG_INTERVAL = 60000; // 60 seconds (adjust as needed)

function resetWatchdog() {
    lastMessageTime = Date.now();
    if (watchdogTimer) clearTimeout(watchdogTimer);
    
    watchdogTimer = setTimeout(async () => {
        if (Date.now() - lastMessageTime > WATCHDOG_INTERVAL) {
            console.warn("[youtubeChat] Watchdog triggered: No messages in 60s, reconnecting...");
            stop();
            // Wait a moment then restart
            setTimeout(() => start(onMessageCb, onStatusCb), 2000);
        } else {
            resetWatchdog();
        }
    }, WATCHDOG_INTERVAL);
}

async function start(onMessage, onStatus) {
    onMessageCb = onMessage;
    onStatusCb = onStatus;
    stopped = false;
    lastMessageTime = Date.now(); // Reset on start
    resetWatchdog(); // Start the monitor

    if (!YOUTUBE_VIDEO_ID) {
        console.error("[youtubeChat] Missing YOUTUBE_VIDEO_ID");
        return;
    }

    try {
        console.log(`[youtubeChat] Connecting ${YOUTUBE_VIDEO_ID}`);
        const youtube = await Innertube.create();
        let info = await youtube.getInfo(YOUTUBE_VIDEO_ID);
        
        console.log("[youtubeChat] Video:", info.basic_info?.title || "Unknown");
        liveChat = await info.getLiveChat();

        if (!liveChat) {
            console.error("[youtubeChat] No live chat found");
            onStatusCb?.({ connected: false, live: false });
            return;
        }

        onStatusCb?.({ connected: true, live: true });
        console.log("[youtubeChat] Live chat initialized");

        liveChat.on("error", (err) => {
            console.error("[youtubeChat] error:", err.message);
        });

        liveChat.on("end", () => {
            console.log("[youtubeChat] Chat ended");
            onStatusCb?.({ connected: false, live: false });
            if (!stopped) {
                setTimeout(() => start(onMessageCb, onStatusCb), 5000);
            }
        });

        liveChat.on("chat-update", async (data) => {
            if (!data?.actions) return;
            
            // If we receive data, reset the watchdog timer
            lastMessageTime = Date.now(); 
            
            for (const action of data.actions) {
                await parseAction(action);
            }
        });

        await liveChat.start();
        console.log("[youtubeChat] Connected");
    } catch (err) {
        console.error("[youtubeChat]", err.message);
        onStatusCb?.({ connected: false, live: false });
    }
}

function stop() {
    stopped = true;
    if (watchdogTimer) clearTimeout(watchdogTimer); // Cleanup
    if (liveChat) {
        try { liveChat.stop(); } catch(e) {}
    }
    liveChat = null;
    seenMessages.clear();
}
