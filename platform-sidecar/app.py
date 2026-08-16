"""
Combined TikTok + Nimo sidecar service.

This merges what used to be two separate always-on Render services
(/tiktok-service and /nimo-service) into ONE process, because Render's
free tier grants a single pooled budget of 750 instance-hours per
workspace per month - not 750 hours per service. Two always-on free
services already burn ~1,460 hours/month between them (2 x 730), which
blows through that pool in about two weeks. One always-on service uses
~730 hours/month, which fits inside the pool with room to spare.

Both platforms are combined here (not folded into the Node service)
because both require Python:
  - TikTok has no JS-friendly official/unofficial live API; the
    actively-maintained client library (TikTokLive) is Python-only.
  - Nimo has no API at all; reading its chat panel requires driving a
    real browser (Playwright + headless Chromium), which is far outside
    what a lightweight Node process should be doing.

Design:
  - Two independent background workers run in their own threads, each
    with its own asyncio event loop, exactly as they did as separate
    services. Combining them into one process does NOT combine their
    logic or share state - a crash/exception in one worker's loop
    cannot take down the other, because each loop's top-level except
    blocks were already written to catch-log-retry forever (see below).
    This is why combining is safe here: neither loop was relying on a
    dedicated process for isolation, only for reachability.
  - Flask serves both APIs side by side:
      GET /tiktok/status  -> {"live": bool, "viewers": int}
      GET /tiktok/chat    -> {"live": bool, "messages": [...]}
      GET /nimo/chat      -> {"live": bool, "messages": [...]}
      GET /health         -> {"ok": true}
  - Chromium is the dominant resource cost here (~250-350MB RSS headless,
    against a 512MB free-tier ceiling). Launch flags below trim that as
    far as reasonably possible. If NIMO_URL is unset, the Nimo worker
    idles without ever launching a browser, so TikTok-only deployments
    pay none of that memory cost.

If Chromium's memory footprint proves unstable in practice on the free
tier, disable Nimo (unset NIMO_URL) and run it later as a temporary,
manually-started service only while actually streaming to Nimo - do not
silently drop chat forever to "save" resources.
"""

import asyncio
import logging
import os
import threading
import time

from flask import Flask, Response, jsonify

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("platform-sidecar")

PORT = int(os.environ.get("PORT", "5005"))

# ---------------------------------------------------------------------------
# TikTok worker (unchanged logic from the old /tiktok-service/app.py)
# ---------------------------------------------------------------------------
from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    CommentEvent,
    ConnectEvent,
    DisconnectEvent,
    LiveEndEvent,
    RoomUserSeqEvent,
)

TIKTOK_USERNAME = os.environ.get("TIKTOK_USERNAME", "").strip()
TIKTOK_OFFLINE_POLL_SECONDS = 60
TIKTOK_RECONNECT_BACKOFF_SECONDS = 20
TIKTOK_CHAT_BUFFER_MAX = 200

tiktok_state_lock = threading.Lock()
tiktok_state = {"live": False, "viewers": 0}

tiktok_chat_lock = threading.Lock()
tiktok_chat_buffer = []


def tiktok_set_state(live: bool, viewers: int = None):
    with tiktok_state_lock:
        tiktok_state["live"] = live
        if viewers is not None:
            tiktok_state["viewers"] = viewers
        elif not live:
            tiktok_state["viewers"] = 0


def tiktok_push_comment(nickname: str, comment: str, badges=None):
    with tiktok_chat_lock:
        tiktok_chat_buffer.append({"nickname": nickname, "comment": comment, "badges": badges or []})
        if len(tiktok_chat_buffer) > TIKTOK_CHAT_BUFFER_MAX:
            del tiktok_chat_buffer[: len(tiktok_chat_buffer) - TIKTOK_CHAT_BUFFER_MAX]


def tiktok_drain_comments():
    with tiktok_chat_lock:
        drained = list(tiktok_chat_buffer)
        tiktok_chat_buffer.clear()
        return drained


