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
const WATCHDOG_INTERVAL = 60000;


function debugLog(...args) {
    if (DEBUG) console.log("[youtubeChat] [debug]", ...args);
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


async function getLiveChatWithRetry(youtube, videoId, attempts = 3) {
    let lastErr;

    for (let i = 0; i < attempts; i++) {
        try {
            const info = await youtube.getInfo(videoId);

            debugLog(
                `getInfo(${videoId}) attempt ${i + 1}/${attempts}`
            );

            const chat = await info.getLiveChat();

            if (chat) return chat;

            throw new Error("No live chat returned");

        } catch (err) {

            lastErr = err;

            debugLog(
                `Chat failed ${videoId}: ${err.message}`
            );

            if (i < attempts - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    throw lastErr;
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
            console.error(
                "[youtubeChat] API error:",
                res.status
            );
            return null;
        }


        const data = await res.json();


        return (
            data.items?.[0]?.id?.videoId ||
            null
        );


    } catch(err){

        console.error(
            "[youtubeChat] resolve error:",
            err.message
        );

        return null;
    }
}



function safeRetry(fn, delay = 5000) {

    setTimeout(fn, delay);

}



async function start(onMessage, onStatus) {

    onMessageCb = onMessage;
    onStatusCb = onStatus;

    stopped = false;

    lastMessageTime = Date.now();

    resetWatchdog();


    if (!isConfigured()) {

        console.warn(
            "[youtubeChat] Not configured"
        );

        onStatusCb?.({
            connected:false,
            live:false
        });

        return;
    }



    try {

        const youtube = await getClient();


        const videoIds = [
            YOUTUBE_VIDEO_ID,
            YOUTUBE_VIDEO_ID_2,
            await resolveLiveVideoId()
        ]
        .filter(Boolean);



        let connected = false;


        for (const videoId of videoIds) {

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


                if (liveChat) {

                    connected = true;

                    debugLog(
                        "Connected:",
                        videoId
                    );

                    break;
                }


            } catch(err){

                debugLog(
                    "Failed:",
                    videoId,
                    err.message
                );

            }
        }



        if (!connected) {

            throw new Error(
                "No YouTube chat available"
            );

        }



        onStatusCb?.({
            connected:true,
            live:true
        });



        liveChat.on(
            "chat-update",
            action => {

                lastMessageTime = Date.now();

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


                if (!stopped) {

                    safeRetry(
                        () =>
                        start(
                            onMessageCb,
                            onStatusCb
                        ),
                        5000
                    );

                }
            }
        );



        await liveChat.start();



    } catch(err){


        console.error(
            "[youtubeChat]",
            err.message
        );


        onStatusCb?.({
            connected:false,
            live:false
        });



        if(!stopped){

            safeRetry(
                () =>
                start(
                    onMessageCb,
                    onStatusCb
                ),
                10000
            );

        }
    }
}




function resetWatchdog(){

    if(watchdogTimer)
        clearTimeout(watchdogTimer);



    watchdogTimer=setTimeout(()=>{


        if(
            !stopped &&
            Date.now()-lastMessageTime > WATCHDOG_INTERVAL
        ){

            console.warn(
                "[youtubeChat] No messages, reconnecting"
            );


            stop();


            safeRetry(
                () =>
                start(
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




function handleChatUpdate(action){

    try{

        if(action?.actions){

            for(const a of action.actions)
                parseAction(a);

        } else {

            parseAction(action);

        }


    }catch(err){

        console.error(
            "[youtubeChat] Parse error:",
            err.message
        );

    }

}



async function parseAction(action){


    const item =
        action?.item ||
        action?.addChatItemAction?.item ||
        action?.replayChatItemAction?.actions?.[0]
        ?.addChatItemAction?.item;



    const renderer =
        item?.liveChatTextMessageRenderer ||
        item?.liveChatPaidMessageRenderer ||
        item?.liveChatMembershipItemRenderer ||
        item;



    if(!renderer)
        return;



    const username =
        renderer.authorName?.simpleText ||
        renderer.author?.name ||
        "Unknown";



    const message =
        renderer.message?.runs
        ?.map(x=>x.text || "")
        .join("")
        ||
        renderer.message?.toString()
        ||
        "";



    if(!message)
        return;



    const id =
        renderer.id ||
        `${username}:${message}`;



    if(seenMessages.has(id))
        return;



    seenMessages.add(id);



    if(seenMessages.size > 2000)
        seenMessages.clear();



    onMessageCb?.({

        username,

        message,

        badges:
            await youtubeBadges.resolveBadges(
                renderer.authorBadges || []
            ),

        color:null,

        timestamp:
            Math.floor(Date.now()/1000),

        type:
            renderer.purchaseAmountText
            ? "superchat"
            : "message",

        amount:
            renderer.purchaseAmountText
            ?.simpleText || null
    });

}




function stop(){

    stopped=true;


    if(watchdogTimer)
        clearTimeout(watchdogTimer);



    try{

        liveChat?.stop();

    }catch{}

}



module.exports={
    start,
    stop,
    isConfigured
};
