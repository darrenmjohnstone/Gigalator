// Gigalator Service Worker
// Caches app shell for offline use at gigs
// MP3 tracks are cached on demand or via "Cache Setlist" button

const CACHE_NAME = 'gigalator-app-v41';
const TRACK_CACHE = 'gigalator-tracks-v1';

// App shell files to cache immediately
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './songs/songs.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Files that should never be cached (Mac-only tools)
const NO_CACHE = ['manager.html', 'deploy.command'];

// Install — cache app shell
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Activate — clean up old caches
// On activation, do two passes:
//   1. Delete old app-shell caches that aren't the current CACHE_NAME.
//   2. Scan the persistent TRACK_CACHE and delete any zero-byte entries
//      left over from a previous bad encode/upload. Without this purge,
//      stale 0-byte entries are sticky and the audio element silently
//      fails to play those tracks.
async function purgeZeroByteTrackEntries() {
  try {
    const cache = await caches.open(TRACK_CACHE);
    const requests = await cache.keys();
    let purged = 0;
    for (const req of requests) {
      try {
        const resp = await cache.match(req);
        if (!resp) continue;
        const buf = await resp.clone().arrayBuffer();
        if (buf.byteLength === 0) {
          await cache.delete(req);
          purged++;
          console.log('[SW] Purged zero-byte cached track:', req.url);
        }
      } catch (e) {
        // If we can't read it, treat as broken and delete
        await cache.delete(req);
        purged++;
      }
    }
    if (purged > 0) console.log('[SW] Total zero-byte tracks purged:', purged);
  } catch (e) {
    console.warn('[SW] Track cache purge failed:', e);
  }
}

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) {
          return key !== CACHE_NAME && key !== TRACK_CACHE;
        }).map(function (key) {
          return caches.delete(key);
        })
      );
    })
    .then(purgeZeroByteTrackEntries)
    .then(function () {
      return self.clients.claim();
    })
  );
});

// Handle audio track requests with proper Range support for iOS Safari.
// iOS <audio> sends Range: bytes=X-Y requests. If we serve a cached 200
// response directly, iOS may fail playback or seeking. Instead, we slice
// the cached full response and return a proper 206 Partial Content.
async function handleTrackRequest(request) {
  try {
    const cache = await caches.open(TRACK_CACHE);
    // Strip Range AND any cache-busting query params (e.g. ?t=12345) for
    // cache lookup. The app appends timestamps to force the audio element
    // out of stuck states, but we still want the SW to recognise the same
    // underlying track and reuse cached bytes.
    const u = new URL(request.url);
    u.search = '';
    const canonicalUrl = u.toString();
    const cacheKey = new Request(canonicalUrl);
    let cached = await cache.match(cacheKey);

    // Treat a zero-byte cached entry as missing. We accidentally deployed
    // some 0-byte MP3s in a bad bulk re-encode; the SW had cached them and
    // would happily keep serving 0 bytes forever. By validating size we
    // self-heal: a bad entry gets evicted and re-fetched fresh.
    if (cached) {
      try {
        const peek = await cached.clone().arrayBuffer();
        if (peek.byteLength === 0) {
          await cache.delete(cacheKey);
          cached = null;
        }
      } catch (_) {
        // If we can't peek, assume invalid and refetch
        await cache.delete(cacheKey);
        cached = null;
      }
    }

    if (!cached) {
      // Not in cache — fetch from network. Use the canonical URL (no
      // query string) so any cache layer between us and origin treats
      // requests for the same track as the same resource.
      try {
        const fullResp = await fetch(canonicalUrl);
        if (fullResp.ok) {
          // Verify the network response isn't 0 bytes either before caching
          const respClone = fullResp.clone();
          const buf = await respClone.clone().arrayBuffer();
          if (buf.byteLength > 0) {
            await cache.put(cacheKey, respClone);
          }
          cached = fullResp;
        } else {
          // Fall back to returning whatever the network gave us
          return fullResp;
        }
      } catch (e) {
        // Offline and not cached — nothing we can do
        return new Response('', { status: 504, statusText: 'Not cached and offline' });
      }
    }

    // If the request had no Range header, return the full cached response
    const rangeHeader = request.headers.get('range');
    if (!rangeHeader) return cached;

    // Parse Range: "bytes=start-end"
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) return cached;

    const fullBuffer = await cached.clone().arrayBuffer();
    const totalSize = fullBuffer.byteLength;
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

    if (start >= totalSize) {
      return new Response('', { status: 416, statusText: 'Range Not Satisfiable' });
    }

    const slice = fullBuffer.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': String(slice.byteLength),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + totalSize,
        'Accept-Ranges': 'bytes'
      }
    });
  } catch (e) {
    // Last resort — go straight to network
    return fetch(request);
  }
}

// Fetch strategy
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Never cache manager or deploy script
  for (var i = 0; i < NO_CACHE.length; i++) {
    if (url.pathname.endsWith(NO_CACHE[i])) {
      event.respondWith(fetch(event.request));
      return;
    }
  }

  // Audio track requests — handle Range requests properly for iOS Safari
  if (url.pathname.includes('/tracks/') && (url.pathname.endsWith('.mp3') || url.pathname.endsWith('.m4a'))) {
    event.respondWith(handleTrackRequest(event.request));
    return;
  }

  // songs.json — network first so iPad picks up new songs when online
  if (url.pathname.endsWith('/songs.json')) {
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response.ok) {
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, response.clone());
          });
        }
        return response;
      }).catch(function () {
        return caches.match(event.request);
      })
    );
    return;
  }

  // App shell — network first with cache fallback
  // This ensures updates are picked up when online, but still works offline
  event.respondWith(
    fetch(event.request).then(function (response) {
      if (response.ok && event.request.method === 'GET') {
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, response.clone());
        });
      }
      return response;
    }).catch(function () {
      return caches.match(event.request);
    })
  );
});