def tiktok_user_badges(user, host_unique_id):
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


async def tiktok_run_monitor_loop():
    if not TIKTOK_USERNAME:
        logger.error("TIKTOK_USERNAME is not set. TikTok worker will stay idle.")
        while True:
            await asyncio.sleep(3600)

    unique_id = TIKTOK_USERNAME if TIKTOK_USERNAME.startswith("@") else f"@{TIKTOK_USERNAME}"

    while True:
        client = TikTokLiveClient(unique_id=unique_id)

        try:
            is_live = await client.is_live()
        except Exception as exc:
            logger.error("[tiktok] is_live() check failed: %s", exc)
            tiktok_set_state(False)
            await asyncio.sleep(TIKTOK_RECONNECT_BACKOFF_SECONDS)
            continue

        if not is_live:
            tiktok_set_state(False)
            await asyncio.sleep(TIKTOK_OFFLINE_POLL_SECONDS)
            continue

        logger.info("[tiktok] %s is LIVE - attempting to connect...", unique_id)

        @client.on(ConnectEvent)
        async def on_connect(_event):
            logger.info("[tiktok] connected to %s!", unique_id)
            tiktok_set_state(True)

        @client.on(RoomUserSeqEvent)
        async def on_viewer_count(event):
            viewers = getattr(event, "viewer_count", getattr(event, "total_user", 0))
            tiktok_set_state(True, int(viewers))

        @client.on(DisconnectEvent)
        async def on_disconnect(_event):
            logger.info("[tiktok] disconnected from %s.", unique_id)
            tiktok_set_state(False)

        @client.on(LiveEndEvent)
        async def on_live_end(_event):
            logger.info("[tiktok] %s's livestream ended.", unique_id)
            tiktok_set_state(False)

        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            try:
                nickname = event.user.nickname if event.user else "unknown"
                badges = tiktok_user_badges(event.user, unique_id) if event.user else []
                tiktok_push_comment(nickname, event.comment or "", badges)
            except Exception as exc:
                logger.error("[tiktok] error handling comment event: %s", exc)

        try:
            await client.start()
        except Exception as exc:
            logger.error("[tiktok] connection error for %s: %s", unique_id, exc)
        finally:
            tiktok_set_state(False)
            try:
                await client.disconnect()
            except Exception:
                pass

        await asyncio.sleep(TIKTOK_RECONNECT_BACKOFF_SECONDS)


def tiktok_start_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(tiktok_run_monitor_loop())


# ---------------------------------------------------------------------------
# Nimo worker (unchanged logic from the old /nimo-service/app.py, with
# memory-lean Chromium launch flags added)
# ---------------------------------------------------------------------------
from playwright.async_api import async_playwright

NIMO_URL = os.environ.get("NIMO_URL", "").strip()
NIMO_POLL_SECONDS = 2
NIMO_RELOAD_BACKOFF_SECONDS = 15
NIMO_CHAT_BUFFER_MAX = 200
NIMO_SEEN_CACHE_SIZE = 500

# Trims Chromium's resident memory (disables GPU/extensions/background
# throttling machinery this headless, single-tab use case never needs).
# This does not change what the page renders or what the chat-panel
# selectors can read - only what the browser itself keeps resident.
CHROMIUM_LAUNCH_ARGS = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--no-first-run",
    "--js-flags=--max-old-space-size=128",
]

CHAT_EXTRACT_JS = """
() => Array.from(document.querySelectorAll('.nimo-room__chatroom__message-item')).map(item => {
  const nickEl = item.querySelector('.nm-message-nickname');
  const contentEl = item.querySelector('.content .n-as-vtm')
    || item.querySelector('.nimo-room__chatroom__message-item__content .n-as-vtm');
  return {
    username: nickEl ? nickEl.textContent.trim() : '',
    message: contentEl ? contentEl.textContent.trim() : '',
    isSystem: !!(nickEl && nickEl.classList.contains('system-nickname-color')),
  };
}).filter(m => m.message && !m.isSystem)
"""

