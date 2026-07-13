// Generic disk cache for real platform badge images.
//
// Each platform badge module (twitchBadges.js, etc.) calls
// `ensureCached(platform, id, version, remoteUrl)` once it knows the real
// remote URL for a badge (from that platform's own official API/library -
// this module doesn't know or guess URLs itself). The file is downloaded
// once to public/badges/<platform>/<id>/<version>.<ext> and served locally
// from then on by Express's existing `express.static(public/)` - see
// server.js. Subsequent calls for the same badge return the cached local
// path immediately without re-downloading.

const fs = require('fs');
const path = require('path');

const PUBLIC_BADGES_DIR = path.join(__dirname, '..', '..', '..', 'public', 'badges');
const DEBUG_BADGE_ASSETS = process.env.DEBUG_BADGE_ASSETS === 'true';

// key -> Promise<localPath|null>, so concurrent requests for the same badge
// during startup don't trigger duplicate downloads.
const inflight = new Map();

function extFromUrlOrContentType(remoteUrl, contentType) {
  const urlExt = path.extname(new URL(remoteUrl).pathname).toLowerCase();
  if (urlExt && urlExt.length <= 5) return urlExt;
  if (contentType && contentType.includes('svg')) return '.svg';
  if (contentType && contentType.includes('png')) return '.png';
  if (contentType && contentType.includes('jpeg')) return '.jpg';
  if (contentType && contentType.includes('webp')) return '.webp';
  return '.png';
}

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function ensureCached(platform, id, version, remoteUrl) {
  if (!remoteUrl) return null;

  const safePlatform = sanitizeSegment(platform);
  const safeId = sanitizeSegment(id);
  const safeVersion = sanitizeSegment(version || '1');
  const dir = path.join(PUBLIC_BADGES_DIR, safePlatform, safeId);
  const cacheKey = `${safePlatform}/${safeId}/${safeVersion}`;

  // Check disk first (covers restarts - we don't want to re-download
  // everything every time the process boots).
  const existing = findExistingFile(dir, safeVersion);
  if (existing) {
    return toPublicPath(existing);
  }

  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const downloadPromise = (async () => {
    try {
      const res = await fetch(remoteUrl);
      if (!res.ok) {
        console.error(`[badgeCache] failed to fetch ${remoteUrl}: ${res.status}`);
        return null;
      }
      const contentType = res.headers.get('content-type') || '';
      const ext = extFromUrlOrContentType(remoteUrl, contentType);
      const buffer = Buffer.from(await res.arrayBuffer());

      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${safeVersion}${ext}`);
      fs.writeFileSync(filePath, buffer);

      if (DEBUG_BADGE_ASSETS) {
        console.log(`[badgeCache] cached ${cacheKey} -> ${filePath} (${buffer.length} bytes)`);
      }

      return toPublicPath(filePath);
    } catch (err) {
      console.error(`[badgeCache] error caching ${cacheKey}:`, err.message);
      return null;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, downloadPromise);
  return downloadPromise;
}

function findExistingFile(dir, versionStem) {
  try {
    const files = fs.readdirSync(dir);
    const match = files.find((f) => path.parse(f).name === versionStem);
    return match ? path.join(dir, match) : null;
  } catch (_err) {
    return null; // dir doesn't exist yet
  }
}

function toPublicPath(absPath) {
  const publicRoot = path.join(__dirname, '..', '..', '..', 'public');
  const rel = path.relative(publicRoot, absPath).split(path.sep).join('/');
  return `/${rel}`;
}

module.exports = { ensureCached };
