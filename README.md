# Viewer Counter Overlay (Twitch + Kick)

A lightweight, Render-hosted OBS Browser Source overlay that displays a single
combined viewer count (Twitch + Kick) in one horizontal row:

```
[Twitch icon] [Kick icon]   1,800
```

Built with Node.js, Express, vanilla JavaScript, HTML, and CSS. No React,
no frontend frameworks.

---

## Features

- Single combined viewer count — no per-platform numbers shown
- Transparent background, dark glass panel, blurred, rounded corners
- Smooth animated count-up/count-down when the number changes
- Green glow when viewers increase, red glow when viewers decrease
- Server-side caching (5s) to minimize API calls to Twitch/Kick
- Automatic Twitch OAuth token fetch, cache, and refresh
- Returns 0 for either platform when offline

---

## Project Structure

```
viewer-counter/
├── server.js
├── package.json
├── render.yaml
├── .env.example
├── README.md
└── public/
    ├── index.html
    ├── style.css
    ├── script.js
    └── icons/
        ├── twitch.svg
        └── kick.svg
```

---

## 1. Local Setup

```bash
npm install
cp .env.example .env
# fill in your credentials in .env
npm start
```

Visit `http://localhost:3000` to preview the overlay locally.

---

## 2. Environment Variables

| Variable              | Description                                          |
|------------------------|------------------------------------------------------|
| `TWITCH_CLIENT_ID`     | Your Twitch application Client ID                    |
| `TWITCH_CLIENT_SECRET` | Your Twitch application Client Secret                |
| `TWITCH_USERNAME`      | Twitch channel login name to track (lowercase)       |
| `KICK_CLIENT_ID`       | Your Kick application Client ID                      |
| `KICK_CLIENT_SECRET`   | Your Kick application Client Secret                  |
| `KICK_USERNAME`        | Kick channel slug to track (lowercase)               |
| `PORT`                 | Port the server listens on (Render sets this itself) |

### Getting Twitch credentials

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Register a new application (any name, OAuth redirect URL can be
   `http://localhost`, category "Application Integration").
3. Copy the **Client ID** and generate/copy the **Client Secret**.
4. Use your channel's login name (not display name) as `TWITCH_USERNAME`.

### Getting Kick credentials

Kick has an official public API with the same client-credentials OAuth
pattern as Twitch:

1. Log in to Kick and go to **Settings → Developer** (or visit the
   [Kick Developer Portal](https://kick.com/settings) directly).
2. Create a new application to get a **Client ID** and **Client Secret**.
3. Use your channel's URL slug (the part after `kick.com/`) as
   `KICK_USERNAME`.

The server automatically requests an app access token from
`id.kick.com` using these credentials, caches it, and refreshes it before
it expires — the same way it already handles Twitch.

---

## 3. Deploy to Render

1. Push this project to a GitHub (or GitLab) repository.
2. Go to [Render Dashboard](https://dashboard.render.com/) → **New** →
   **Web Service**.
3. Connect your repository. Render will detect `render.yaml`
   automatically (Blueprint deploy), or you can configure manually:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add the environment variables in the **Environment** tab of your
   Render service:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `TWITCH_USERNAME`
   - `KICK_USERNAME`
   - (`PORT` is provided automatically by Render — no need to set it)
5. Click **Deploy**. Once live, Render gives you a public URL like:

   ```
   https://viewer-counter.onrender.com
   ```

---

## 4. Add to OBS

1. In OBS, add a new **Browser Source**.
2. Set the URL to your Render deployment:

   ```
   https://viewer-counter.onrender.com
   ```

3. Configure the source:
   - **Width:** `300`
   - **Height:** `80`
   - ✅ **Shutdown source when not visible:** off (recommended)
   - ✅ **Transparent background** — enabled automatically since the page
     background is `transparent` and OBS Browser Source composites with
     alpha by default.
4. Position the overlay wherever you'd like on your stream layout.

The overlay will poll `/api/viewers` every 5 seconds and animate the
combined count smoothly, with a green glow on increase and a red glow on
decrease.

---

## 5. API Endpoint

```
GET /api/viewers
```

Response:

```json
{
  "twitch": 1240,
  "kick": 560,
  "total": 1800,
  "twitchLive": true,
  "kickLive": true
}
```

The frontend (`script.js`) only ever talks to this single endpoint — it
never calls Twitch or Kick directly, keeping API credentials server-side
only.

### Offline platform handling

- If a platform is offline, its `*Live` flag is `false` and its icon is
  hidden completely — no empty gap is left behind, since hiding an icon
  collapses its width/margin to zero.
- Icons fade + slide in when a platform goes live, and fade + slide out
  when it goes offline, without a page reload.
- If **both** platforms are offline, the overlay replaces the number with
  the text `OFFLINE`.
- The combined count animation (count up/down + glow) keeps working
  normally whenever at least one platform is live.

---

## Performance Notes

- The backend caches combined viewer results for 5 seconds, so multiple
  browser source reloads or tabs won't cause redundant upstream API calls.
- The Twitch OAuth token is cached in memory and only refreshed once it's
  close to expiry, avoiding unnecessary token requests.
- The frontend uses `requestAnimationFrame` for count animations — no
  timers/intervals left running beyond the 5-second poll — keeping CPU
  usage minimal, which is ideal for long OBS streaming sessions.
