(function () {
  const feedEl = document.getElementById('chat-feed');

  const params = new URLSearchParams(window.location.search);
  const MAX_MESSAGES = Math.max(1, parseInt(params.get('max'), 10) || 40);
  const SHOW_TIMESTAMPS = params.get('timestamps') === 'true';
  const platformFilter = (params.get('platforms') || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const REMOVE_ANIMATION_MS = 260;

  const PLATFORM_LABELS = {
    twitch: 'Twitch',
    kick: 'Kick',
    youtube: 'YouTube',
    rumble: 'Rumble',
    tiktok: 'TikTok',
    instagram: 'Instagram',
  };

  function platformAllowed(platform) {
    return platformFilter.length === 0 || platformFilter.includes(platform);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessage(msg) {
    if (!platformAllowed(msg.platform)) return;

    const el = document.createElement('div');
    el.className = 'chat-message';

    const badge = document.createElement('span');
    badge.className = 'platform-badge';
    const iconImg = document.createElement('img');
    iconImg.src = `/icons/${msg.platform}.svg`;
    iconImg.alt = PLATFORM_LABELS[msg.platform] || msg.platform;
    badge.appendChild(iconImg);

    const body = document.createElement('span');
    body.className = 'message-body';

    const usernameEl = document.createElement('span');
    usernameEl.className = 'username';
    usernameEl.style.color = msg.color || '#ffffff';
    usernameEl.textContent = msg.username;

    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = msg.message;

    body.appendChild(usernameEl);
    body.appendChild(textEl);

    if (SHOW_TIMESTAMPS && msg.timestamp) {
      const timeEl = document.createElement('span');
      timeEl.className = 'timestamp';
      timeEl.textContent = formatTime(msg.timestamp);
      body.appendChild(timeEl);
    }

    el.appendChild(badge);
    el.appendChild(body);
    feedEl.appendChild(el);

    pruneOldMessages();
  }

  function pruneOldMessages() {
    const messages = feedEl.querySelectorAll('.chat-message:not(.leaving)');
    const excess = messages.length - MAX_MESSAGES;
    if (excess <= 0) return;

    for (let i = 0; i < excess; i += 1) {
      const el = messages[i];
      el.classList.add('leaving');
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, REMOVE_ANIMATION_MS);
    }
  }

  function connect() {
    const socket = io('/chat', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10000,
    });

    socket.on('history', (messages) => {
      (messages || []).forEach(renderMessage);
    });

    socket.on('message', (msg) => {
      renderMessage(msg);
    });

    socket.on('connect_error', (err) => {
      console.error('[chat overlay] socket connection error:', err.message);
    });
  }

  if (typeof io === 'undefined') {
    console.error('[chat overlay] socket.io client failed to load.');
  } else {
    connect();
  }
})();
