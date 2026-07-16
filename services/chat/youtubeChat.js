// YouTube live chat via youtubei.js
//
// Environment:
// YOUTUBE_VIDEO_ID - Current YouTube Live video ID
// Example: sNnMeQsXXXk

//
// YouTube Live Chat via youtubei.js 17.2.0
//
// Environment:
// YOUTUBE_VIDEO_ID - Current YouTube Live video ID
//

const { Innertube } = require("youtubei.js");

const youtubeBadges = require("./badges/youtubeBadges");


const YOUTUBE_VIDEO_ID =
    process.env.YOUTUBE_VIDEO_ID || "";


let liveChat = null;

let stopped = false;

let onMessageCb = null;
let onStatusCb = null;


const seenMessages = new Set();



function isConfigured() {

    return Boolean(YOUTUBE_VIDEO_ID);

}



async function start(onMessage, onStatus) {

    onMessageCb = onMessage;
    onStatusCb = onStatus;

    stopped = false;


    if (!YOUTUBE_VIDEO_ID) {

        console.error(
            "[youtubeChat] Missing YOUTUBE_VIDEO_ID"
        );

        return;
    }


    try {

        console.log(
            `[youtubeChat] Connecting ${YOUTUBE_VIDEO_ID}`
        );


        const youtube =
            await Innertube.create();



        const info =
            await youtube.getInfo(
                YOUTUBE_VIDEO_ID
            );



        liveChat =
            await info.getLiveChat();



        if (!liveChat) {

            console.error(
                "[youtubeChat] No live chat available"
            );


            onStatusCb?.({

                connected:false,
                live:false

            });


            return;
        }



        onStatusCb?.({

            connected:true,
            live:true

        });



        console.log(
            "[youtubeChat] Live chat initialized"
        );



        //
        // Debug events
        // Helps identify API changes
        //

        liveChat.on(
            "error",
            (err)=>{

                console.error(
                    "[youtubeChat] error:",
                    err.message
                );

            }
        );



        liveChat.on(
            "end",
            ()=>{

                console.log(
                    "[youtubeChat] Chat ended"
                );


                onStatusCb?.({

                    connected:false,
                    live:false

                });


                if (!stopped) {

                    setTimeout(()=>{

                        start(
                            onMessageCb,
                            onStatusCb
                        );

                    },5000);

                }

            }
        );



        //
        // Main chat listener
        //

        liveChat.on(
            "chat-update",
            async(data)=>{

                if (!data?.actions)
                    return;


                await handleActions(
                    data.actions
                );

            }
        );



        await liveChat.start();



        console.log(
            "[youtubeChat] Connected"
        );



    } catch(err) {


        console.error(
            "[youtubeChat]",
            err.message
        );


        onStatusCb?.({

            connected:false,
            live:false

        });


        if (!stopped) {

            setTimeout(()=>{

                start(
                    onMessageCb,
                    onStatusCb
                );

            },10000);

        }

    }

}
//
// Message processing
//


async function handleActions(actions) {


    for (const action of actions) {


        const item =
            action.item ||
            action.addChatItemAction?.item ||
            action.replayChatItemAction?.actions?.[0]
                ?.addChatItemAction?.item;



        if (!item)
            continue;



        const renderer =

            item.liveChatTextMessageRenderer ||

            item.liveChatPaidMessageRenderer ||

            item.liveChatMembershipItemRenderer ||

            item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer ||

            item.liveChatViewerEngagementMessageRenderer;



        if (!renderer)
            continue;



        const username =

            renderer.authorName?.simpleText ||

            renderer.authorName?.runs
                ?.map(r => r.text)
                .join("") ||

            "Unknown";



        const message = extractMessage(
            renderer
        );



        if (!message)
            continue;



        const id =

            renderer.id ||

            `${username}:${message}`;



        if (seenMessages.has(id))
            continue;



        seenMessages.add(id);



        if (seenMessages.size > 2000) {

            seenMessages.clear();

        }



        let badges = [];



        try {


            badges =
                await youtubeBadges.resolveBadges(

                    renderer.authorBadges ||

                    []

                );


        } catch(err) {


            console.error(

                "[youtubeChat] badge error:",
                err.message

            );

        }



        const data = {


            username,

            message,


            badges,


            color:null,


            timestamp:
                Math.floor(
                    Date.now() / 1000
                ),



            // Extra information
            // useful for overlays

            type:
                getMessageType(
                    renderer
                ),



            amount:
                renderer.purchaseAmountText
                    ?.simpleText || null


        };



        onMessageCb?.(data);


    }

}




//
// Extract message text
//

function extractMessage(renderer) {


    if (renderer.message?.runs) {


        return renderer.message.runs

            .map(run => {


                if (run.text)
                    return run.text;


                if (run.emoji)
                    return run.emoji.shortcuts?.[0]
                        || "😀";


                return "";


            })

            .join("");

    }



    // Super Chat fallback

    if (renderer.headerSubtext?.runs) {


        return renderer.headerSubtext.runs

            .map(r => r.text || "")

            .join("");

    }



    return "";

}





//
// Identify message type
//

function getMessageType(renderer) {


    if (
        renderer.purchaseAmountText
    ) {

        return "superchat";

    }



    if (
        renderer.liveChatMembershipItemRenderer
    ) {

        return "membership";

    }



    if (
        renderer.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer
    ) {

        return "gift";

    }



    return "message";

}
//
// Stop YouTube chat
//

function stop() {

    stopped = true;


    if (liveChat) {

        try {

            liveChat.stop();

            console.log(
                "[youtubeChat] Stopped"
            );


        } catch(err) {


            console.error(
                "[youtubeChat] stop error:",
                err.message
            );


        }

    }


    liveChat = null;


    seenMessages.clear();

}




//
// Optional debug helper
// Useful if YouTube changes events again
//

function debugEvents() {


    if (!liveChat)
        return;



    const events = [

        "chat-update",

        "metadata-update",

        "message",

        "start",

        "end",

        "error"

    ];



    for (const event of events) {


        liveChat.on(
            event,
            (...args)=>{


                console.log(
                    `[youtubeChat:event] ${event}`,
                    args.length
                );


            }
        );


    }

}





module.exports = {

    start,

    stop,

    isConfigured,

    debugEvents

};
