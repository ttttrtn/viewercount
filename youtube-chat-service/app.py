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


class YouTubeChat:

    def __init__(self, video_id):
        self.video_id = video_id
        self.messages = []
        self.running = True
        self.continuation = None

        self.thread = threading.Thread(
            target=self.worker,
            daemon=True
        )

        self.thread.start()


    def get_initial_data(self):

        url = (
            "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
            "?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
        )

        payload = {
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": "2.20260101.00.00"
                }
            },
            "videoId": self.video_id
        }

        r = requests.post(
            url,
            json=payload,
            timeout=10
        )

        return r.json()



    def worker(self):

        print(
            "Starting InnerTube chat:",
            self.video_id
        )

        try:

            data = self.get_initial_data()

            actions = (
                data
                .get("continuationContents", {})
                .get("liveChatContinuation", {})
            )

            self.continuation = (
                actions
                .get("continuations", [{}])[0]
                .get("invalidationContinuationData", {})
                .get("continuation")
            )


        except Exception as e:

            print(
                "Initial chat error:",
                e
            )

            return



        while self.running:

            try:

                if not self.continuation:
                    time.sleep(5)
                    continue


                url = (
                    "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
                    "?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
                )


                payload = {
                    "context": {
                        "client": {
                            "clientName": "WEB",
                            "clientVersion": "2.20260101.00.00"
                        }
                    },
                    "continuation": self.continuation
                }


                r = requests.post(
                    url,
                    json=payload,
                    timeout=10
                )


                data = r.json()


                continuation = (
                    data
                    .get("continuationContents", {})
                    .get("liveChatContinuation", {})
                )


                self.continuation = (
                    continuation
                    .get("continuations", [{}])[0]
                    .get("timedContinuationData", {})
                    .get("continuation")
                )


                actions = continuation.get(
                    "actions",
                    []
                )


                for action in actions:

                    item = (
                        action
                        .get("addChatItemAction", {})
                        .get("item", {})
                    )


                    renderer = (
                        item
                        .get("liveChatTextMessageRenderer")
                    )


                    if renderer:

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


                        msg = {
                            "id": renderer.get(
                                "id"
                            ),
                            "author": author,
                            "message": message,
                            "timestamp": int(
                                time.time()
                            )
                        }


                        print(
                            "CHAT:",
                            msg
                        )


                        with lock:

                            self.messages.append(
                                msg
                            )

                            self.messages = (
                                self.messages[-CHAT_BUFFER_MAX:]
                            )


                time.sleep(2)


            except Exception as e:

                print(
                    "Chat loop error:",
                    e
                )

                time.sleep(5)



@app.route("/chat")
def chat():

    video_id = request.args.get(
        "video_id"
    )

    if not video_id:

        return jsonify({
            "live": False,
            "messages": []
        })


    if video_id not in streams:

        streams[video_id] = YouTubeChat(
            video_id
        )


    with lock:

        messages = streams[video_id].messages


    return jsonify({

        "live": True,
        "video_id": video_id,
        "messages": messages

    })



@app.route("/")
def home():

    return jsonify({
        "service": "youtube-inner-tube-chat",
        "status": "running"
    })


@app.route("/health")
def health():

    return jsonify({
        "status": "ok"
    })



if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=PORT
    )
