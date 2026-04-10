// Gigalator Service Worker
// Caches app shell + songs.json for offline use
// MP3 tracks are cached on demand or via "Cache Setlist" button

const CACHE_NAME = 'gigalator-app-v1';
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

// Fetch — cache-first for app shell, cache-first for tracks (if cached)
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);

  // MP3 track requests
  if (url.pathname.includes('/tracks/') && url.pathname.endsWith('.mp3')) {
    event.respondWith(
      caches.open(TRACK_CACHE).then(function (cache) {
        return cache.match(event.request).then(function (cached) {
          if (cached) return cached;

          // Not cached — fetch from network and cache for next time
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

  // App shell — cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        // Cache new app resources on the fly
        if (response.ok && event.request.method === 'GET') {
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, response.clone());
          });
        }
        return response;
      });
    })
  );
});
