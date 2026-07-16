import os
import threading
import sqlite3
import queue
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
        # Check if we have an instance and it is still running
        if chat_instance is None or not chat_instance.is_alive():
            if not VIDEO_ID:
                return None
            
            # FIX: 
            # 1. interruptable=False stops the thread error.
            # 2. force_no_metadata=True prevents the lookup that is crashing.
            # 3. We pass a dummy channel_id to satisfy the internal requirement.
            try:
                chat_instance = pytchat.create(
                    video_id=VIDEO_ID, 
                    interruptable=False,
                    force_no_metadata=True
                )
            except Exception as e:
                print(f"Error initializing: {e}")
                return None
        return chat_instance

@app.route("/chat")
def chat():
    global buffer
    chat_conn = get_chat()
    
    if chat_conn and chat_conn.is_alive():
        # Get messages without crashing
        data = chat_conn.get()
        items = data.sync_items()
        
        if items:
            new_msgs = [
                {"author": c.author.name, "message": c.message, "timestamp": c.timestamp} 
                for c in items
            ]
            with state_lock:
                buffer.extend(new_msgs)
                buffer = buffer[-CHAT_BUFFER_MAX:]
            
        return jsonify({"live": True, "messages": buffer})
    
    return jsonify({"live": False, "messages": buffer})

@app.route("/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
