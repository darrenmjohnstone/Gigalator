// Gigalator Service Worker
// Caches app shell for offline use at gigs
// MP3 tracks are cached on demand or via "Cache Setlist" button

const CACHE_NAME = 'gigalator-app-v29';
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
    }).then(function () {
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
    // Strip Range from request for cache lookup (we always store full 200)
    const cacheKey = new Request(request.url);
    let cached = await cache.match(cacheKey);

    if (!cached) {
      // Not in cache — fetch from network. Use a non-Range request so we
      // cache the full file for later.
      try {
        const fullResp = await fetch(request.url);
        if (fullResp.ok) {
          await cache.put(cacheKey, fullResp.clone());
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
