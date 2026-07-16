import logging
import os
import threading
import time
import sqlite3
import queue
from flask import Flask, jsonify
import pytchat

# Configuration
# Set the VIDEO_ID in your environment (e.g., export VIDEO_ID=sNnMeQsXXXk)
VIDEO_ID = os.environ.get("VIDEO_ID", "").strip()
PORT = int(os.environ.get("PORT", "5006"))
CHAT_BUFFER_MAX = 200

# Setup Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger("youtube-chat-sidecar")

# DB Setup
log_queue = queue.Queue()

def db_worker():
    conn = sqlite3.connect("chat_logs.db", check_same_thread=False)
    cursor = conn.cursor()
    cursor.execute('CREATE TABLE IF NOT EXISTS chat_logs (author TEXT, message TEXT, timestamp INTEGER)')
    conn.commit()
    while True:
        messages = log_queue.get()
        if messages:
            cursor.executemany("INSERT INTO chat_logs VALUES (?, ?, ?)", 
                               [(m["author"], m["message"], m["timestamp"]) for m in messages])
            conn.commit()
        log_queue.task_done()

threading.Thread(target=db_worker, daemon=True, name="DBWorker").start()

# Initialize Chat Object (Global)
chat_instance = None
buffer = []
state_lock = threading.Lock()

def get_chat():
    global chat_instance
    with state_lock:
        if chat_instance is None or not chat_instance.is_alive():
            if not VIDEO_ID:
                logger.error("VIDEO_ID environment variable is missing!")
                return None
            logger.info("Connecting to video: %s", VIDEO_ID)
            # interruptable=False is critical for server/thread environments
            chat_instance = pytchat.create(video_id=VIDEO_ID, interruptable=False)
        return chat_instance

app = Flask(__name__)

@app.route("/chat")
def chat():
    global buffer
    chat_conn = get_chat()
    
    if chat_conn and chat_conn.is_alive():
        data = chat_conn.get()
        items = data.sync_items()
        
        if items:
            new_msgs = [{"author": c.author.name, "message": c.message, "timestamp": c.timestamp} for c in items]
            with state_lock:
                buffer.extend(new_msgs)
                buffer = buffer[-CHAT_BUFFER_MAX:]
            log_queue.put(new_msgs)
            
        return jsonify({"live": True, "messages": buffer})
    
    return jsonify({"live": False, "messages": []})

@app.route("/health")
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
