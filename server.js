require('dotenv').config();
const express = require('express');
const path = require('path');
const { getViewerCounts } = require('./services/viewerManager');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, () => {
  console.log(`Viewer counter overlay running on port ${PORT}`);
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
  console.log('TIKTOK_SERVICE_URL set:', Boolean(process.env.TIKTOK_SERVICE_URL));
  console.log('YOUTUBE_API_KEY set:', Boolean(process.env.YOUTUBE_API_KEY));
  console.log('YOUTUBE_CHANNEL_ID:', process.env.YOUTUBE_CHANNEL_ID || '(empty)');
  console.log('DEBUG_YOUTUBE:', Boolean(process.env.DEBUG_YOUTUBE));
  console.log('---------------------');
});
