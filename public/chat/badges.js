// Shared badge renderer for the chat overlay.
//
// Badge SVG assets live under /icons/badges/<platform>/<badge_id>.svg
// (separate from /icons/<platform>.svg, which is the existing platform-icon
// system and is left untouched).
//
// This module is intentionally independent of the platform-icon code in
// script.js - it only knows how to turn a message's `badges` array into
// small <img> elements, with in-memory caching so OBS doesn't re-decode the
// same badge SVG on every single message.

(function (global) {
  // Known badge ids per platform. Used only to build the icon URL and as a
  // fallback label if the server didn't send a human-readable `name`.
  // Unrecognized ids still render fine (falls back to a generic badge path
  // pattern), so new/renamed platform badges don't need a code change here.
  const BADGE_LABELS = {
    twitch: {
      broadcaster: 'Broadcaster',
      moderator: 'Moderator',
      vip: 'VIP',
      subscriber: 'Subscriber',
      founder: 'Founder',
      verified: 'Verified',
      staff: 'Staff',
      admin: 'Admin',
      global_moderator: 'Global Moderator',
    },
    kick: {
      broadcaster: 'Broadcaster',
      moderator: 'Moderator',
      verified: 'Verified',
      subscriber: 'Subscriber',
      founder: 'Founder',
      partner: 'Partner',
      creator: 'Creator',
    },
    youtube: {
      owner: 'Channel Owner',
      moderator: 'Moderator',
      verified: 'Verified',
      verified_artist: 'Verified Artist',
      member: 'Channel Member',
    },
    tiktok: {
      host: 'Host',
      moderator: 'Moderator',
      subscriber: 'Subscriber',
      verified: 'Verified',
      top_gifter: 'Top Gifter',
    },
    rumble: {
      creator: 'Creator',
      moderator: 'Moderator',
      verified: 'Verified',
      subscriber: 'Subscriber',
      supporter: 'Supporter',
    },
    instagram: {
      creator: 'Creator',
      moderator: 'Moderator',
      verified: 'Verified',
    },
  };

  // id -> resolved <img> element (cloned per use so the same node isn't
  // moved between messages, but the network fetch + decode only happens once).
  const iconCache = new Map();

  function getCachedIcon(cacheKey, iconUrl) {
    if (iconCache.has(cacheKey)) {
      return iconCache.get(cacheKey).cloneNode(true);
    }
    const img = document.createElement('img');
    img.className = 'user-badge-icon';
    img.src = iconUrl;
    img.loading = 'eager';
    img.decoding = 'async';
    img.onerror = function () {
      // Missing/unreachable asset - hide rather than show a broken-image icon.
      img.style.display = 'none';
    };
    iconCache.set(cacheKey, img);
    return img.cloneNode(true);
  }

  function badgeLabel(platform, badge) {
    if (badge && badge.name) return badge.name;
    const platformLabels = BADGE_LABELS[platform] || {};
    return (badge && platformLabels[badge.id]) || (badge && badge.id) || '';
  }

  // Renders a message's badges array into a document fragment of
  // <span class="user-badge"><img>...</span> elements, preserving the order
  // the platform sent them in. Each badge is expected to carry a real
  // `icon` URL resolved server-side from the platform's own badge API
  // (e.g. Twitch Helix Chat Badges) - badges with no resolvable icon are
  // skipped rather than shown as a generic placeholder, since a fake badge
  // is worse than no badge.
  function renderBadges(platform, badges) {
    const frag = document.createDocumentFragment();
    if (!Array.isArray(badges) || !badges.length) return frag;

    badges.forEach((badge) => {
      if (!badge || !badge.id || !badge.icon) return;
      const wrap = document.createElement('span');
      wrap.className = 'user-badge';
      wrap.title = badgeLabel(platform, badge);
      const cacheKey = `${platform}:${badge.id}:${badge.version || '1'}`;
      wrap.appendChild(getCachedIcon(cacheKey, badge.icon));
      frag.appendChild(wrap);
    });

    return frag;
  }

  global.ChatBadges = { renderBadges };
})(window);
