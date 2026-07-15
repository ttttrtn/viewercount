"""
TikTok LIVE sidecar service.

Wraps TikTokLive.py (isaackogan/TikTokLive) - the current, actively
maintained Python library for connecting to TikTok LIVE - and exposes a
tiny HTTP API that the main Node.js overlay server polls.
"""

import asyncio
import logging
import os
import threading
import time

from flask import Flask, jsonify

from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    CommentEvent, 
    ConnectEvent, 
    DisconnectEvent, 
    LiveEndEvent, 
    RoomUserSeqEvent
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tiktok-sidecar")

TIKTOK_USERNAME = os.environ.get("TIKTOK_USERNAME", "").strip()
PORT = int(os.environ.get("PORT", "5005"))
DEBUG_BADGES = os.environ.get("DEBUG_BADGES", "").strip().lower() == "true"

OFFLINE_POLL_SECONDS = 60
RECONNECT_BACKOFF_SECONDS = 20
CHAT_BUFFER_MAX = 200

# Shared state between the asyncio background thread and the Flask routes.
state_lock = threading.Lock()
state = {"live": False, "viewers": 0}

# Chat comments buffered since the last time GET /chat was polled.
chat_lock = threading.Lock()
chat_buffer = []


def set_state(live: bool, viewers: int = None):
    with state_lock:
        state["live"] = live
        if viewers is not None:
            state["viewers"] = viewers
        elif not live:
            state["viewers"] = 0


def push_comment(nickname: str, comment: str, badges=None):
    with chat_lock:
        chat_buffer.append({"nickname": nickname, "comment": comment, "badges": badges or []})
        if len(chat_buffer) > CHAT_BUFFER_MAX:
            del chat_buffer[: len(chat_buffer) - CHAT_BUFFER_MAX]


def drain_comments():
    with chat_lock:
        drained = list(chat_buffer)
        chat_buffer.clear()
        return drained


def user_badges(user, host_unique_id):
    badges = []

    try:
        if host_unique_id and getattr(user, "unique_id", None):
            commenter_id = user.unique_id if user.unique_id.startswith("@") else f"@{user.unique_id}"
            if commenter_id.lower() == host_unique_id.lower():
                badges.append({"id": "host", "name": "Host"})
    except Exception:
        pass

    if getattr(user, "is_moderator", False):
        badges.append({"id": "moderator", "name": "Moderator"})

    if getattr(user, "is_subscriber", False):
        badge = {"id": "subscriber", "name": "Subscriber"}
        try:
            sub_badge = getattr(user, "subscriber_badge", None)
            if sub_badge and sub_badge.image and sub_badge.image.url_list:
                badge["icon"] = sub_badge.image.url_list[0]
        except Exception:
            pass
        badges.append(badge)

    if getattr(user, "verified", False):
        badges.append({"id": "verified", "name": "Verified"})

    if getattr(user, "is_top_gifter", False):
        badges.append({"id": "top_gifter", "name": "Top Gifter"})

    return badges


async def run_monitor_loop():
    if not TIKTOK_USERNAME:
        logger.error("TIKTOK_USERNAME is not set. Sidecar will stay idle.")
        while True:
            await asyncio.sleep(3600)

    unique_id = TIKTOK_USERNAME if TIKTOK_USERNAME.startswith("@") else f"@{TIKTOK_USERNAME}"

    while True:
        client = TikTokLiveClient(unique_id=unique_id)

        try:
            is_live = await client.is_live()
        except Exception as exc:  
            logger.error("is_live() check failed: %s", exc)
            set_state(False)
            await asyncio.sleep(RECONNECT_BACKOFF_SECONDS)
            continue

        if not is_live:
            set_state(False)
            await asyncio.sleep(OFFLINE_POLL_SECONDS)
            continue

        logger.info("%s is LIVE - attempting to connect...", unique_id)

        # --- EVENT LISTENERS ---
        
        @client.on(ConnectEvent)
        async def on_connect(_event):
            logger.info("Successfully connected to %s!", unique_id)
            # Immediately update status to true the second the websocket connects
            set_state(True)

        @client.on(RoomUserSeqEvent)
        async def on_viewer_count(event):
            # TikTok natively pushes viewer count updates via this event
            viewers = getattr(event, "viewer_count", getattr(event, "total_user", 0))
            set_state(True, int(viewers))

        @client.on(DisconnectEvent)
        async def on_disconnect(_event):
            logger.info("Disconnected from %s.", unique_id)
            set_state(False)

        @client.on(LiveEndEvent)
        async def on_live_end(_event):
            logger.info("%s's livestream ended.", unique_id)
            set_state(False)

        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            try:
                nickname = event.user.nickname if event.user else "unknown"
                badges = user_badges(event.user, unique_id) if event.user else []
                push_comment(nickname, event.comment or "", badges)
            except Exception as exc:
                logger.error("Error handling comment event: %s", exc)

        # --- CONNECTION START ---
        try:
            # In TikTokLive v6, start() takes NO keyword arguments.
            await client.start()
        except Exception as exc:
            logger.error("Connection error for %s: %s", unique_id, exc)
        finally:
            set_state(False)
            try:
                await client.disconnect()
            except Exception:
                pass

        await asyncio.sleep(RECONNECT_BACKOFF_SECONDS)


def start_background_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run_monitor_loop())


app = Flask(__name__)


@app.route("/status")
def status():
    with state_lock:
        return jsonify({"live": state["live"], "viewers": state["viewers"]})


@app.route("/chat")
def chat():
    with state_lock:
        live = state["live"]
    return jsonify({"live": live, "messages": drain_comments()})


@app.route("/health")
def health():
    return jsonify({"ok": True, "time": int(time.time())})


if __name__ == "__main__":
    monitor_thread = threading.Thread(target=start_background_loop, daemon=True)
    monitor_thread.start()

    app.run(host="0.0.0.0", port=PORT)
