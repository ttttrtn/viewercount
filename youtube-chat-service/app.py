import logging
import os
import threading
import time
import sqlite3
import queue
import requests
from flask import Flask, jsonify, request
import pytchat

# Configuration
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
STATIC_VIDEO_ID = os.environ.get("VIDEO_ID", "").strip()
PORT = int(os.environ.get("PORT", "5006"))
CHAT_BUFFER_MAX = 200

# Setup Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger("youtube-chat-sidecar")

# DB Setup for persistence
log_queue = queue.Queue()

def db_worker():
    conn = sqlite3.connect("chat_logs.db", check_same_thread=False)
    cursor = conn.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_logs 
                      (channel_id TEXT, author TEXT, message TEXT, timestamp INTEGER)''')
    conn.commit()
    while True:
        channel_id, messages = log_queue.get()
        if messages:
            data = [(channel_id, m["author"], m["message"], m["timestamp"]) for m in messages]
            cursor.executemany("INSERT INTO chat_logs VALUES (?, ?, ?, ?)", data)
            conn.commit()
        log_queue.task_done()

threading.Thread(target=db_worker, daemon=True, name="DBWorker").start()

# State Management
state_lock = threading.Lock()
channels = {}

def get_channel_state(channel_id):
    with state_lock:
        if channel_id not in channels:
            channels[channel_id] = {
                "chat": None, 
                "lock": threading.Lock(), 
                "buffer": []
            }
        return channels[channel_id]

def get_live_id(channel_id):
    if STATIC_VIDEO_ID: 
        return STATIC_VIDEO_ID
    if not YOUTUBE_API_KEY: 
        return None
    try:
        r = requests.get("https://www.googleapis.com/youtube/v3/search", params={
            "key": YOUTUBE_API_KEY, "channelId": channel_id, "eventType": "live", 
            "type": "video", "part": "id"
        }, timeout=10)
        items = r.json().get("items", [])
        return items[0]["id"]["videoId"] if items else None
    except Exception as e:
        logger.error("Search failed: %s", e)
        return None

app = Flask(__name__)

@app.route("/chat")
def chat():
    cid = request.args.get("channel_id", "default")
    st = get_channel_state(cid)
    
    with st["lock"]:
        # Reconnect if chat is None or connection is dead
        if st["chat"] is None or not st["chat"].is_alive():
            vid = get_live_id(cid)
            if vid:
                logger.info("Initializing pytchat for video: %s", vid)
                # FIX: Added interruptable=False to prevent signal errors in threads
                st["chat"] = pytchat.create(video_id=vid, interruptable=False)
            else:
                return jsonify({"live": False, "messages": []})
        
        # Pull messages
        data = st["chat"].get()
        items = data.sync_items()
        
        if items:
            new_msgs = [{"author": c.author.name, "message": c.message, "timestamp": c.timestamp} for c in items]
            st["buffer"].extend(new_msgs)
            st["buffer"] = st["buffer"][-CHAT_BUFFER_MAX:]
            log_queue.put((cid, new_msgs))
            
    return jsonify({"live": True, "messages": st["buffer"]})

@app.route("/health")
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
