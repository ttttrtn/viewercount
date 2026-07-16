from flask import Flask, request, jsonify
from chat_downloader import ChatDownloader
import threading
import time

app = Flask(__name__)

print("=== CHAT DOWNLOADER SERVICE LOADED ===")

downloader = ChatDownloader()

active_chats = {}
chat_messages = {}
chat_status = {}


def start_chat(video_id):
    if video_id in active_chats:
        return

    active_chats[video_id] = True
    chat_messages[video_id] = []
    chat_status[video_id] = False

    def worker():
        try:
            url = f"https://www.youtube.com/watch?v={video_id}"

            print("CONNECTING:", url)

            chat = downloader.get_chat(url)

            chat_status[video_id] = True

            print("CONNECTED TO CHAT:", video_id)

            for message in chat:
                if not active_chats.get(video_id):
                    break

                data = {
                    "author": (
                        message.get("author", {})
                        .get("name", "unknown")
                        if isinstance(message.get("author"), dict)
                        else str(message.get("author", "unknown"))
                    ),
                    "message": message.get("message", ""),
                    "timestamp": int(time.time())
                }

                print("MESSAGE:", data)

                chat_messages[video_id].append(data)

                # keep last 100 messages
                chat_messages[video_id] = chat_messages[video_id][-100:]

        except Exception as e:
            print("CHAT ERROR:", e)
            chat_status[video_id] = False


    threading.Thread(
        target=worker,
        daemon=True
    ).start()


@app.route("/")
def home():
    return "YouTube Chat Downloader Online"


@app.route("/chat")
def chat():

    video_id = request.args.get("video_id")

    print("REQUEST:", video_id)

    if not video_id:
        return jsonify({
            "live": False,
            "messages": [],
            "error": "missing video_id"
        })


    if video_id not in active_chats:
        start_chat(video_id)


    return jsonify({
        "live": chat_status.get(video_id, False),
        "messages": chat_messages.get(video_id, [])
    })


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=10000
    )
