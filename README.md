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
│   ├── youtube.js               # YouTube Data API v3, quota-efficient polling
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
   view page source of your channel page for "channelId").
3. The integration is quota-conscious by design: it only spends the
   expensive search.list call (100 units) once every 5 minutes while
   offline, and switches to cheap videos.list calls (1 unit) every 15
   seconds while live.

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

  "total": 3645,
  "updated": 1720000000
}
```

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
- Rumble and YouTube use internal backoff after failures, so a temporary
  outage doesn't turn into a hot retry loop.
- YouTube's polling strategy (5 min offline / 15s live) is designed to
  stay well under the default 10,000-unit daily quota even with the
  overlay running 24/7.
- The frontend uses requestAnimationFrame for animations and cleans up
  properly - no lingering timers beyond the 5-second poll.
