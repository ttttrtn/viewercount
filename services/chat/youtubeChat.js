const { Innertube } = require("youtubei.js");
const youtubeBadges = require("./badges/youtubeBadges");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";

const YOUTUBE_VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || "";
const YOUTUBE_VIDEO_ID_2 = process.env.YOUTUBE_VIDEO_ID_2 || "";

const DEBUG = process.env.DEBUG_YOUTUBE === "true";

let innertubeClient = null;
let liveChat = null;

let stopped = false;

let onMessageCb = null;
let onStatusCb = null;

let watchdogTimer = null;
let lastMessageTime = Date.now();

const seenMessages = new Set();

const WATCHDOG_INTERVAL = 300000; // 5 minutes


function debugLog(...args) {
    if (DEBUG) {
        console.log("[youtubeChat][debug]", ...args);
    }
}


function isConfigured() {
    return Boolean(
        YOUTUBE_VIDEO_ID ||
        YOUTUBE_VIDEO_ID_2 ||
        (YOUTUBE_API_KEY && YOUTUBE_CHANNEL_ID)
    );
}


async function getClient() {

    if (!innertubeClient) {

        innertubeClient = await Innertube.create({
            generate_session_locally: true
        });

    }

    return innertubeClient;
}



async function resolveLiveVideoId() {

    if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
        return null;
    }


    try {

        const url =
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&eventType=live&type=video&order=date&maxResults=1&key=${YOUTUBE_API_KEY}`;


        const res = await fetch(url);


        if (!res.ok) {

            debugLog(
                "YouTube API error:",
                res.status
            );

            return null;
        }


        const data = await res.json();


        return (
            data.items?.[0]?.id?.videoId ||
            null
        );


    } catch(err) {

        debugLog(
            "resolveLiveVideoId:",
            err.message
        );

        return null;
    }
}




async function getLiveChatWithRetry(
    youtube,
    videoId,
    attempts = 3
) {

    let lastError;


    for(let i = 0; i < attempts; i++) {

        try {

            const info =
                await youtube.getInfo(videoId);


            const chat =
                await info.getLiveChat();


            if(chat) {

                return chat;

            }


            throw new Error(
                "No live chat found"
            );


        } catch(err) {

            lastError = err;


            debugLog(
                `Chat attempt ${i + 1}/${attempts} failed:`,
                err.message
            );


            await new Promise(
                r => setTimeout(r,3000)
            );
        }

    }


    throw lastError;
}




function safeRetry(fn, delay = 5000) {

    setTimeout(
        fn,
        delay
    );

}




async function start(
    onMessage,
    onStatus
) {

    onMessageCb = onMessage;
    onStatusCb = onStatus;

    stopped = false;

    lastMessageTime = Date.now();


    resetWatchdog();



    if(!isConfigured()) {

        console.warn(
            "[youtubeChat] Missing configuration"
        );


        onStatusCb?.({
            connected:false,
            live:false
        });


        return;
    }



    try {


        const youtube =
            await getClient();



        const discovered =
            await resolveLiveVideoId();



        const videoIds = [
            YOUTUBE_VIDEO_ID,
            YOUTUBE_VIDEO_ID_2,
            discovered
        ]
        .filter(Boolean)
        .filter(
            (v,i,a)=>a.indexOf(v)===i
        );



        let connected = false;



        for(const videoId of videoIds) {


            try {


                debugLog(
                    "Trying video:",
                    videoId
                );


                liveChat =
                    await getLiveChatWithRetry(
                        youtube,
                        videoId
                    );



                if(liveChat) {

                    connected = true;


                    debugLog(
                        "Connected:",
                        videoId
                    );


                    break;
                }



            } catch(err) {

                debugLog(
                    "Failed:",
                    videoId,
                    err.message
                );

            }

        }



        if(!connected) {

            throw new Error(
                "No available YouTube chat"
            );

        }



        onStatusCb?.({
            connected:true,
            live:true
        });



        liveChat.on(
            "chat-update",
            action => {

                lastMessageTime =
                    Date.now();

                handleChatUpdate(action);

            }
        );



        liveChat.on(
            "end",
            () => {


                debugLog(
                    "Chat ended"
                );


                onStatusCb?.({
                    connected:false,
                    live:false
                });



                if(!stopped) {

                    safeRetry(
                        ()=>start(
                            onMessageCb,
                            onStatusCb
                        ),
                        5000
                    );

                }

            }
        );



        await liveChat.start();



    } catch(err) {


        console.error(
            "[youtubeChat]",
            err.message
        );


        onStatusCb?.({
            connected:false,
            live:false
        });



        if(!stopped) {

            safeRetry(
                ()=>start(
                    onMessageCb,
                    onStatusCb
                ),
                10000
            );

        }

    }

}
function resetWatchdog() {

    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
    }


    watchdogTimer = setTimeout(() => {


        const inactive =
            Date.now() - lastMessageTime >
            WATCHDOG_INTERVAL;



        if (
            !stopped &&
            inactive &&
            liveChat
        ) {


            console.warn(
                "[youtubeChat] Watchdog: reconnecting after inactivity"
            );


            try {
                liveChat.stop();
            } catch {}



            liveChat = null;



            safeRetry(
                () => start(
                    onMessageCb,
                    onStatusCb
                ),
                2000
            );



        } else {

            resetWatchdog();

        }



    }, WATCHDOG_INTERVAL);

}





function handleChatUpdate(action) {

    try {


        if (
            action?.actions &&
            Array.isArray(action.actions)
        ) {


            for (
                const item of action.actions
            ) {

                parseAction(item);

            }


        } else {

            parseAction(action);

        }



    } catch(err) {

        debugLog(
            "handleChatUpdate error:",
            err.message
        );

    }

}





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



        if(!item) {
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
            ?.map(x=>x.text)
            .join("") ||
            renderer.author?.name ||
            "Unknown";



        let message = "";



        if (
            renderer.message?.runs
        ) {

            message =
                renderer.message.runs
                .map(run => {

                    if(run.text)
                        return run.text;


                    if(run.emoji)
                        return run.emoji.shortcuts?.[0]
                        || "😀";


                    return "";

                })
                .join("");

        }



        if(!message &&
            typeof renderer.message === "string"
        ) {

            message =
                renderer.message;

        }



        if(!message) {
            return;
        }




        const id =
            renderer.id ||
            `${username}:${message}`;



        if(seenMessages.has(id)) {
            return;
        }



        seenMessages.add(id);



        if(seenMessages.size > 3000) {
            seenMessages.clear();
        }





        const badges =
            await youtubeBadges.resolveBadges(
                renderer.authorBadges || []
            );




        onMessageCb?.({

            username,

            message,

            badges,

            color:null,

            timestamp:
                Math.floor(
                    Date.now()/1000
                ),


            type:
                renderer.purchaseAmountText
                ? "superchat"
                : renderer.headerSubtext
                ? "membership"
                : "message",


            amount:
                renderer.purchaseAmountText
                ?.simpleText || null

        });



    } catch(err) {

        debugLog(
            "parseAction error:",
            err.message
        );

    }

}





function stop() {

    stopped = true;


    if(watchdogTimer) {

        clearTimeout(
            watchdogTimer
        );

    }



    if(liveChat) {

        try {

            liveChat.stop();

        } catch {}

    }


    liveChat = null;

}





module.exports = {
    start,
    stop,
    isConfigured
};
