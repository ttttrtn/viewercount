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
from TikTokLive.events import DisconnectEvent, LiveEndEvent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tiktok-sidecar")

TIKTOK_USERNAME = os.environ.get("TIKTOK_USERNAME", "").strip()
PORT = int(os.environ.get("PORT", "5005"))

OFFLINE_POLL_SECONDS = 30
RECONNECT_BACKOFF_SECONDS = 15

# Shared state between the asyncio background thread and the Flask routes.
state_lock = threading.Lock()
state = {"live": False, "viewers": 0}


def set_state(live: bool, viewers: int = 0):
    with state_lock:
        state["live"] = live
        state["viewers"] = viewers if live else 0


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

                await asyncio.sleep(5)

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


@app.route("/health")
def health():
    return jsonify({"ok": True, "time": int(time.time())})


if __name__ == "__main__":
    monitor_thread = threading.Thread(target=start_background_loop, daemon=True)
    monitor_thread.start()

    app.run(host="0.0.0.0", port=PORT)
