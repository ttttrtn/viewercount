# Viewer Counter Overlay (Twitch + Kick + Rumble + TikTok + YouTube)

A Render-hosted OBS Browser Source overlay showing a single combined live
viewer count across five platforms. Only the icons for platforms
currently live are shown - no gaps, smoothly animated in and out - and
the combined number animates up/down with a glow whenever it changes.

```
[Twitch] [Kick] [YouTube]   3,214
```

If nothing is live:

```
OFFLINE
```

Built with Node.js, Express, vanilla JS/HTML/CSS for the overlay itself,
plus one small Python sidecar (TikTokLive.py) purely because TikTok has
no HTTP API and its only maintained client library is Python.

---

## Project Structure

```
viewer-counter/
├── server.js                  # thin Express layer, serves /api/viewers
├── package.json
├── render.yaml                 # defines BOTH Render services below
├── .env.example
├── README.md
├── services/
│   ├── twitch.js               # Twitch Helix, OAuth client-credentials
│   ├── kick.js                  # Kick official public API, same OAuth style
│   ├── rumble.js                # Rumble official Live Stream API
│   ├── youtube/                 # YouTube Data API v3 + unofficial fallback
│   │   ├── index.js                # orchestrator: failover, cooldown, caching
│   │   ├── officialProvider.js     # search.list / videos.list, error classification
│   │   ├── fallbackProvider.js     # youtubei.js-backed unofficial fallback
│   │   ├── config.js               # env vars, defaults, validation
│   │   └── logger.js               # DEBUG_YOUTUBE-gated verbose logging
│   ├── tiktok.js                 # thin HTTP client -> tiktok-service sidecar
│   └── viewerManager.js         # fans out to all 5, caches, retries, totals
├── tiktok-service/               # separate Python microservice
│   ├── app.py                    # Flask + TikTokLive.py
│   └── requirements.txt
└── public/
    ├── index.html
    ├── style.css
    ├── script.js
    └── icons/
        ├── twitch.svg
        ├── kick.svg
        ├── rumble.svg
        ├── tiktok.svg
        └── youtube.svg
```

Every service module in `services/` exposes the same shape:

```js
{ live: boolean, viewers: number }
```

(The YouTube service returns two extra fields, `source` and
`fallbackActive` - see "YouTube reliability & fallback" below.)

`viewerManager.js` calls all five in parallel, retries a failed one once,
caches the combined result for 5 seconds, and always serves the last
known good data if a refresh fails outright - so a blip in one platform's
API never takes down the whole overlay.

---

## Why TikTok needs a second service

TikTok has no official public API for live viewer counts. The best
maintained option is **TikTokLive.py** (`isaackogan/TikTokLive`), a
Python-only library. Rather than shelling out to Python from Node for
every poll, it runs as its own small, always-on Flask service
(`tiktok-service/app.py`) that:

- Calls `client.is_live()` on a slow interval while offline (cheap, no
  websocket).
- Opens a real connection only once the channel is live, reading the
  viewer count from `room_info` every few seconds.
- Automatically falls back to the offline polling loop on disconnect,
  stream end, or any exception - no manual restart needed.

The main Node app just polls this sidecar's `/status` endpoint over
plain HTTP via `services/tiktok.js`.

---

## Environment Variables

| Variable | Platform | Description |
|---|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch | From the Twitch Developer Console (dev.twitch.tv/console/apps) |
| `TWITCH_USERNAME` | Twitch | Channel login name (lowercase) |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Kick | From kick.com/settings -> Developer |
| `KICK_USERNAME` | Kick | Channel slug (lowercase) |
| `RUMBLE_API_URL` | Rumble | Full URL from rumble.com/account/livestream-api (already includes auth) |
| `RUMBLE_API_KEY` | Rumble | Optional, reserved for future Rumble auth - not required today |
| `RUMBLE_CHANNEL` | Rumble | Optional - only needed if your account has multiple channels |
| `TIKTOK_USERNAME` | TikTok | Username, set on the **tiktok-service** |
| `TIKTOK_SERVICE_URL` | TikTok | Public URL of the deployed sidecar, set on the **main service** |
| `YOUTUBE_API_KEY` | YouTube | From Google Cloud Console, with YouTube Data API v3 enabled |
| `YOUTUBE_CHANNEL_ID` | YouTube | Your channel's ID (starts with UC...) |
| `DEBUG_YOUTUBE` | YouTube | Optional - `true` enables verbose request/response/fallback logging |
| `PORT` | - | Set automatically by Render |

