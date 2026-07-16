import os
import threading
from flask import Flask, jsonify
import pytchat

# Configuration
VIDEO_ID = os.environ.get("VIDEO_ID", "").strip()
PORT = int(os.environ.get("PORT", "5006"))
CHAT_BUFFER_MAX = 200

# State Management
buffer = []
state_lock = threading.Lock()
chat_instance = None

app = Flask(__name__)


def get_chat():
    global chat_instance

    with state_lock:
        if chat_instance is None:
            if not VIDEO_ID:
                print("Missing VIDEO_ID")
                return None

            try:
                print("Starting YouTube chat...")
                
                chat_instance = pytchat.create(
                    video_id=VIDEO_ID
                )

                print("YouTube chat connected")

            except Exception as e:
                print(f"Chat initialization failed: {e}")
                chat_instance = None
                return None

        return chat_instance


@app.route("/chat")
def chat():
    global buffer

    chat_conn = get_chat()

    if not chat_conn:
        return jsonify({
            "live": False,
            "messages": buffer
        })

    try:
        data = chat_conn.get()

        if data:
            items = data.sync_items()

            new_msgs = []

            for c in items:
                new_msgs.append({
                    "author": getattr(c.author, "name", "Unknown"),
                    "message": c.message,
                    "timestamp": c.timestamp
                })

            if new_msgs:
                with state_lock:
                    buffer.extend(new_msgs)
                    buffer = buffer[-CHAT_BUFFER_MAX:]

        return jsonify({
            "live": True,
            "messages": buffer
        })

    except Exception as e:
        print(f"Chat read error: {e}")

        return jsonify({
            "live": False,
            "messages": buffer,
            "error": str(e)
        })


@app.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "video_id": VIDEO_ID
    })


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=PORT
    )
