// Unofficial fallback data source, used only when the official YouTube
// Data API v3 is unavailable (quota exhausted, invalid credentials,
// network failure, 5xx, timeout, or missing concurrentViewers).
//
// Backed by youtubei.js (https://github.com/LuanRT/YouTube.js), an actively
// maintained client for YouTube's internal "InnerTube" API - the same API
// youtube.com itself uses. It's a structured JSON API, not HTML scraping.
//
// This module is intentionally isolated behind the same
// { live, viewers, videoId } shape as officialProvider.js.
const log = require("./logger");
const { config } = require("./config");
const { Innertube, Log } = require("youtubei.js");

// Quiet youtubei.js's internal debug/warn noise (e.g. "Unable to find
// matching run for attachment run" when it parses unrelated search
// results' rich text). Real failures still surface via thrown errors,
// which we catch and log ourselves below.
try {
    Log.setLevel(Log.Level.ERROR);
} catch (e) {
    // Older/newer youtubei.js versions may not expose Log the same way -
    // non-fatal, just means we won't be able to suppress its own logging.
}

const DEFAULT_TIMEOUT_MS = config?.fallbackTimeoutMs ?? 8000;

let yt;
let ytInitPromise;

async function getYT({ forceNew = false } = {}) {
    if (forceNew) {
        yt = null;
        ytInitPromise = null;
    }
    if (!yt) {
        if (!ytInitPromise) {
            ytInitPromise = Innertube.create({
                generate_session_locally: true
            }).then(instance => {
                yt = instance;
                return instance;
            }).catch(e => {
                ytInitPromise = null;
                throw e;
            });
        }
        return ytInitPromise;
    }
    return yt;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseNumber(text) {
    if (text === null || text === undefined) return null;
    const str = typeof text === "string" ? text : String(text);
    const match = str
        .replace(/,/g, "")
        .match(/([\d.]+)\s*([KMB]?)/i);
    if (!match) return null;
    let n = parseFloat(match[1]);
    switch ((match[2] || "").toUpperCase()) {
        case "K":
            n *= 1e3;
            break;
        case "M":
            n *= 1e6;
            break;
        case "B":
            n *= 1e9;
            break;
    }
    return Math.round(n);
}

// The concurrent "watching now" count lives in primary_info.view_count for
// live videos - basic_info.view_count is usually the cumulative view count
// and will be wrong for a live stream.
function extractConcurrentViewers(info) {
    const liveViewText =
        info?.primary_info?.view_count?.view_count?.text ??
        info?.primary_info?.view_count?.original_view_count ??
        info?.primary_info?.view_count?.extra_short_view_count?.text ??
        null;

    const parsed = parseNumber(liveViewText);
    if (parsed !== null) return parsed;

    log.warn(
        "Falling back to basic_info.view_count for concurrent viewers - " +
            "this is likely the cumulative view count, not live viewers."
    );
    return Number(info?.basic_info?.view_count) || null;
}

function looksLikeSessionError(e) {
    const msg = String(e?.message || e || "").toLowerCase();
    return (
        msg.includes("session") ||
        msg.includes("auth") ||
        msg.includes("token") ||
        msg.includes("403") ||
        msg.includes("401")
    );
}

async function withApi(fn, label) {
    const api = await getYT();
    try {
        return await withTimeout(fn(api), DEFAULT_TIMEOUT_MS, label);
    } catch (e) {
        if (looksLikeSessionError(e)) {
            log.warn(`Session appears stale during ${label}, recreating.`, e);
            const fresh = await getYT({ forceNew: true });
            return await withTimeout(fn(fresh), DEFAULT_TIMEOUT_MS, label);
        }
        throw e;
    }
}

function buildResult(info, fallbackVideoId) {
    return {
        live: true,
        viewers: extractConcurrentViewers(info),
        videoId: info?.basic_info?.id ?? fallbackVideoId
    };
}

// Find a live video from a channel's tabs without assuming a specific
// youtubei.js shape - different versions expose this differently
// (channel.getLiveStreams(), a "Live" tab, or plain .videos), so we try
// the known options in order and fall back gracefully.
async function findLiveFromChannel(channel) {
    if (typeof channel?.getLiveStreams === "function") {
        try {
            const liveTab = await channel.getLiveStreams();
            const vid =
                liveTab?.videos?.find(v => v.is_live) ??
                liveTab?.videos?.[0];
            if (vid) return vid;
        } catch (e) {
            log.warn("getLiveStreams() failed, trying other methods", e);
        }
    }

    if (typeof channel?.getTabByName === "function") {
        try {
            const liveTab = await channel.getTabByName("Live");
            const vid = liveTab?.videos?.find(v => v.is_live);
            if (vid) return vid;
        } catch (e) {
            log.warn("getTabByName('Live') failed, trying other methods", e);
        }
    }

    if (Array.isArray(channel?.videos)) {
        const vid = channel.videos.find(v => v.is_live);
        if (vid) return vid;
    }

    return null;
}

// Try to resolve a human-readable channel name/title, needed to make
// Method 3's search query meaningful. Returns null if nothing usable was
// found (in which case the caller should skip Method 3 entirely, rather
// than searching on a raw channel ID, which returns irrelevant results).
function resolveChannelName(channel) {
    return (
        channel?.metadata?.title ??
        channel?.header?.title?.text ??
        channel?.header?.author?.name ??
        null
    );
}

async function checkFallback({ channelId, videoId }) {
    // Method 1: known video ID
    if (videoId) {
        try {
            const info = await withApi(
                api => api.getInfo(videoId),
                `getInfo(${videoId})`
            );
            if (info?.basic_info?.is_live) {
                return buildResult(info, videoId);
            }
        } catch (e) {
            log.warn(e);
        }
    }

    // Method 2: channel's own live tab
    let channel;
    let channelName = null;
    if (channelId) {
        try {
            channel = await withApi(
                api => api.getChannel(channelId),
                `getChannel(${channelId})`
            );
            channelName = resolveChannelName(channel);

            const live = await findLiveFromChannel(channel);
            if (live) {
                const info = await withApi(
                    api => api.getInfo(live.id),
                    `getInfo(${live.id})`
                );
                if (info?.basic_info?.is_live) {
                    return buildResult(info, live.id);
                }
            }
        } catch (e) {
            log.warn(e);
        }
    }

    // Method 3: search by the channel's resolved name, filtered to videos
    // actually authored by that channel. Skipped entirely if we have no
    // name to search on - searching for a raw channel ID returns noisy,
    // irrelevant results and isn't a meaningful query.
    if (channelId && channelName) {
        try {
            const search = await withApi(
                api => api.search(channelName, { type: "video" }),
                `search(${channelName})`
            );

            const live = (search?.results ?? []).find(
                v =>
                    v.is_live &&
                    (v.author?.id === channelId ||
                        v.author?.channel_id === channelId)
            );

            if (live) {
                const info = await withApi(
                    api => api.getInfo(live.id),
                    `getInfo(${live.id})`
                );
                if (info?.basic_info?.is_live) {
                    return buildResult(info, live.id);
                }
            }
        } catch (e) {
            log.warn(e);
        }
    } else if (channelId) {
        log.warn(
            `Skipping Method 3 (search) for channel ${channelId} - no ` +
                `channel name could be resolved to search on.`
        );
    }

    return {
        live: false,
        viewers: null,
        videoId: null
    };
}

module.exports = {
    checkFallback
};