---

## Getting credentials per platform

### Twitch
1. Twitch Developer Console (dev.twitch.tv/console/apps) -> register an app.
2. Copy Client ID + Secret. Use your channel's login name (not display name).

### Kick
Kick's official public API uses the same client-credentials OAuth
pattern as Twitch:
1. kick.com/settings -> Developer -> create an application.
2. Copy Client ID + Secret. Use your channel's URL slug.

### Rumble
1. Go to rumble.com/account/livestream-api while logged in.
2. Copy the full generated URL into `RUMBLE_API_URL` exactly as shown -
   it already contains your user ID and a live-stream key, so no
   separate secret needs to be sent per request.
3. Treat this URL like a password - anyone with it can read your live
   stream data.

### TikTok
1. Deploy `tiktok-service/` as its **own** Render web service (Python
   environment) - see deployment steps below.
2. Set `TIKTOK_USERNAME` on that service.
3. Copy its public URL into `TIKTOK_SERVICE_URL` on the **main**
   `viewer-counter` service.

### YouTube
1. Google Cloud Console -> create an API key, enable **YouTube Data API v3**
   for the project.
2. Find your channel ID (Studio -> Settings -> Channel -> Advanced, or
   view page source of your channel page for "channelId"). It should
   look like `UCxxxxxxxxxxxxxxxxxxxxxx` (24 characters) - a @handle,
   custom URL, or username will *not* work and will cause `search.list`
   to silently return zero results. The app logs a warning at startup if
   `YOUTUBE_CHANNEL_ID` doesn't match that shape.
3. The integration is quota-conscious by design: it only spends the
   expensive `search.list` call (100 units) once every 5 minutes while
   offline, and switches to cheap `videos.list` calls (1 unit) every 15
   seconds while live.

#### YouTube reliability & fallback

