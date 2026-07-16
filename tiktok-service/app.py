"""
TikTok LIVE sidecar service.

Wraps TikTokLive.py (isaackogan/TikTokLive) - the current, actively
maintained Python library for connecting to TikTok LIVE - and exposes a
tiny HTTP API that the main Node.js overlay server polls.

Endpoints:
    GET /status  -> {"live": bool, "viewers": int}
    GET /health  -> {"ok": true}   (simple liveness check for Render)

Design:
    - While offline, calls TikTokLiveClient.is_live() on a slow interval
      (OFFLINE_POLL_SECONDS). is_live() does not open a websocket, so it's
      cheap and safe to call repeatedly.
    - Once live, connects via client.start(fetch_room_info_on_connect=True)
      in the background and listens for viewer-count and disconnect
      events, updating in-memory state as they arrive.
    - On disconnect/stream end, or any unexpected exception in the
      connection loop, the background task logs the error, waits a short
      backoff period, and returns to the offline polling loop - so the
      service recovers automatically from network blips without needing
      to be restarted.
"""

import asyncio
import logging
import os
import threading
import time

from flask import Flask, jsonify

from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent, DisconnectEvent, LiveEndEvent

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

# Chat comments buffered since the last time GET /chat was polled. Node
# polls this endpoint every ~1.5s and drains the buffer each time, so the
# same overlay-facing normalization/dedup logic used for the other
# platforms lives on the Node side; this sidecar just forwards raw events.
chat_lock = threading.Lock()
chat_buffer = []


def set_state(live: bool, viewers: int = 0):
    with state_lock:
        state["live"] = live
        state["viewers"] = viewers if live else 0


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
    """Turns TikTokLive.py's own documented per-user properties into unified
    badge objects (see the library's ExtendedUser API docs:
    https://isaackogan.github.io/TikTokLive/TikTokLive.proto.html):

      - is_moderator     (bool)              -> moderator
      - is_subscriber    (bool)              -> subscriber
      - is_top_gifter    (bool)              -> top gifter
      - verified         (bool)              -> TikTok-verified account
      - subscriber_badge (BadgeStruct|None)  -> REAL image for the
                                                 subscriber badge specifically
                                                 (the only one of these
                                                 TikTokLive exposes actual
                                                 art for)

    "Host" isn't one of TikTokLive's documented user properties, so instead
    of guessing a field name we do a real, verifiable check: does this
    commenter's unique_id match the channel we connected to?
    """
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

    if DEBUG_BADGES and badges:
        logger.info("[tiktok badges] %s -> %s", getattr(user, "nickname", "?"), badges)

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
        except Exception as exc:  # network hiccup, TikTok rate limit, etc.
            logger.error("is_live() check failed: %s", exc)
            set_state(False)
            await asyncio.sleep(RECONNECT_BACKOFF_SECONDS)
            continue

        if not is_live:
            set_state(False)
            await asyncio.sleep(OFFLINE_POLL_SECONDS)
            continue

        logger.info("%s is LIVE - connecting to read viewer count.", unique_id)

        # Register event handlers fresh for each connection.
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

        try:
            await client.start(fetch_room_info_on_connect=True)

            # After connecting, room_info (if available) contains current
            # viewer stats; keep refreshing them periodically while the
            # underlying connection is alive.
            while client.connected:
                try:
                    room_info = client.room_info or {}
                    stats = room_info.get("stats") or room_info.get("liveRoomStats") or {}
                    viewers = (
                        stats.get("userCount")
                        or stats.get("user_count")
                        or stats.get("viewerCount")
                        or 0
                    )
                    set_state(True, int(viewers))
                except Exception as inner_exc:
                    logger.error("Error reading room_info: %s", inner_exc)

                await asyncio.sleep(10)

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
