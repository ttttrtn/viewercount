// Central aggregator for all platform chat services.
//
// Each platform module (twitchChat, kickChat, youtubeChat, rumbleChat,
// tiktokChat, instagramChat, nimoChat) exposes the same tiny interface:
//
//   start(onMessage, onStatus)  -> begins connecting/polling in the
//                                  background. Never throws. Calls
//                                  onMessage(normalizedMessage) for every
//                                  chat message it sees, and
//                                  onStatus({ connected, live }) whenever
//                                  its connection state changes.
//   stop()                      -> best-effort graceful shutdown.
//
// normalizedMessage shape (matches the format requested for the project):
//   {
//     platform: 'twitch' | 'kick' | 'youtube' | 'rumble' | 'tiktok' | 'instagram' | 'nimo',
//     username: string,
//     message: string,
//     color: string,        // hex color for the username, platform default if unknown
//     timestamp: number,    // unix seconds
//   }
//
// chatManager itself is a thin EventEmitter: 'message' and 'status'.

const EventEmitter = require('events');

const twitchChat = require('./twitchChat');
const kickChat = require('./kickChat');
const youtubeChat = require('./youtubeChat');
const rumbleChat = require('./rumbleChat');
const tiktokChat = require('./tiktokChat');
const instagramChat = require('./instagramChat');
const nimoChat = require('./nimoChat');

const PLATFORMS = {
  twitch: twitchChat,
  kick: kickChat,
  youtube: youtubeChat,
  rumble: rumbleChat,
  tiktok: tiktokChat,
  instagram: instagramChat,
  nimo: nimoChat,
};

class ChatManager extends EventEmitter {
  constructor() {
    super();
    this.status = {};
    Object.keys(PLATFORMS).forEach((key) => {
      this.status[key] = { connected: false, live: false, enabled: false };
    });
    this.started = false;
    // Small ring buffer of the most recent messages so any client that
    // connects to the /chat websocket mid-stream gets some context
    // instead of a blank overlay.
    this.recentMessages = [];
    this.MAX_RECENT = 50;
  }

  start() {
    if (this.started) return;
    this.started = true;

    Object.entries(PLATFORMS).forEach(([platform, service]) => {
      try {
        const enabled = service.isConfigured ? service.isConfigured() : true;
        this.status[platform].enabled = enabled;

        if (!enabled) {
          console.log(`[chatManager] ${platform} is not configured - skipping.`);
          return;
        }

        service.start(
          (rawMessage) => this._handleMessage(platform, rawMessage),
          (statusUpdate) => this._handleStatus(platform, statusUpdate)
        );
        console.log(`[chatManager] ${platform} chat service started.`);
      } catch (err) {
        console.error(`[chatManager] failed to start ${platform}:`, err.message);
      }
    });
  }

  stop() {
    Object.entries(PLATFORMS).forEach(([platform, service]) => {
      try {
        if (typeof service.stop === 'function') service.stop();
      } catch (err) {
        console.error(`[chatManager] error stopping ${platform}:`, err.message);
      }
    });
    this.started = false;
  }

  _handleMessage(platform, rawMessage) {
    const normalized = {
      platform,
      username: String(rawMessage.username || 'unknown').slice(0, 64),
      message: String(rawMessage.message || '').slice(0, 500),
      color: rawMessage.color || defaultColorFor(platform),
      timestamp: rawMessage.timestamp || Math.floor(Date.now() / 1000),
      // Real badge metadata from the platform's own API/library. Always an
      // array - empty when the platform doesn't expose badges or none apply.
      badges: Array.isArray(rawMessage.badges) ? rawMessage.badges : [],
    };

    this.recentMessages.push(normalized);
    if (this.recentMessages.length > this.MAX_RECENT) {
      this.recentMessages.shift();
    }

    this.emit('message', normalized);
  }

  _handleStatus(platform, statusUpdate) {
    this.status[platform] = {
      ...this.status[platform],
      ...statusUpdate,
    };
    this.emit('status', { platform, status: this.status[platform] });
  }

  getStatusSnapshot() {
    return this.status;
  }

  getRecentMessages() {
    return this.recentMessages.slice();
  }
}

function defaultColorFor(platform) {
  const defaults = {
    twitch: '#9146FF',
    kick: '#53FC18',
    youtube: '#FF0000',
    rumble: '#85C742',
    tiktok: '#25F4EE',
    instagram: '#E1306C',
    nimo: '#FF6600',
  };
  return defaults[platform] || '#FFFFFF';
}

module.exports = new ChatManager();
