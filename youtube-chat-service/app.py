import os
import time
import threading
import requests

from flask import Flask, jsonify, request

app = Flask(__name__)

PORT = int(os.environ.get("PORT", 10000))

CHAT_BUFFER_MAX = 200

streams = {}
lock = threading.Lock()


INNERTUBE_KEY = os.environ.get(
    "YOUTUBE_INNERTUBE_KEY",
    "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
)


def innertube_request(payload):

    url = (
        "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
        f"?key={INNERTUBE_KEY}"
    )

    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.post(
        url,
        json=payload,
        headers=headers,
        timeout=15
    )

    print(
        "InnerTube status:",
        response.status_code
    )

    return response.json()



class YouTubeChat:

    def __init__(self, video_id):

        self.video_id = video_id
        self.messages = []
        self.continuation = None

        print(
            "CREATING CHAT THREAD:",
            video_id
        )

        self.thread = threading.Thread(
            target=self.worker,
            daemon=True
        )

        self.thread.start()


    def worker(self):

        print(
            "WORKER STARTED:",
            self.video_id
        )


        try:

            payload = {

                "context": {

                    "client": {

                        "clientName": "WEB",
                        "clientVersion": "2.20250715.01.00"

                    }

                },

                "videoId": self.video_id
            }


            print(
                "REQUESTING INITIAL CHAT"
            )


            data = innertube_request(
                payload
            )


            print(
                "INITIAL KEYS:",
                list(data.keys())
            )


            continuation = (
                data
                .get("continuationContents", {})
                .get("liveChatContinuation", {})
            )


            continuations = (
                continuation
                .get("continuations", [])
            )


            if continuations:

                self.continuation = (
                    continuations[0]
                    .get("timedContinuationData", {})
                    .get("continuation")
                    or
                    continuations[0]
                    .get("invalidationContinuationData", {})
                    .get("continuation")
                )


            print(
                "CONTINUATION:",
                self.continuation
            )


        except Exception as e:

            print(
                "INITIAL CHAT ERROR:",
                repr(e)
            )

            return



        while True:

            try:

                if not self.continuation:

                    print(
                        "NO CONTINUATION"
                    )

                    time.sleep(5)
                    continue


                payload = {

                    "context": {

                        "client": {

                            "clientName": "WEB",
                            "clientVersion": "2.20250715.01.00"

                        }

                    },

                    "continuation": self.continuation

                }


                data = innertube_request(
                    payload
                )


                chat = (
                    data
                    .get("continuationContents", {})
                    .get("liveChatContinuation", {})
                )


                for action in chat.get(
                    "actions",
                    []
                ):

                    renderer = (
                        action
                        .get("addChatItemAction", {})
                        .get("item", {})
                        .get("liveChatTextMessageRenderer")
                    )


                    if not renderer:
                        continue


                    author = (
                        renderer
                        .get("authorName", {})
                        .get("simpleText",
                             "Unknown")
                    )


                    message = ""

                    for run in (
                        renderer
                        .get("message", {})
                        .get("runs", [])
                    ):

                        message += run.get(
                            "text",
                            ""
                        )


                    item = {

                        "id": renderer.get("id"),
                        "author": author,
                        "message": message,
                        "timestamp": int(
                            time.time()
                        )

                    }


                    print(
                        "CHAT MESSAGE:",
                        item
                    )


                    with lock:

                        self.messages.append(
                            item
                        )

                        self.messages = (
                            self.messages[-CHAT_BUFFER_MAX:]
                        )


                next_cont = (
                    chat
                    .get("continuations", [])
                )

                if next_cont:

                    self.continuation = (
                        next_cont[0]
                        .get("timedContinuationData", {})
                        .get("continuation")
                    )


                time.sleep(2)


            except Exception as e:

                print(
                    "CHAT LOOP ERROR:",
                    repr(e)
                )

                time.sleep(5)



@app.route("/")
def home():

    return jsonify({
        "service": "youtube-inner-tube-chat",
        "status": "running"
    })



@app.route("/chat")
def chat():

    video_id = request.args.get("video_id")

    print("CHAT REQUEST VIDEO ID:", video_id)

    if not video_id:
        return jsonify({
            "live": False,
            "messages": [],
            "error": "missing video_id"
        })


    if video_id not in streams:

        print("CREATING NEW STREAM:", video_id)

        streams[video_id] = YouTubeChat(video_id)


    else:

        print("STREAM EXISTS:", video_id)


    with lock:

        msgs = streams[video_id].messages


    print(
        "RETURNING MESSAGES:",
        len(msgs)
    )


    return jsonify({

        "live": True,
        "video_id": video_id,
        "messages": msgs

    })

@app.route("/health")
def health():

    return jsonify({
        "status": "ok"
    })



if __name__ == "__main__":

    print(
        "=== INNER TUBE CHAT SERVICE LOADED ==="
    )

    app.run(
        host="0.0.0.0",
        port=PORT
    )
