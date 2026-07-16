import os
import threading
import requests

from flask import Flask, jsonify, request
import pytchat

app = Flask(__name__)

CHAT_BUFFER_MAX = 200

buffer = []
chat_instance = None
current_video_id = None

lock = threading.Lock()


def find_live_video(channel_id):
    """
    Uses YouTube channel live page to find current live video.
    """

    try:
        url = f"https://www.youtube.com/channel/{channel_id}/live"

        headers = {
            "User-Agent": "Mozilla/5.0"
        }

        r = requests.get(url, headers=headers, timeout=10)

        text = r.text

        marker = '"videoId":"'

        pos = text.find(marker)

        if pos != -1:
            start = pos + len(marker)
            video_id = text[start:start+11]

            if len(video_id) == 11:
                return video_id

    except Exception as e:
        print("Live lookup error:", e)

    return None


def get_chat(video_id):

    global chat_instance, current_video_id

    with lock:

        if (
            chat_instance is None
            or current_video_id != video_id
        ):

            print("Starting YouTube chat:", video_id)

            try:
                chat_instance = pytchat.create(
                    video_id=video_id
                )

                current_video_id = video_id

            except Exception as e:
                print("pytchat error:", e)
                chat_instance = None

    return chat_instance


@app.route("/chat")
def chat():

    global buffer

    channel_id = request.args.get("channel_id")
    video_id = request.args.get("video_id")

    if not video_id and channel_id:
        video_id = find_live_video(channel_id)

    if not video_id:
        return jsonify({
            "live": False,
            "messages": [],
            "error": "No active livestream found"
        })


    chat_conn = get_chat(video_id)


    if not chat_conn:
        return jsonify({
            "live": False,
            "messages": buffer
        })


    try:

        data = chat_conn.get()

        for c in data.sync_items():

            buffer.append({
                "platform": "youtube",
                "author": c.author.name,
                "message": c.message,
                "timestamp": c.timestamp
            })


        buffer = buffer[-CHAT_BUFFER_MAX:]


        return jsonify({
            "live": True,
            "video_id": video_id,
            "messages": buffer
        })


    except Exception as e:

        print("Chat read error:", e)

        return jsonify({
            "live": False,
            "messages": buffer,
            "error": str(e)
        })


@app.route("/health")
def health():
    return jsonify({
        "status": "ok"
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5006))

    app.run(
        host="0.0.0.0",
        port=port
    )
