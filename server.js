require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { getViewerCounts } = require('./services/viewerManager');
const chatManager = require('./services/chat/chatManager');

const app = express();
const server = http.createServer(app);

// ALLOWED_ORIGIN - the Cloudflare Pages URL the frontend is deployed to,
// e.g. https://viewer-counter.pages.dev. Comma-separated list supported
// for staging + production. Left unset (or '*'), all origins are
// allowed, which is fine for a read-only public overlay API with no
// cookies/auth, but tightening it once you have a fixed Pages domain
// costs nothing and is good practice.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

const io = new SocketIOServer(server, {
  cors: {
    origin: (origin, cb) => cb(null, !origin || isOriginAllowed(origin)),
  },
});
const PORT = process.env.PORT || 3000;

// The frontend now normally lives on Cloudflare Pages (see
// public/config.js), so the REST API needs real CORS headers - Express
// doesn't add any by default, and a cross-origin fetch() from Pages to
// this service would otherwise be blocked by the browser.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin || '*');
    res.set('Vary', 'Origin');
  }
  next();
});

// Serving /public here too so the Render service still works standalone
// (e.g. for local dev, or if you choose not to use Cloudflare Pages).
app.use(express.static(path.join(__dirname, 'public')));

// Serve the chat overlay as its own OBS browser source, e.g.
// https://your-render-app.onrender.com/chat
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat', 'index.html'));
});

const chatNamespace = io.of('/chat');

chatNamespace.on('connection', (socket) => {
  // Give newly-connected overlays (e.g. after an OBS refresh) a bit of
  // context instead of a blank widget.
  socket.emit('history', chatManager.getRecentMessages());
  socket.emit('status', chatManager.getStatusSnapshot());
});

chatManager.on('message', (message) => {
  chatNamespace.emit('message', message);
});

chatManager.on('status', ({ platform, status }) => {
  chatNamespace.emit('platform-status', { platform, status });
});

chatManager.start();

app.get('/api/viewers', async (req, res) => {
  try {
    const counts = await getViewerCounts();
    res.set('Cache-Control', 'no-store');
    res.json(counts);
  } catch (err) {
    console.error('API error:', err.message);
    res.json({
      twitch: 0,
      kick: 0,
      rumble: 0,
      tiktok: 0,
      youtube: 0,
      twitchLive: false,
      kickLive: false,
      rumbleLive: false,
      tiktokLive: false,
      youtubeLive: false,
      youtubeSource: 'official',
      youtubeFallbackActive: false,
      total: 0,
      updated: Math.floor(Date.now() / 1000),
    });
  }
});

server.listen(PORT, () => {
  console.log(`Viewer counter overlay running on port ${PORT}`);
  console.log('Chat overlay available at /chat');
  console.log('--- Config check ---');
  console.log('TWITCH_CLIENT_ID set:', Boolean(process.env.TWITCH_CLIENT_ID));
  console.log('TWITCH_CLIENT_SECRET set:', Boolean(process.env.TWITCH_CLIENT_SECRET));
  console.log('TWITCH_USERNAME:', process.env.TWITCH_USERNAME || '(empty)');
  console.log('KICK_CLIENT_ID set:', Boolean(process.env.KICK_CLIENT_ID));
  console.log('KICK_CLIENT_SECRET set:', Boolean(process.env.KICK_CLIENT_SECRET));
  console.log('KICK_USERNAME:', process.env.KICK_USERNAME || '(empty)');
  console.log('RUMBLE_API_URL set:', Boolean(process.env.RUMBLE_API_URL));
  console.log('RUMBLE_CHANNEL:', process.env.RUMBLE_CHANNEL || '(empty)');
  console.log('TIKTOK_USERNAME:', process.env.TIKTOK_USERNAME || '(empty)');
  console.log('PLATFORM_SIDECAR_URL set:', Boolean(process.env.PLATFORM_SIDECAR_URL));
  console.log('YOUTUBE_API_KEY set:', Boolean(process.env.YOUTUBE_API_KEY));
  console.log('YOUTUBE_CHANNEL_ID:', process.env.YOUTUBE_CHANNEL_ID || '(empty)');
  console.log('DEBUG_YOUTUBE:', Boolean(process.env.DEBUG_YOUTUBE));
  console.log('KICK_CHATROOM_ID set:', Boolean(process.env.KICK_CHATROOM_ID));
  console.log('INSTAGRAM_LIVE_COMMENTS_URL set:', Boolean(process.env.INSTAGRAM_LIVE_COMMENTS_URL));
  console.log('ALLOWED_ORIGIN:', ALLOWED_ORIGINS.join(', '));
  console.log('---------------------');
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  chatManager.stop();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force-exit if something hangs.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
