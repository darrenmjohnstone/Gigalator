// Gigalator Service Worker
// Caches app shell for offline use at gigs
// MP3 tracks are cached on demand or via "Cache Setlist" button

const CACHE_NAME = 'gigalator-app-v2';
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

  // Audio track requests — cache first, fallback to network (and cache on fetch)
  if (url.pathname.includes('/tracks/') && (url.pathname.endsWith('.mp3') || url.pathname.endsWith('.m4a'))) {
    event.respondWith(
      caches.open(TRACK_CACHE).then(function (cache) {
        return cache.match(event.request).then(function (cached) {
          if (cached) return cached;
          return fetch(event.request).then(function (response) {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          });
        });
      })
    );
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
