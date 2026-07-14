// Unofficial fallback data source, used only when the official YouTube
// Data API v3 is unavailable (quota exhausted, invalid credentials,
// network failure, 5xx, timeout, or missing concurrentViewers).
//
// Backed by youtubei.js (https://github.com/LuanRT/YouTube.js), an actively
// maintained client for YouTube's internal "InnerTube" API - the same API
// youtube.com itself uses. It's a structured JSON API, not HTML scraping,
// which is why it was chosen over scraping the watch/channel pages
// directly (scraping is only used here as a last-resort, and youtubei.js
// itself does not rely on it for the fields we need).
//
// This module is intentionally isolated behind the same
// { live, viewers, videoId } shape as officialProvider.js, so it can be
// swapped for a different fallback implementation later without touching
// index.js.

const log = require("./logger");
const { config } = require("./config");
const { Innertube } = require("youtubei.js");

let yt;

async function getYT() {
    if (!yt) {
        yt = await Innertube.create({
            generate_session_locally: true
        });
    }
    return yt;
}

function parseNumber(text) {
    if (!text) return null;

    const match = text
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

async function checkFallback({ channelId, videoId }) {

    const api = await getYT();

    // Method 1
    if (videoId) {
        try {
            const info = await api.getInfo(videoId);

            if (info.basic_info?.is_live) {
                return {
                    live: true,
                    viewers:
                        Number(info.basic_info.view_count) ||
                        parseNumber(info.basic_info.view_count),
                    videoId
                };
            }
        } catch (e) {
            log.warn(e);
        }
    }

    // Method 2
    if (channelId) {
        try {
            const channel = await api.getChannel(channelId);

            const live = channel?.videos?.find(v => v.is_live);

            if (live) {

                const info = await api.getInfo(live.id);

                return {
                    live: true,
                    viewers:
                        Number(info.basic_info?.view_count) ||
                        parseNumber(info.basic_info?.view_count),
                    videoId: live.id
                };
            }

        } catch (e) {
            log.warn(e);
        }
    }

    // Method 3
    if (channelId) {
        try {

            const search = await api.search(channelId, {
                type: "video"
            });

            const live = search.results.find(v => v.is_live);

            if (live) {

                const info = await api.getInfo(live.id);

                return {
                    live: true,
                    viewers:
                        Number(info.basic_info?.view_count) ||
                        parseNumber(info.basic_info?.view_count),
                    videoId: live.id
                };
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
