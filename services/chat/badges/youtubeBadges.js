// Real YouTube badge resolution.
//
// The actual badge detection happens in the Python sidecar
// (youtube-chat-service/app.py), which reads pytchat's own documented
// per-author fields (isChatOwner, isChatModerator, isVerified,
// isChatSponsor, badgeUrl - see
// https://github.com/taizan-hokuto/pytchat/wiki/DefaultProcessor) and
// sends us badges already shaped as { id, name, icon? }.
//
// This module's only job on the Node side is caching: pytchat's
// `badgeUrl` for channel-member badges is a real, live YouTube CDN URL,
// so we download it once via the shared badgeCache and serve it locally
// afterward, same as the Twitch/Kick badge assets.
//
// Owner/moderator/verified badges arrive with no `icon` (YouTube doesn't
// expose static badge art for those through pytchat) and are passed
// through as-is; the frontend renderer skips any badge with no icon.

const badgeCache = require('./badgeCache');

const DEBUG_BADGES = process.env.DEBUG_BADGES === 'true';

async function resolveBadges(rawBadges) {
  if (!Array.isArray(rawBadges) || !rawBadges.length) return [];

  const resolved = await Promise.all(
    rawBadges.map(async (raw) => {
      if (!raw || !raw.id) return null;

      let icon;
      if (raw.icon) {
        // Member badge art doesn't version/tier the way Twitch/Kick sub
        // badges do, so we just use the badge id as the cache key.
        icon = await badgeCache.ensureCached('youtube', raw.id, '1', raw.icon);
      }

      return {
        id: raw.id,
        name: raw.name || raw.id,
        platform: 'youtube',
        icon: icon || undefined,
      };
    })
  );

  const badges = resolved.filter(Boolean);

  if (DEBUG_BADGES && badges.length) {
    console.log(`[youtubeBadges] Parsed: ${badges.map((b) => `${b.name}${b.icon ? '' : ' (no icon available)'}`).join(', ')}`);
  }

  return badges;
}

module.exports = { resolveBadges };
