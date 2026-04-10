// ── Gigalator ──
// Gig setlist, lyrics & backing track PWA

(function () {
  'use strict';

  // ── State ──
  let data = null;          // songs.json content
  let currentView = 'setlists';
  let currentSetlist = null;
  let currentSong = null;

  // ── DOM refs ──
  const main = document.getElementById('main');
  const headerTitle = document.getElementById('header-title');
  const backBtn = document.getElementById('back-btn');
  const player = document.getElementById('player');
  const playBtn = document.getElementById('play-btn');
  const progressWrap = document.getElementById('progress-wrap');
  const progressBar = document.getElementById('progress-bar');
  const timeDisplay = document.getElementById('time-display');
  const audio = document.getElementById('audio');

  // ── Init ──
  async function init() {
    try {
      const resp = await fetch('songs/songs.json');
      data = await resp.json();
    } catch (e) {
      main.innerHTML = '<p style="color:var(--danger);padding:20px">Failed to load songs. Check songs/songs.json exists.</p>';
      return;
    }

    backBtn.addEventListener('click', goBack);
    playBtn.addEventListener('click', togglePlay);
    progressWrap.addEventListener('click', seek);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', onTrackEnd);

    showSetlists();
    registerSW();
  }

  // ── Service Worker Registration ──
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('SW registration failed:', err);
      });
    }
  }

  // ── Navigation ──
  function goBack() {
    if (currentView === 'lyrics') {
      stopAudio();
      main.classList.remove('lyrics-mode');
      showSongList(currentSetlist);
    } else if (currentView === 'songs') {
      showSetlists();
    }
  }

  function setHeader(title, showBack) {
    headerTitle.textContent = title;
    backBtn.classList.toggle('hidden', !showBack);
  }

  // ── View: Setlists ──
  function showSetlists() {
    currentView = 'setlists';
    currentSetlist = null;
    currentSong = null;
    setHeader('Gigalator', false);
    player.classList.add('hidden');

    let html = '<div class="section-label">Setlists</div>';

    data.setlists.forEach(function (sl) {
      const count = sl.songs.length;
      html += '<div class="list-item" data-setlist="' + sl.id + '">'
        + '<div class="list-item-text">'
        + '<div class="list-item-title">' + esc(sl.name) + '</div>'
        + '<div class="list-item-subtitle">' + count + ' song' + (count !== 1 ? 's' : '') + '</div>'
        + '</div>'
        + '<span class="list-item-arrow">&#8250;</span>'
        + '</div>';
    });

    // All Songs option
    const total = Object.keys(data.songs).length;
    html += '<div class="section-label" style="margin-top:24px">Library</div>';
    html += '<div class="list-item" data-setlist="__all__">'
      + '<div class="list-item-text">'
      + '<div class="list-item-title">All Songs</div>'
      + '<div class="list-item-subtitle">' + total + ' song' + (total !== 1 ? 's' : '') + '</div>'
      + '</div>'
      + '<span class="list-item-arrow">&#8250;</span>'
      + '</div>';

    main.innerHTML = html;
    main.scrollTop = 0;

    main.querySelectorAll('[data-setlist]').forEach(function (el) {
      el.addEventListener('click', function () {
        const id = el.getAttribute('data-setlist');
        if (id === '__all__') {
          showSongList({ id: '__all__', name: 'All Songs', songs: Object.keys(data.songs) });
        } else {
          const setlist = data.setlists.find(function (s) { return s.id === id; });
          if (setlist) showSongList(setlist);
        }
      });
    });
  }

  // ── View: Song List ──
  function showSongList(setlist) {
    currentView = 'songs';
    currentSetlist = setlist;
    currentSong = null;
    setHeader(setlist.name, true);
    player.classList.add('hidden');

    // Check which tracks are cached
    const trackSongs = setlist.songs.filter(function (id) {
      return data.songs[id] && data.songs[id].track;
    });

    let html = '';

    // Cache button if any songs have tracks
    if (trackSongs.length > 0) {
      html += '<div class="setlist-header">'
        + '<h2>' + setlist.songs.length + ' songs</h2>'
        + '<button class="cache-btn" id="cache-setlist-btn">Cache Tracks</button>'
        + '</div>';
    } else {
      html += '<div class="setlist-header"><h2>' + setlist.songs.length + ' songs</h2></div>';
    }

    setlist.songs.forEach(function (songId) {
      const song = data.songs[songId];
      if (!song) return;

      html += '<div class="list-item" data-song="' + songId + '">'
        + '<div class="list-item-text">'
        + '<div class="list-item-title">' + esc(song.title) + '</div>'
        + '<div class="list-item-subtitle">' + esc(song.artist) + '</div>'
        + '</div>';

      if (song.track) {
        html += '<span class="track-badge">Track</span>';
      }

      html += '<span class="list-item-arrow">&#8250;</span></div>';
    });

    main.innerHTML = html;
    main.scrollTop = 0;

    // Bind song clicks
    main.querySelectorAll('[data-song]').forEach(function (el) {
      el.addEventListener('click', function () {
        const id = el.getAttribute('data-song');
        showLyrics(id);
      });
    });

    // Bind cache button
    const cacheBtn = document.getElementById('cache-setlist-btn');
    if (cacheBtn) {
      checkCacheStatus(trackSongs, cacheBtn);
      cacheBtn.addEventListener('click', function () {
        cacheSetlistTracks(setlist, cacheBtn);
      });
    }
  }

  // ── View: Lyrics ──
  var currentFontSize = 18;
  var DEFAULT_FONT_SIZE = 18;
  var MIN_FONT_SIZE = 10;
  var MAX_FONT_SIZE = 36;

  function showLyrics(songId) {
    currentView = 'lyrics';
    currentSong = songId;
    var song = data.songs[songId];
    if (!song) return;

    setHeader(song.title, true);

    currentFontSize = song.fontSize || DEFAULT_FONT_SIZE;

    main.classList.add('lyrics-mode');

    var html = '<div class="lyrics-wrap">'
      + '<div class="lyrics-top-bar">'
      + '<div class="lyrics-artist">' + esc(song.artist) + '</div>'
      + '<div class="font-size-controls">'
      + '<button class="font-size-btn" id="font-dec">&#8722;</button>'
      + '<span class="font-size-label" id="font-label">' + currentFontSize + 'px</span>'
      + '<button class="font-size-btn" id="font-inc">&#43;</button>'
      + '</div>'
      + '</div>'
      + '<div class="lyrics" id="lyrics-text">' + esc(song.lyrics) + '</div>'
      + '</div>';

    main.innerHTML = html;

    var lyricsEl = document.getElementById('lyrics-text');
    lyricsEl.style.fontSize = currentFontSize + 'px';

    document.getElementById('font-dec').addEventListener('click', function () {
      adjustFontSize(-1, lyricsEl);
    });
    document.getElementById('font-inc').addEventListener('click', function () {
      adjustFontSize(1, lyricsEl);
    });

    // Audio
    if (song.track) {
      audio.src = song.track;
      player.classList.remove('hidden');
      playBtn.innerHTML = '&#9654;';
      progressBar.style.width = '0%';
      timeDisplay.textContent = '0:00';
    } else {
      player.classList.add('hidden');
    }
  }

  function adjustFontSize(delta, lyricsEl) {
    currentFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, currentFontSize + delta));
    lyricsEl.style.fontSize = currentFontSize + 'px';
    document.getElementById('font-label').textContent = currentFontSize + 'px';
  }

  // ── Audio Controls ──
  function togglePlay() {
    if (audio.paused) {
      audio.play().catch(function () {
        // Autoplay blocked — user needs to tap again
      });
      playBtn.innerHTML = '&#9646;&#9646;';
    } else {
      audio.pause();
      playBtn.innerHTML = '&#9654;';
    }
  }

  function stopAudio() {
    audio.pause();
    audio.src = '';
    playBtn.innerHTML = '&#9654;';
    progressBar.style.width = '0%';
    timeDisplay.textContent = '0:00';
    player.classList.add('hidden');
  }

  function seek(e) {
    if (!audio.duration) return;
    const rect = progressWrap.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  }

  function updateProgress() {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    progressBar.style.width = pct + '%';
    timeDisplay.textContent = formatTime(audio.currentTime);
  }

  function onTrackEnd() {
    playBtn.innerHTML = '&#9654;';
    progressBar.style.width = '100%';
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── Caching ──
  async function checkCacheStatus(trackSongIds, btn) {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open('gigalator-tracks-v1');
      let allCached = true;
      for (const id of trackSongIds) {
        const song = data.songs[id];
        if (song && song.track) {
          const match = await cache.match(song.track);
          if (!match) {
            allCached = false;
            break;
          }
        }
      }
      if (allCached) {
        btn.textContent = 'Cached';
        btn.classList.add('cached');
      }
    } catch (e) {
      // ignore
    }
  }

  async function cacheSetlistTracks(setlist, btn) {
    if (!('caches' in window)) {
      btn.textContent = 'Not supported';
      return;
    }

    const trackSongs = setlist.songs
      .map(function (id) { return data.songs[id]; })
      .filter(function (s) { return s && s.track; });

    if (trackSongs.length === 0) return;

    btn.disabled = true;
    let cached = 0;

    try {
      const cache = await caches.open('gigalator-tracks-v1');

      for (const song of trackSongs) {
        try {
          const existing = await cache.match(song.track);
          if (!existing) {
            await cache.add(song.track);
          }
          cached++;
          btn.textContent = 'Caching ' + cached + '/' + trackSongs.length;
        } catch (e) {
          console.warn('Failed to cache:', song.track, e);
          cached++;
          btn.textContent = 'Caching ' + cached + '/' + trackSongs.length;
        }
      }

      btn.textContent = 'Cached';
      btn.classList.add('cached');
    } catch (e) {
      btn.textContent = 'Cache failed';
    }

    btn.disabled = false;
  }

  // ── Helpers ──
  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Start ──
  document.addEventListener('DOMContentLoaded', init);
})();
