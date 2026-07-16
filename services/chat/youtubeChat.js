// YouTube live chat via youtubei.js
//
// Environment:
// YOUTUBE_VIDEO_ID - Current YouTube Live video ID
// Example: sNnMeQsXXXk

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


    const youtube = await Innertube.create();


    const info =
      await youtube.getInfo(
        YOUTUBE_VIDEO_ID
      );


    liveChat =
      info.getLiveChat();


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


    liveChat.on(
      "chat-update",
      async(data)=>{


        if (!data.actions)
          return;


        for (const action of data.actions) {


          const item =
            action.item;


          if (!item)
            continue;


          const message =
            item.message
              ?.toString();


          if (!message)
            continue;


          const username =
            item.author?.name ||
            "Unknown";


          const id =
            item.id ||
            `${username}:${message}`;


          if (seenMessages.has(id))
            continue;


          seenMessages.add(id);


          if (seenMessages.size > 1000)
            seenMessages.clear();



          const base = {

            username,

            message,

            color:null,

            timestamp:
              Math.floor(
                Date.now()/1000
              )

          };


          let badges=[];


          try {

            badges =
              await youtubeBadges.resolveBadges(
                item.author?.badges
              );


          } catch(err){

            console.error(
              "[youtubeChat] badge error",
              err.message
            );

          }


          onMessageCb?.({
            ...base,
            badges
          });

        }

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


function stop(){

  stopped=true;


  if(liveChat){

    try {

      liveChat.stop();

    } catch(e){}

  }

}


module.exports = {
  start,
  stop,
  isConfigured
};