nimo_state_lock = threading.Lock()
nimo_state = {"live": False}

nimo_chat_lock = threading.Lock()
nimo_chat_buffer = []
nimo_seen_keys = set()
nimo_seen_order = []


def nimo_set_live(live: bool):
    with nimo_state_lock:
        nimo_state["live"] = live


def nimo_is_live() -> bool:
    with nimo_state_lock:
        return nimo_state["live"]


def nimo_mark_seen(key: str):
    nimo_seen_keys.add(key)
    nimo_seen_order.append(key)
    if len(nimo_seen_order) > NIMO_SEEN_CACHE_SIZE:
        oldest = nimo_seen_order.pop(0)
        nimo_seen_keys.discard(oldest)


def nimo_push_message(username: str, message: str):
    key = f"{username}\x1f{message}"
    if key in nimo_seen_keys:
        return
    nimo_mark_seen(key)
    with nimo_chat_lock:
        nimo_chat_buffer.append({"username": username, "message": message})
        if len(nimo_chat_buffer) > NIMO_CHAT_BUFFER_MAX:
            del nimo_chat_buffer[: len(nimo_chat_buffer) - NIMO_CHAT_BUFFER_MAX]


def nimo_drain_messages():
    with nimo_chat_lock:
        drained = list(nimo_chat_buffer)
        nimo_chat_buffer.clear()
        return drained


async def nimo_run_monitor_loop():
    if not NIMO_URL:
        logger.error("NIMO_URL is not set. Nimo worker will stay idle (no browser launched).")
        while True:
            await asyncio.sleep(3600)

    async with async_playwright() as p:
        while True:
            browser = None
            try:
                browser = await p.chromium.launch(headless=True, args=CHROMIUM_LAUNCH_ARGS)
                page = await browser.new_page()
                await page.goto(NIMO_URL, wait_until="networkidle")
                nimo_set_live(True)
                logger.info("[nimo] connected to Nimo room, watching chat panel.")

                while True:
                    try:
                        rows = await page.evaluate(CHAT_EXTRACT_JS)
                        for row in rows:
                            user = (row.get("username") or "").strip()
                            msg = (row.get("message") or "").strip()
                            if not msg:
                                continue
                            nimo_push_message(user or "unknown", msg)
                    except Exception as inner_exc:
                        logger.warning("[nimo] chat read error: %s", inner_exc)

                    await asyncio.sleep(NIMO_POLL_SECONDS)

            except Exception as exc:
                logger.error("[nimo] page session error: %s", exc)
                nimo_set_live(False)
                await asyncio.sleep(NIMO_RELOAD_BACKOFF_SECONDS)
            finally:
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        pass


def nimo_start_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(nimo_run_monitor_loop())


# ---------------------------------------------------------------------------
# Flask app - both workers' APIs side by side
# ---------------------------------------------------------------------------
app = Flask(__name__)


@app.route("/tiktok/status")
def tiktok_status():
    with tiktok_state_lock:
        return jsonify({"live": tiktok_state["live"], "viewers": tiktok_state["viewers"]})


@app.route("/tiktok/chat")
def tiktok_chat():
    with tiktok_state_lock:
        live = tiktok_state["live"]
    return jsonify({"live": live, "messages": tiktok_drain_comments()})


@app.route("/nimo/chat")
def nimo_chat():
    return jsonify({"live": nimo_is_live(), "messages": nimo_drain_messages()})


@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "time": int(time.time()),
        "tiktok_configured": bool(TIKTOK_USERNAME),
        "nimo_configured": bool(NIMO_URL),
    })


if __name__ == "__main__":
    threading.Thread(target=tiktok_start_loop, daemon=True).start()
    threading.Thread(target=nimo_start_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT)
