// Real Kick badge resolution.
//
// Kick chat messages carry real badge data on the message payload itself at
// `user.identity.badges` (or `data.sender.identity.badges` depending on
// which event Kick sends) - an array of { type, text, count } objects, e.g.
//   { type: "moderator", text: "Moderator" }
//   { type: "subscriber", text: "Subscriber", count: 12 }
// `type` and `text` come directly from Kick, so we never invent a badge
// name - we just pass through what Kick itself labeled the badge.
// (Confirmed against Kick's own reverse-engineered event shape and the
// typed `Badge{Text, Type, Count}` struct in community Kick API clients.)
//
// What Kick does NOT expose anywhere public is a "get badge image by type"
// endpoint for role badges (moderator/broadcaster/vip/founder/verified/
// staff) - those are just baked into Kick's own frontend, with no
// documented URL scheme we can rely on. We do NOT guess an image for
// those; they're passed through with id/name only, and the frontend
// renderer already skips any badge with no resolvable icon rather than
// showing a placeholder.
//
// Subscriber badges ARE resolvable for real: Kick's public channel lookup
// endpoint (kick.com/api/v2/channels/<slug> - the same one kickChat.js
// already calls to resolve chatroom_id) returns the channel's actual
// uploaded subscriber-badge tiers as `subscriber_badges: [{ months,
// badge_image: { src } }, ...]`. We match the chatter's `count` (months
// subscribed) to the highest tier threshold they've reached.

const badgeCache = require('./badgeCache');

const DEBUG_BADGES = process.env.DEBUG_BADGES === 'true';

// Resolves the real subscriber badge image for a given month count, from
// the channel's own subscriber_badges list (already fetched by kickChat.js
// as part of its existing chatroom-lookup call - no extra request needed).
function findSubscriberTier(subscriberBadges, months) {
  if (!Array.isArray(subscriberBadges) || !subscriberBadges.length) return null;

  const sorted = subscriberBadges
    .filter((b) => b && b.badge_image && (b.badge_image.src || b.badge_image.srcset))
    .slice()
    .sort((a, b) => (a.months || 0) - (b.months || 0));

  let best = null;
  for (const tier of sorted) {
    if ((tier.months || 0) <= months) best = tier;
  }
  return best;
}

/**
 * Turns Kick's raw identity.badges entries into unified badge objects.
 * `subscriberBadges` is the channel's real subscriber_badges array (or null
 * if we don't have it yet / lookup failed - subscriber badges will simply
 * have no icon in that case, same as role badges).
 */
async function resolveBadges(rawBadges, subscriberBadges) {
  if (!Array.isArray(rawBadges) || !rawBadges.length) return [];

  const resolved = await Promise.all(
    rawBadges.map(async (raw) => {
      if (!raw || !raw.type) return null;

      const id = String(raw.type).toLowerCase();
      const name = raw.text || raw.type;
      const months = typeof raw.count === 'number' ? raw.count : null;

      let icon;
      if (id === 'subscriber' && months !== null) {
        const tier = findSubscriberTier(subscriberBadges, months);
        if (tier) {
          const remoteUrl = (tier.badge_image && tier.badge_image.src) || null;
          icon = await badgeCache.ensureCached('kick', 'subscriber', tier.months, remoteUrl);
        }
      }
      // Role badges (moderator/broadcaster/vip/founder/verified/staff/etc.)
      // have no publicly resolvable image - icon stays undefined and the
      // frontend will skip rendering them, per "don't fake it".

      return {
        id,
        name,
        platform: 'kick',
        version: months !== null ? String(months) : undefined,
        icon: icon || undefined,
      };
    })
  );

  const badges = resolved.filter(Boolean);

  if (DEBUG_BADGES) {
    console.log(
      `[kickBadges] Raw: ${JSON.stringify(rawBadges)} -> Parsed: ${badges
        .map((b) => `${b.name}${b.icon ? '' : ' (no icon available)'}`)
        .join(', ') || '(none)'}`
    );
  }

  return badges;
}

module.exports = { resolveBadges };