The YouTube service (`services/youtube/`) prefers the official Data API
v3 whenever it's healthy, and automatically fails over to an unofficial
provider ([youtubei.js](https://github.com/LuanRT/YouTube.js), an
actively-maintained client for YouTube's internal API - not HTML
scraping) when the official API:

- has exhausted its quota,
- has invalid/rejected credentials,
- hits a network failure or timeout,
- returns a 5xx error,
- returns an unparseable/unexpected response, or
- reports the channel as live but omits `concurrentViewers` (a known,
  intermittent quirk of the official API - **this was the root cause of
  the "reports offline while live" bug**: a missing viewer count no
  longer causes the channel to be marked offline).

Recovery is automatic: the app keeps probing the official API in the
background while running on the fallback, and switches back once the
official API is healthy again. A cooldown (`YOUTUBE_SOURCE_SWITCH_COOLDOWN_MS`,
default 2 minutes) prevents rapidly flapping between sources if the
official API is intermittently flaky. If *both* sources fail, the last
known-good result is served for up to `YOUTUBE_STALE_CACHE_MS` (default
3 minutes) before the channel is finally reported offline. The frontend
never sees which source is active - it only ever reads `youtubeLive`
and `total`.

Set `DEBUG_YOUTUBE=true` to log every request/response, parsed fields,
live/offline reasoning, and fallback activity in detail. Leave it unset
in normal operation to keep logs quiet. See `.env.example` for the full
list of tunable polling/backoff/cooldown values.

---

## Updated API Response

```
GET /api/viewers
```

```json
{
  "twitch": 1250,
  "kick": 410,
  "rumble": 185,
  "tiktok": 960,
  "youtube": 840,

  "twitchLive": true,
  "kickLive": true,
  "rumbleLive": true,
  "tiktokLive": true,
  "youtubeLive": true,
  "youtubeSource": "official",
  "youtubeFallbackActive": false,

  "total": 3645,
  "updated": 1720000000
}
```

`youtubeSource` is `"official"` or `"fallback"` depending on which
provider produced the current YouTube numbers; `youtubeFallbackActive`
is a convenience boolean mirroring that. These are informational only -
the frontend overlay ignores them and just reads `youtubeLive`/`total`.

`total` always equals the sum of viewers from only the currently-live
platforms. The frontend only ever talks to this one endpoint.

---

## Deploy to Render

This project deploys as **two** Render services (both defined in
`render.yaml`, so a single Blueprint deploy sets both up):

1. `viewer-counter` - the main Node overlay (this is the URL you add to OBS).
2. `viewer-counter-tiktok` - the Python TikTok sidecar (internal use only,
   nothing to add to OBS).

### Steps

1. Push this project to GitHub.
2. Render Dashboard -> New -> Blueprint -> connect the repo. Render
   reads `render.yaml` and proposes both services.
3. Before/after creating them, set the environment variables from the
   table above on the correct service:
   - Twitch / Kick / Rumble / YouTube vars + `TIKTOK_SERVICE_URL` -> on
     `viewer-counter`
   - `TIKTOK_USERNAME` -> on `viewer-counter-tiktok`
4. Deploy `viewer-counter-tiktok` first, copy its resulting URL (e.g.
   https://viewer-counter-tiktok.onrender.com), and paste it into
   `viewer-counter`'s `TIKTOK_SERVICE_URL`.
5. Deploy/redeploy `viewer-counter`. You'll get your overlay URL, e.g.:

   ```
   https://viewer-counter.onrender.com
   ```

If you don't stream on TikTok, you can skip deploying the sidecar
entirely and just leave `TIKTOK_SERVICE_URL` unset - `tiktokLive` will
simply always report false, and the icon stays hidden.

---

## Add to OBS

1. Add a Browser Source pointing at your main service's URL (not the
   TikTok sidecar's).
2. Width 300, Height 80, transparent background enabled.

---

## Performance Notes

- `viewerManager.js` caches the combined result for 5 seconds and
  de-duplicates concurrent requests, so multiple OBS sources or browser
  tabs never cause redundant upstream calls.
- Every service retries once on an unexpected error, then falls back to
  reporting offline rather than crashing the whole endpoint.
- Rumble uses internal backoff after failures, so a temporary outage
  doesn't turn into a hot retry loop. YouTube has its own more elaborate
  backoff + automatic fallback + recovery cooldown - see "YouTube
  reliability & fallback" above.
- YouTube's polling strategy (5 min offline / 15s live) is designed to
  stay well under the default 10,000-unit daily quota even with the
  overlay running 24/7.
- The frontend uses requestAnimationFrame for animations and cleans up
  properly - no lingering timers beyond the 5-second poll.

---

## Multi-Platform Chat Widget

A second, independent OBS Browser Source that combines live chat from
all six platforms into one animated feed:

```
https://your-render-app.onrender.com/chat
```

```
🟣 User123: Hello!
🟢 Player: W stream
▶️ Viewer: Nice!
🎵 Fan: 🔥
📸 Follower: Hi
```

Transparent background, no scrollbars, smooth enter/exit animation per
message, platform SVG badges, per-platform username colors, and a
configurable rolling max message count - old messages animate out as new
ones arrive rather than the widget growing forever.

**Query string options** (append to the `/chat` browser-source URL):

| Param        | Example                    | Effect                                             |
|--------------|-----------------------------|-----------------------------------------------------|
| `max`        | `/chat?max=25`               | Max messages kept on screen at once (default 40)     |
| `timestamps` | `/chat?timestamps=true`      | Show a HH:MM timestamp on each message                |
| `platforms`  | `/chat?platforms=twitch,kick`| Only show chat from the listed platforms               |

### How each platform is read

| Platform  | Transport | Notes |
|-----------|-----------|-------|
| Twitch    | Twitch IRC over WebSocket, anonymous `justinfan` login | No OAuth needed just to read chat; reuses `TWITCH_USERNAME`. |
| Kick      | Kick's Pusher WebSocket (the same one kick.com's own frontend uses) | No official chat API exists; chatroom id is auto-resolved from Kick's public channel endpoint, with `KICK_CHATROOM_ID` as a manual override if that lookup gets blocked. |
| YouTube   | `pytchat` inside `youtube-chat-service` (Python sidecar) | Avoids the costly `liveChatMessages.list` polling quota; the sidecar resolves the current live video id via a cheap, infrequent `search.list` call. |
| Rumble    | Rumble's official Live Stream API (same URL as the viewer-count service) | Chat/rants are included directly in that response; polled and de-duplicated by message id. |
| TikTok    | `TikTokLive.py` inside the existing `tiktok-service` sidecar | The same sidecar used for viewer counts now also buffers `CommentEvent`s at `GET /chat`. |
| Instagram | Config-driven bridge (`INSTAGRAM_LIVE_COMMENTS_URL`) | Instagram has no official Live-comments API and no reliable unofficial one that doesn't require an undocumented, frequently-breaking private endpoint. Rather than hardcode one, this integration stays isolated and idle until you point it at a JSON bridge you control - see `services/chat/instagramChat.js`. |
| Nimo      | Playwright (headless Chromium) inside a new `nimo-service` sidecar | Nimo has no official chat API either, so the sidecar loads the live room and reads the chat panel's username/message nodes directly, buffering them at `GET /chat`. |

### New/changed project structure

```
viewer-counter/
├── services/
│   └── chat/
│       ├── chatManager.js       # aggregates all platforms, broadcasts via EventEmitter
│       ├── twitchChat.js
│       ├── kickChat.js
│       ├── youtubeChat.js       # polls youtube-chat-service
│       ├── rumbleChat.js
│       ├── tiktokChat.js        # polls tiktok-service's new /chat endpoint
│       ├── instagramChat.js
│       └── nimoChat.js          # polls nimo-service's /chat endpoint
├── youtube-chat-service/        # NEW Python sidecar (pytchat)
│   ├── app.py
│   └── requirements.txt
├── tiktok-service/
│   └── app.py                   # extended: now also buffers comments at /chat
├── nimo-service/                # NEW Python sidecar (Playwright + Flask)
│   ├── app.py
│   └── requirements.txt
└── public/
    └── chat/                    # NEW browser source
        ├── index.html
        ├── style.css
        └── script.js
```

### Deployment

The chat widget adds one more Render service beyond what the viewer
counter already needed:

1. **Main service** (`viewer-counter`) - unchanged deploy steps, now also
   serves `/chat` and hosts the Socket.IO server. Set the new chat env
   vars listed in `.env.example`.
2. **TikTok sidecar** (`viewer-counter-tiktok`) - same deploy as before;
   no new steps, it now serves both `/status` and `/chat`.
3. **YouTube chat sidecar** (`viewer-counter-youtube-chat`) - **new**.
   Deploy `youtube-chat-service/` as its own Render web service
   (`render.yaml` already defines it), set `YOUTUBE_API_KEY`, then copy
   its public URL into the main service's `YOUTUBE_CHAT_SERVICE_URL`.

Kick, Rumble, and Twitch chat need no additional services - they reuse
the existing env vars and run entirely inside the main Node process.

### Reliability

- Every platform module reconnects automatically with exponential
  backoff (WebSocket transports) or a fixed poll interval with backoff
  on failure (HTTP-polled transports), and never throws past its own
  boundary - one platform failing never takes down the others.
- `chatManager` keeps a small ring buffer of the most recent messages so
  a browser source that reloads mid-stream (e.g. OBS refresh) isn't
  greeted with a blank widget.
- Platforms with missing configuration are skipped at startup with a
  clear log line rather than retrying forever.
- Graceful shutdown (`SIGTERM`/`SIGINT`) stops every chat connection
  cleanly before the process exits.

### Low CPU tuning

Both overlays are tuned to stay cheap in OBS's Browser Source (CEF),
which is often software-rendered and where a couple of specific CSS
properties are disproportionately expensive:

- **No `backdrop-filter: blur()`** anywhere. It's one of the few CSS
  properties that forces a full recomposite of everything behind it on
  basically every frame - removing it is the single biggest CPU win for
  a semi-transparent OBS overlay. Panels use a slightly more opaque flat
  color instead, which looks nearly identical at typical overlay sizes.
- **No CSS `mask-image` gradients or `scale()` transforms** in the chat
  feed animation - both also force extra compositor layers. Messages now
  animate with a plain opacity + `translateY` fade, which GPUs (and
  CEF's software fallback) handle far more cheaply.
- **requestAnimationFrame loops only run while a value is actively
  animating** (see `public/script.js`) - nothing polls or redraws on an
  idle timer.

Backend polling intervals were also widened - fast enough that chat
still feels live, slow enough not to burn unnecessary CPU/requests on
Render's shared free-tier resources:

| Source | Interval |
|---|---|
| Rumble chat poll | 15s (was 8s) |
| YouTube chat poll (Node → sidecar) | 4s (was 2s) |
| TikTok chat poll (Node → sidecar) | 3s (was 1.5s) |
| Instagram bridge poll | 5s (was 3s) |
| TikTok sidecar: viewer-count refresh while live | 10s (was 5s) |
| TikTok sidecar: offline `is_live()` check | 60s (was 30s) |
| YouTube sidecar: re-search for a live video | 180s (was 120s) |

Twitch and Kick are WebSocket push transports, not polling, so they were
already effectively idle CPU-wise between messages - no changes needed
there.
