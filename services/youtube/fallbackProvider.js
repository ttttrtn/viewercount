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
const { Innertube } = require("youtubei.js");

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
// and will be wrong (often much larger or smaller) for a live stream.
function extractConcurrentViewers(info) {
    const liveViewText =
        info?.primary_info?.view_count?.view_count?.text ??
        info?.primary_info?.view_count?.original_view_count ??
        info?.primary_info?.view_count?.extra_short_view_count?.text ??
        null;

    const parsed = parseNumber(liveViewText);
    if (parsed !== null) return parsed;

    // Last resort - not accurate for live streams, but better than nothing.
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

async function buildResult(info, fallbackVideoId) {
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
    if (channelId) {
        try {
            channel = await withApi(
                api => api.getChannel(channelId),
                `getChannel(${channelId})`
            );
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

    // Method 3: search - use the channel's name as the query text (a raw
    // channel ID is not a meaningful search term), then filter results to
    // videos actually authored by that channel.
    if (channelId) {
        try {
            const channelName =
                channel?.metadata?.title ?? channel?.header?.title?.text;
            const query = channelName ?? channelId;

            const search = await withApi(
                api => api.search(query, { type: "video" }),
                `search(${query})`
            );

            const candidates = (search?.results ?? []).filter(
                v =>
                    v.is_live &&
                    (v.author?.id === channelId ||
                        v.author?.channel_id === channelId ||
                        !channelName) // if we had no name to filter by, trust is_live alone
            );

            const live = candidates[0];
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

    return {
        live: false,
        viewers: null,
        videoId: null
    };
}

module.exports = {
    checkFallback
};
