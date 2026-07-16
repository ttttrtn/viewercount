import os
import threading
import time

from flask import Flask, jsonify, request
from chat_downloader import ChatDownloader

app = Flask(__name__)

PORT = int(os.environ.get("PORT", "10000"))
CHAT_BUFFER_MAX = 200

buffer = []
buffer_lock = threading.Lock()

streams = {}


class StreamReader:

    def __init__(self, video_url):
        self.video_url = video_url
        self.messages = []
        self.running = True

        self.thread = threading.Thread(
            target=self.worker,
            daemon=True
        )
        self.thread.start()

    def worker(self):

        while self.running:

            try:

                chat = ChatDownloader().get_chat(
                    self.video_url
                )

                for msg in chat:

                    message = {
                        "platform": "youtube",
                        "id": msg.get("message_id"),
                        "author": msg.get("author", {}).get("name", "Unknown"),
                        "message": msg.get("message", ""),
                        "timestamp": msg.get("timestamp")
                    }

                    with buffer_lock:
                        self.messages.append(message)
                        self.messages = self.messages[-CHAT_BUFFER_MAX:]

            except Exception as e:

                print("Chat error:", e)

                time.sleep(5)


@app.route("/chat")
def chat():

    video_id = request.args.get("video_id")

    if not video_id:
        return jsonify({
            "live": False,
            "error": "Missing video_id"
        })

    url = f"https://www.youtube.com/watch?v={video_id}"

    if video_id not in streams:

        print("Starting reader:", video_id)

        streams[video_id] = StreamReader(url)

    return jsonify({
        "live": True,
        "messages": streams[video_id].messages
    })


@app.route("/health")
def health():

    return jsonify({
        "status": "ok"
    })


@app.route("/")
def root():

    return jsonify({
        "service": "youtube-chat",
        "status": "running"
    })


if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=PORT
    )
