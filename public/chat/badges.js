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

  function badgeIconUrl(platform, badgeId) {
    return `/icons/badges/${platform}/${badgeId}.svg`;
  }

  function getCachedIcon(platform, badgeId) {
    const key = `${platform}:${badgeId}`;
    if (iconCache.has(key)) {
      return iconCache.get(key).cloneNode(true);
    }
    const img = document.createElement('img');
    img.className = 'user-badge-icon';
    img.src = badgeIconUrl(platform, badgeId);
    img.loading = 'eager';
    img.decoding = 'async';
    img.onerror = function () {
      // Missing/renamed asset - hide rather than show a broken-image icon.
      img.style.display = 'none';
    };
    iconCache.set(key, img);
    return img.cloneNode(true);
  }

  function badgeLabel(platform, badge) {
    if (badge && badge.name) return badge.name;
    const platformLabels = BADGE_LABELS[platform] || {};
    return (badge && platformLabels[badge.id]) || (badge && badge.id) || '';
  }

  // Renders a message's badges array into a document fragment of
  // <span class="user-badge"><img>...</span> elements, preserving the order
  // the platform sent them in.
  function renderBadges(platform, badges) {
    const frag = document.createDocumentFragment();
    if (!Array.isArray(badges) || !badges.length) return frag;

    badges.forEach((badge) => {
      if (!badge || !badge.id) return;
      const wrap = document.createElement('span');
      wrap.className = 'user-badge';
      wrap.title = badgeLabel(platform, badge);
      wrap.appendChild(getCachedIcon(platform, badge.id));
      frag.appendChild(wrap);
    });

    return frag;
  }

  global.ChatBadges = { renderBadges, badgeIconUrl };
})(window);
