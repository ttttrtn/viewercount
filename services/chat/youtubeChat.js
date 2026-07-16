//
// YouTube Live Chat via youtubei.js 17.2+
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



        let info;


        try {

            info =
                await youtube.getInfo(
                    YOUTUBE_VIDEO_ID
                );


        } catch(err) {


            console.error(
                "[youtubeChat] getInfo failed:",
                err.message
            );


            return;

        }



        console.log(
            "[youtubeChat] Video:",
            info.basic_info?.title || "Unknown"
        );



        liveChat =
            await info.getLiveChat();



        if (!liveChat) {


            console.error(
                "[youtubeChat] No live chat found"
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



        liveChat.on(
            "chat-update",
            async(data)=>{


                if (!data?.actions)
                    return;


                for (const action of data.actions) {

                    await parseAction(
                        action
                    );

                }


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


    }

}






async function parseAction(action) {


    const item =

        action.item ||

        action.addChatItemAction?.item ||

        action.replayChatItemAction
            ?.actions?.[0]
            ?.addChatItemAction
            ?.item;



    if (!item)
        return;



    const renderer =

        item.liveChatTextMessageRenderer ||

        item.liveChatPaidMessageRenderer ||

        item.liveChatMembershipItemRenderer;



    if (!renderer)
        return;



    const username =

        renderer.authorName?.simpleText ||

        renderer.authorName?.runs
            ?.map(x=>x.text)
            .join("") ||

        "Unknown";



    const message =

        renderer.message?.runs
            ?.map(x=>{

                if (x.text)
                    return x.text;


                if (x.emoji)
                    return "😀";


                return "";

            })
            .join("")
        ||

        renderer.headerSubtext?.runs
            ?.map(x=>x.text)
            .join("")
        ||

        "";



    if (!message)
        return;



    const id =
        renderer.id ||
        `${username}:${message}`;



    if (seenMessages.has(id))
        return;



    seenMessages.add(id);



    if (seenMessages.size > 2000)
        seenMessages.clear();



    let badges = [];



    try {


        badges =
            await youtubeBadges.resolveBadges(
                renderer.authorBadges || []
            );


    } catch(err) {


        console.error(
            "[youtubeChat] badge error:",
            err.message
        );

    }




    onMessageCb?.({

        username,

        message,

        badges,

        color:null,


        timestamp:
            Math.floor(
                Date.now() / 1000
            ),



        type:
            renderer.purchaseAmountText
                ? "superchat"
                : "message",



        amount:
            renderer.purchaseAmountText
                ?.simpleText || null


    });


}






function stop() {


    stopped = true;



    if (liveChat) {


        try {

            liveChat.stop();

        } catch(e){}


    }



    liveChat = null;


    seenMessages.clear();


}






module.exports = {

    start,

    stop,

    isConfigured

};
