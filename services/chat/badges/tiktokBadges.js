// Real TikTok LIVE badge resolution.
//
// The actual badge detection happens in the Python sidecar
// (tiktok-service/app.py), which reads TikTokLive.py's own documented
// per-user properties (is_moderator, is_subscriber, is_top_gifter,
// verified, subscriber_badge - see
// https://isaackogan.github.io/TikTokLive/TikTokLive.proto.html) and
// sends us badges already shaped as { id, name, icon? }. "Host" is
// resolved there too, via a real identity check (commenter's unique_id
// matches the channel we connected to) rather than a guessed field.
//
// This module's only job on the Node side is caching: the sidecar's
// subscriber badge `icon` is a real, live TikTok CDN URL - the only one of
// these badges TikTokLive exposes actual art for - so we download it once
// via the shared badgeCache and serve it locally afterward, same as the
// Twitch/Kick/YouTube badge assets.
//
// Moderator/verified/top-gifter/host badges arrive with no `icon`
// (TikTokLive doesn't expose static badge art for those) and are passed
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
        icon = await badgeCache.ensureCached('tiktok', raw.id, '1', raw.icon);
      }

      return {
        id: raw.id,
        name: raw.name || raw.id,
        platform: 'tiktok',
        icon: icon || undefined,
      };
    })
  );

  const badges = resolved.filter(Boolean);

  if (DEBUG_BADGES && badges.length) {
    console.log(`[tiktokBadges] Parsed: ${badges.map((b) => `${b.name}${b.icon ? '' : ' (no icon available)'}`).join(', ')}`);
  }

  return badges;
}

module.exports = { resolveBadges };
