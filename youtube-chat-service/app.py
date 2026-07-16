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
PORT = int(os.environ.get("PORT", "5006"))
SEARCH_POLL_SECONDS = 180
CHAT_BUFFER_MAX = 200

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] [%(threadName)s] %(name)s: %(message)s'
)
logger = logging.getLogger("youtube-chat-sidecar")

# Thread-safe persistent logging queue
log_queue = queue.Queue()

def db_worker():
    """Background worker to handle SQLite writes without blocking API."""
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

# Start background writer
threading.Thread(target=db_worker, daemon=True, name="DBWorker").start()

# State Management
state_lock = threading.Lock()
channels = {}

def get_channel_state(channel_id):
    with state_lock:
        if channel_id not in channels:
            channels[channel_id] = {
                "video_id": None, "chat": None, "last_search_at": 0,
                "buffer": [], "lock": threading.Lock()
            }
        return channels[channel_id]

def find_live_video_id(channel_id):
    if not YOUTUBE_API_KEY: return None
    try:
        resp = requests.get("https://www.googleapis.com/youtube/v3/search", params={
            "key": YOUTUBE_API_KEY, "channelId": channel_id, "eventType": "live", 
            "type": "video", "part": "id"
        }, timeout=10)
        items = resp.json().get("items", [])
        return items[0]["id"]["videoId"] if items else None
    except Exception as e:
        logger.error("Search API error for %s: %s", channel_id, e)
        return None

def author_badges(author):
    badges = []
    if getattr(author, "isChatOwner", False): badges.append({"id": "owner", "name": "Owner"})
    if getattr(author, "isChatModerator", False): badges.append({"id": "moderator", "name": "Mod"})
    if getattr(author, "isChatSponsor", False):
        b = {"id": "member", "name": "Member"}
        if author.badgeUrl: b["icon"] = author.badgeUrl
        badges.append(b)
    return badges

def drain_new_comments(channel_id):
    st = get_channel_state(channel_id)
    with st["lock"]:
        if st["chat"] is None or not st["chat"].is_alive():
            return list(st["buffer"])

        data = st["chat"].get()
        items = data.sync_items() if hasattr(data, "sync_items") else data.items
        if items:
            new_msgs = [{
                "author": c.author.name, "message": c.message, 
                "timestamp": c.timestamp, "badges": author_badges(c.author)
            } for c in items]
            
            st["buffer"].extend(new_msgs)
            st["buffer"] = st["buffer"][-CHAT_BUFFER_MAX:]
            log_queue.put((channel_id, new_msgs)) # Send to background worker
            
        return list(st["buffer"])

app = Flask(__name__)

@app.route("/chat")
def chat():
    cid = request.args.get("channel_id", "").strip()
    if not cid: return jsonify({"error": "Missing channel_id"}), 400
    
    st = get_channel_state(cid)
    with st["lock"]:
        if st["chat"] is None or not st["chat"].is_alive():
            # Check if we should re-search
            if time.time() - st["last_search_at"] > SEARCH_POLL_SECONDS:
                st["last_search_at"] = time.time()
                vid = find_live_video_id(cid)
                if vid:
                    st["chat"] = pytchat.create(video_id=vid)
                    st["video_id"] = vid
                    logger.info("Connected to %s", vid)
        
        live = st["chat"] is not None and st["chat"].is_alive()
        
    return jsonify({"live": live, "messages": drain_new_comments(cid) if live else []})

@app.route("/health")
def health():
    return jsonify({"ok": True, "ts": time.time()})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
