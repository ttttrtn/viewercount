"""
Nimo TV sidecar service.

Nimo has no official public API for live chat, so this sidecar reads the
chat panel directly off the live page with Playwright (headless Chromium)
and exposes a tiny HTTP API that the main Node.js overlay server polls -
the exact same shape as the TikTok sidecar in /tiktok-service.

Endpoints:
    GET /chat    -> {"live": bool, "messages": [{"username", "message"}]}
    GET /health  -> {"ok": true}   (simple liveness check for Render)

Design:
    - A single background asyncio task keeps one Playwright/Chromium
      browser page open on the live room and re-reads the chat panel's
      username/message node pairs every POLL_SECONDS.
    - Messages already seen (by a username+message dedupe key, capped to
      SEEN_CACHE_SIZE entries) are skipped so the same line never gets
      buffered twice.
    - New messages are appended to an in-memory buffer that GET /chat
      drains on every poll - same "sidecar just forwards raw events,
      Node does the normalization/dedup for the overlay" split used by
      the TikTok/Rumble/Instagram integrations.
    - Any error reloading/reading the page (nav failure, layout change,
      room offline, etc.) is caught, logged, and retried after a backoff
      instead of crashing the process, so the service recovers on its
      own from transient page/network issues.

Config:
    NIMO_URL       - full URL of the Nimo live room, e.g.
                      https://www.nimo.tv/live/1578570016
    PORT           - defaults to 5007

The chat panel's DOM structure isn't part of any documented API and can
change without notice - if Nimo changes their front-end markup, only the
two XPATH_* selectors below need updating.
"""

import asyncio
import logging
import os
import threading
import time

from flask import Flask, Response, jsonify
from playwright.async_api import async_playwright

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nimo-sidecar")

NIMO_URL = os.environ.get("NIMO_URL", "").strip()
PORT = int(os.environ.get("PORT", "5007"))

POLL_SECONDS = 2
RELOAD_BACKOFF_SECONDS = 15
CHAT_BUFFER_MAX = 200
SEEN_CACHE_SIZE = 500

# These match the two chat-panel node lists from the reference script -
# one xpath for the row of usernames, one for the row of messages, read
# in parallel and zipped together by index.
XPATH_USERNAMES = (
    '//*[@id="root"]/div[1]/div[1]/div[1]/div[2]/div[1]/div/div[2]/span[1]/span[2]/span[2]'
)
XPATH_MESSAGES = (
    '//*[@id="root"]/div[1]/div/div[1]/div[2]/div[1]/div/div[2]/span[2]/span'
)

state_lock = threading.Lock()
state = {"live": False}

chat_lock = threading.Lock()
chat_buffer = []
seen_keys = set()
seen_order = []

# Diagnostics captured on the last poll so /debug can report what the
# page actually looked like, without needing to reproduce it locally.
debug_lock = threading.Lock()
debug_info = {"url": None, "title": None, "username_count": 0, "message_count": 0, "error": None}

screenshot_lock = threading.Lock()
latest_screenshot = None


def set_debug(**kwargs):
    with debug_lock:
        debug_info.update(kwargs)


def get_debug():
    with debug_lock:
        return dict(debug_info)


def set_screenshot(png_bytes):
    global latest_screenshot
    with screenshot_lock:
        latest_screenshot = png_bytes


def get_screenshot():
    with screenshot_lock:
        return latest_screenshot


def set_live(live: bool):
    with state_lock:
        state["live"] = live


def is_live() -> bool:
    with state_lock:
        return state["live"]


def mark_seen(key: str):
    seen_keys.add(key)
    seen_order.append(key)
    if len(seen_order) > SEEN_CACHE_SIZE:
        oldest = seen_order.pop(0)
        seen_keys.discard(oldest)


def push_message(username: str, message: str):
    key = f"{username}\x1f{message}"
    if key in seen_keys:
        return
    mark_seen(key)

    with chat_lock:
        chat_buffer.append({"username": username, "message": message})
        if len(chat_buffer) > CHAT_BUFFER_MAX:
            del chat_buffer[: len(chat_buffer) - CHAT_BUFFER_MAX]


def drain_messages():
    with chat_lock:
        drained = list(chat_buffer)
        chat_buffer.clear()
        return drained


async def run_monitor_loop():
    if not NIMO_URL:
        logger.error("NIMO_URL is not set. Sidecar will stay idle.")
        while True:
            await asyncio.sleep(3600)

    async with async_playwright() as p:
        while True:
            browser = None
            try:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                await page.goto(NIMO_URL, wait_until="networkidle")
                set_live(True)
                logger.info("Connected to Nimo room, watching chat panel.")

                while True:
                    try:
                        usernames = await page.locator(f"xpath={XPATH_USERNAMES}").all_inner_texts()
                        messages = await page.locator(f"xpath={XPATH_MESSAGES}").all_inner_texts()

                        set_debug(
                            url=page.url,
                            title=await page.title(),
                            username_count=len(usernames),
                            message_count=len(messages),
                            error=None,
                        )
                        if not usernames and not messages:
                            logger.info(
                                "No chat nodes matched (url=%s title=%r) - selectors may be stale.",
                                page.url,
                                await page.title(),
                            )
                            try:
                                set_screenshot(await page.screenshot(full_page=False))
                            except Exception:
                                pass

                        for user, msg in zip(usernames, messages):
                            user = (user or "").strip()
                            msg = (msg or "").strip()
                            if not msg:
                                continue
                            push_message(user or "unknown", msg)
                    except Exception as inner_exc:
                        # A single failed read (page mid-reflow, node
                        # detached, etc.) shouldn't tear down the whole
                        # session - log it and keep polling.
                        logger.warning("Chat read error: %s", inner_exc)
                        set_debug(error=str(inner_exc))

                    await asyncio.sleep(POLL_SECONDS)

            except Exception as exc:
                logger.error("Nimo page session error: %s", exc)
                set_live(False)
                await asyncio.sleep(RELOAD_BACKOFF_SECONDS)
            finally:
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        pass


def start_background_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run_monitor_loop())


app = Flask(__name__)


@app.route("/chat")
def chat():
    return jsonify({"live": is_live(), "messages": drain_messages()})


@app.route("/debug")
def debug():
    return jsonify({"live": is_live(), **get_debug()})


@app.route("/screenshot")
def screenshot():
    png = get_screenshot()
    if png is None:
        return jsonify({"error": "no screenshot captured yet"}), 404
    return Response(png, mimetype="image/png")


@app.route("/health")
def health():
    return jsonify({"ok": True, "time": int(time.time())})


if __name__ == "__main__":
    monitor_thread = threading.Thread(target=start_background_loop, daemon=True)
    monitor_thread.start()

    app.run(host="0.0.0.0", port=PORT)
