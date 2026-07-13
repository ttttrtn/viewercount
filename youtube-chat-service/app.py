"""
YouTube live chat sidecar.

Wraps pytchat (taizan-hokuto/pytchat) - the requested library for reading
YouTube live chat without the expensive liveChatMessages.list polling
quota cost of the official Data API - and exposes a tiny HTTP API that
the main Node.js overlay server polls, mirroring the TikTok sidecar's
shape exactly (GET /chat -> {"live": bool, "messages": [...]}).

pytchat itself needs a specific *video id*, not a channel id, so this
service has one extra job the TikTok sidecar doesn't: resolving "what is
this channel's current live video id right now". It does that with the
official YouTube Data API's cheap videos.list-friendly path when
possible, falling back to search.list (100 quota units) only when no
cached video id is already known - the exact same quota-conscious
approach services/youtube/officialProvider.js uses on the Node side.

Endpoints:
    GET /chat?channel_id=UC...  -> {"live": bool, "messages": [...]}
    GET /health                 -> {"ok": true}

YOUTUBE_API_KEY - required to resolve channel_id -> live video id.
"""

import logging
import os
import threading
import time

import requests
from flask import Flask, jsonify, request

import pytchat

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("youtube-chat-sidecar")

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
PORT = int(os.environ.get("PORT", "5006"))

SEARCH_POLL_SECONDS = 120  # how often to re-check for a live video while offline
CHAT_BUFFER_MAX = 200

# Per-channel state: { channel_id: {"video_id": str|None, "chat": pytchat.LiveChat|None,
#                                    "last_search_at": float, "buffer": [...]} }
state_lock = threading.Lock()
channels = {}


def get_channel_state(channel_id):
    with state_lock:
        if channel_id not in channels:
            channels[channel_id] = {
                "video_id": None,
                "chat": None,
                "last_search_at": 0,
                "buffer": [],
            }
        return channels[channel_id]


def find_live_video_id(channel_id):
    if not YOUTUBE_API_KEY:
        logger.error("YOUTUBE_API_KEY is not set - cannot resolve live video id.")
        return None

    try:
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "key": YOUTUBE_API_KEY,
                "channelId": channel_id,
                "eventType": "live",
                "type": "video",
                "part": "id",
            },
            timeout=10,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if not items:
            return None
        return items[0]["id"]["videoId"]
    except Exception as exc:
        logger.error("search.list failed for %s: %s", channel_id, exc)
        return None


def ensure_chat_connection(channel_id):
    """Makes sure we have a live pytchat connection for this channel if one
    is currently live; tears down stale connections; returns current live
    video id or None."""
    st = get_channel_state(channel_id)
    now = time.time()

    # Existing connection: check it's still alive.
    if st["chat"] is not None:
        if st["chat"].is_alive():
            return st["video_id"]
        logger.info("pytchat connection for %s (video %s) ended.", channel_id, st["video_id"])
        try:
            st["chat"].terminate()
        except Exception:
            pass
        st["chat"] = None
        st["video_id"] = None

    # No connection - only re-search on a slow interval to respect quota.
    if now - st["last_search_at"] < SEARCH_POLL_SECONDS:
        return None

    st["last_search_at"] = now
    video_id = find_live_video_id(channel_id)
    if not video_id:
        return None

    logger.info("Channel %s is LIVE (video %s) - connecting pytchat.", channel_id, video_id)
    try:
        st["chat"] = pytchat.create(video_id=video_id)
        st["video_id"] = video_id
    except Exception as exc:
        logger.error("pytchat.create failed for %s: %s", video_id, exc)
        st["chat"] = None
        st["video_id"] = None
        return None

    return video_id


def drain_new_comments(channel_id):
    st = get_channel_state(channel_id)
    if st["chat"] is None:
        return []

    try:
        if not st["chat"].is_alive():
            return []
        data = st["chat"].get()
        items = data.sync_items() if hasattr(data, "sync_items") else data.items
        return [
            {"author": c.author.name, "message": c.message, "timestamp": c.timestamp}
            for c in items
        ]
    except Exception as exc:
        logger.error("Error reading pytchat buffer for %s: %s", channel_id, exc)
        return []


app = Flask(__name__)


@app.route("/chat")
def chat():
    channel_id = request.args.get("channel_id", "").strip()
    if not channel_id:
        return jsonify({"error": "channel_id query param is required"}), 400

    ensure_chat_connection(channel_id)
    st = get_channel_state(channel_id)
    live = st["chat"] is not None
    messages = drain_new_comments(channel_id) if live else []

    return jsonify({"live": live, "messages": messages})


@app.route("/health")
def health():
    return jsonify({"ok": True, "time": int(time.time())})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
