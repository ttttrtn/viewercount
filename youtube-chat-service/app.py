import os
import threading
from flask import Flask, jsonify, request
from chat_downloader import ChatDownloader

app = Flask(__name__)

PORT = int(os.environ.get("PORT", "10000"))
CHAT_BUFFER_MAX = 200

buffers = {}
threads = {}

lock = threading.Lock()


def start_chat(video_id):

    if video_id in threads:
        return

    def worker():

        print("Starting chat:", video_id)

        try:
            downloader = ChatDownloader()

            chat = downloader.get_chat(
                f"https://www.youtube.com/watch?v={video_id}"
            )

            for message in chat:

                item = {
                    "id": message.get("message_id"),
                    "author": message.get("author", {}).get("name", "Unknown"),
                    "message": message.get("message", ""),
                    "timestamp": message.get("timestamp")
                }

                print("NEW MESSAGE:", item)

                with lock:
                    buffers[video_id].append(item)
                    buffers[video_id] = buffers[video_id][-CHAT_BUFFER_MAX:]

        except Exception as e:
            print("CHAT ERROR:", e)


    buffers[video_id] = []

    t = threading.Thread(
        target=worker,
        daemon=True
    )

    threads[video_id] = t
    t.start()


@app.route("/chat")
def chat():

    video_id = request.args.get("video_id")

    if not video_id:
        return jsonify({
            "live": False,
            "messages": []
        })


    if video_id not in threads:
        start_chat(video_id)


    with lock:
        msgs = buffers.get(video_id, [])


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


@app.route("/")
def home():
    return jsonify({
        "service": "youtube-chat",
        "status": "running"
    })


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=PORT
    )
