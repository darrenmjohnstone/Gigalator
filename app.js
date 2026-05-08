// ── Gigalator ──
// Gig setlist, lyrics & backing track PWA

(function () {
  'use strict';

  // ── State ──
  let data = null;          // songs.json content
  let currentView = 'setlists';
  let currentSetlist = null;
  let currentSong = null;
  let playingSongId = null;  // which song's track is currently loaded/playing

  // ── DOM refs ──
  const main = document.getElementById('main');
  const headerTitle = document.getElementById('header-title');
  const backBtn = document.getElementById('back-btn');
  const player = document.getElementById('player');
  const playBtn = document.getElementById('play-btn');
  const progressWrap = document.getElementById('progress-wrap');
  const progressBar = document.getElementById('progress-bar');
  const timeDisplay = document.getElementById('time-display');
  const timeRemaining = document.getElementById('time-remaining');
  const trackLabel = document.getElementById('track-label');
  const audio = document.getElementById('audio');
  const nextBtn = document.getElementById('next-btn');
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchResultsEl = document.getElementById('search-results-fixed');

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
    nextBtn.addEventListener('click', playNextSong);
    progressWrap.addEventListener('click', seek);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', onTrackEnd);
    audio.addEventListener('error', function (e) {
      console.warn('Audio error:', audio.error && audio.error.code, audio.error && audio.error.message, 'for', audio.src);
    });
    searchInput.addEventListener('input', onSearchInput);

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
    // Request persistent storage so iOS won't evict cached tracks
    // and raises the origin quota ceiling.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (already) {
        if (!already) {
          navigator.storage.persist().then(function (granted) {
            console.log('Persistent storage granted:', granted);
          });
        } else {
          console.log('Persistent storage already granted');
        }
      });
    }
  }

  // Query the browser's storage quota — useful for diagnosing cache limits
  async function getStorageInfo() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      const est = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted
        ? await navigator.storage.persisted()
        : false;
      return {
        usage: est.usage || 0,
        quota: est.quota || 0,
        persisted: persisted,
        usageMB: Math.round((est.usage || 0) / 1024 / 1024),
        quotaMB: Math.round((est.quota || 0) / 1024 / 1024)
      };
    } catch (e) {
      return null;
    }
  }

  // ── Search ──
  function showSearch(placeholder) {
    searchInput.value = '';
    searchInput.placeholder = placeholder || 'Search songs...';
    searchBar.classList.remove('hidden');
  }

  function hideSearch() {
    // Explicit blur first so iOS releases the input before hiding the parent
    try { searchInput.blur(); } catch (e) {}
    searchBar.classList.add('hidden');
    searchResultsEl.classList.add('hidden');
    searchResultsEl.innerHTML = '';
    searchInput.value = '';
  }

  // iOS PWA sometimes drops the keyboard when the search bar reappears.
  // A touchend handler that re-focuses forces the keyboard to come back.
  document.addEventListener('DOMContentLoaded', function () {
    var si = document.getElementById('search-input');
    if (!si) return;
    si.addEventListener('touchend', function () {
      // Defer focus so iOS sees it as a user-gesture focus
      setTimeout(function () {
        if (document.activeElement !== si) si.focus();
      }, 0);
    });
  });

  // Match query against start of any word in text
  // Returns 0 = no match, 1 = word match, 2 = title starts with query
  function wordStartMatch(text, q) {
    var lower = text.toLowerCase();
    if (lower.indexOf(q) === 0) return 2;
    var words = lower.split(/[\s\-\/\(\)]+/);
    for (var i = 0; i < words.length; i++) {
      if (words[i].indexOf(q) === 0) return 1;
    }
    return 0;
  }

  function onSearchInput() {
    var q = searchInput.value.trim().toLowerCase();

    if (currentView === 'setlists' || currentView === 'songs') {
      if (q.length < 2) {
        searchResultsEl.classList.add('hidden');
        searchResultsEl.innerHTML = '';
        return;
      }

      // Always search the whole library — setlist context is just used
      // to pick the default setlist if you open a result from search.
      var matches = [];
      for (var sid in data.songs) {
        var s = data.songs[sid];
        var score = wordStartMatch(s.title, q);
        if (score > 0) {
          matches.push({ id: sid, title: s.title, artist: s.artist, hasTrack: !!s.track, score: score });
        }
      }

      // Best match at bottom (nearest play bar): lower score first, then Z-A within same score
      matches.sort(function (a, b) {
        if (a.score !== b.score) return a.score - b.score;
        return b.title.localeCompare(a.title);
      });

      var rhtml = '<div class="section-label">' + matches.length + ' result' + (matches.length !== 1 ? 's' : '') + '</div>';
      matches.forEach(function (m) {
        rhtml += '<div class="list-item" data-search-song="' + m.id + '">'
          + '<div class="list-item-text">'
          + '<div class="list-item-title">' + esc(m.title) + '</div>'
          + '<div class="list-item-subtitle">' + esc(m.artist) + '</div>'
          + '</div>';
        if (m.hasTrack) rhtml += '<span class="track-icon">&#128264;</span>';
        rhtml += '<span class="list-item-arrow">&#8250;</span></div>';
      });
      searchResultsEl.innerHTML = rhtml;
      searchResultsEl.classList.remove('hidden');

      // Scroll results to bottom so best match is nearest the search bar
      searchResultsEl.scrollTop = searchResultsEl.scrollHeight;

      searchResultsEl.querySelectorAll('[data-search-song]').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.getAttribute('data-search-song');
          var allSorted = Object.keys(data.songs).sort(function (a, b) {
            return data.songs[a].title.localeCompare(data.songs[b].title);
          });
          currentSetlist = { id: '__all__', name: 'All Songs', songs: allSorted };
          showLyrics(id);
        });
      });

    }
  }

  // ── Navigation ──
  function goBack() {
    if (currentView === 'lyrics') {
      main.classList.remove('lyrics-mode');
      // Pass the song we were viewing so the list scrolls back to it
      showSongList(currentSetlist, currentSong);
    } else if (currentView === 'songs') {
      showSetlists();
    }
  }

  function setHeader(title, showBack, showNext) {
    headerTitle.textContent = title;
    backBtn.classList.toggle('hidden', !showBack);
    nextBtn.classList.toggle('hidden', !showNext);
  }

  // ── View: Setlists ──
  function showSetlists() {
    currentView = 'setlists';
    currentSetlist = null;
    currentSong = null;
    setHeader('Gigalator', false);
    showPlayerIfPlaying();

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

    // Refresh button
    html += '<div class="refresh-bar">'
      + '<button class="refresh-btn" id="refresh-btn">&#8635; Refresh Songs</button>'
      + '</div>';

    // Sydney timestamp
    var now = new Date();
    var sydneyTime = now.toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    html += '<div class="timestamp">Last loaded: ' + sydneyTime + '</div>';

    main.innerHTML = html;
    main.scrollTop = 0;

    // Show search bar and configure for setlists view
    showSearch('Search songs...');

    main.querySelectorAll('[data-setlist]').forEach(function (el) {
      el.addEventListener('click', function () {
        const id = el.getAttribute('data-setlist');
        if (id === '__all__') {
          var allSorted = Object.keys(data.songs).sort(function (a, b) {
            return data.songs[a].title.localeCompare(data.songs[b].title);
          });
          showSongList({ id: '__all__', name: 'All Songs', songs: allSorted });
        } else {
          const setlist = data.setlists.find(function (s) { return s.id === id; });
          if (setlist) showSongList(setlist);
        }
      });
    });

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', refreshSongs);
  }

  // ── Refresh Songs ──
  async function refreshSongs() {
    var btn = document.getElementById('refresh-btn');
    if (!btn) return;
    btn.classList.add('refreshing');
    btn.innerHTML = '&#8635; Refreshing...';

    try {
      // Bypass service worker cache with cache-busting query param
      var resp = await fetch('songs/songs.json?_t=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      data = await resp.json();

      btn.classList.remove('refreshing');
      btn.classList.add('success');
      btn.innerHTML = '&#10003; Updated!';

      // Re-render the setlists view with the new data
      setTimeout(function () {
        showSetlists();
      }, 800);
    } catch (e) {
      btn.classList.remove('refreshing');
      btn.innerHTML = '&#10007; Failed — tap to retry';
      btn.style.borderColor = '#e05050';
      btn.style.color = '#e05050';
      console.warn('Refresh failed:', e);
    }
  }

  // ── View: Song List ──
  function showSongList(setlist, scrollToSongId) {
    currentView = 'songs';
    currentSetlist = setlist;
    currentSong = null;
    setHeader(setlist.name, true);
    showPlayerIfPlaying();

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

    html += '<div id="songlist-items">';
    setlist.songs.forEach(function (songId) {
      const song = data.songs[songId];
      if (!song) return;

      html += '<div class="list-item" data-song="' + songId + '">'
        + '<div class="list-item-text">'
        + '<div class="list-item-title">' + esc(song.title) + '</div>'
        + '<div class="list-item-subtitle">' + esc(song.artist) + '</div>'
        + '</div>';

      if (song.track) {
        html += '<span class="track-icon">&#128264;</span>';
      }

      html += '<span class="list-item-arrow">&#8250;</span></div>';
    });
    html += '</div>';

    main.innerHTML = html;
    main.scrollTop = 0;

    // If a specific song was requested (coming back from lyrics),
    // scroll it into view and give it a brief highlight
    if (scrollToSongId) {
      var target = main.querySelector('[data-song="' + scrollToSongId + '"]');
      if (target) {
        // block: 'center' keeps the song roughly in the middle of the view
        target.scrollIntoView({ block: 'center' });
        target.classList.add('just-viewed');
        setTimeout(function () {
          if (target) target.classList.remove('just-viewed');
        }, 1500);
      }
    }

    // Show search bar for this song list
    showSearch('Search in ' + setlist.name + '...');

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
  var DEFAULT_FONT_SIZE = 20;
  var MIN_FONT_SIZE = 10;
  var MAX_FONT_SIZE = 36;

  // ── Per-song preferences (iPad-local, survives restarts) ──
  // Stored in localStorage as a { songId: { fontSize: N } } map.
  // These override values in songs.json but don't sync back to the Manager.
  var PREFS_KEY = 'gigalator-song-prefs';

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function savePref(songId, key, value) {
    var prefs = loadPrefs();
    prefs[songId] = prefs[songId] || {};
    prefs[songId][key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn('Could not save preference:', e);
    }
  }

  function getPref(songId, key) {
    var prefs = loadPrefs();
    return prefs[songId] ? prefs[songId][key] : undefined;
  }

  function showLyrics(songId) {
    currentView = 'lyrics';
    currentSong = songId;
    var song = data.songs[songId];
    if (!song) return;

    // Show next button if there's a next song in the setlist
    var hasNext = false;
    if (currentSetlist && currentSetlist.songs) {
      var idx = currentSetlist.songs.indexOf(songId);
      hasNext = idx !== -1 && idx < currentSetlist.songs.length - 1;
    }
    setHeader(song.title, true, hasNext);

    // Priority: iPad-local override (from pinching/adjusting on the iPad)
    //         → songs.json fontSize → default 30px
    var localSize = getPref(songId, 'fontSize');
    currentFontSize = localSize || song.fontSize || DEFAULT_FONT_SIZE;

    main.classList.add('lyrics-mode');
    hideSearch();

    var hasSheets = song.sheets && song.sheets.some(function (s) { return !!s; });

    var html = '<div class="lyrics-wrap">'
      + '<div class="lyrics-top-bar">'
      + '<div class="lyrics-artist">' + esc(song.artist) + '</div>'
      + '<div class="lyrics-top-right">';

    // Lyrics/Sheets toggle if song has sheet images
    if (hasSheets) {
      html += '<div class="view-toggle" id="view-toggle">'
        + '<button class="view-toggle-btn active" id="toggle-lyrics">Lyrics</button>'
        + '<button class="view-toggle-btn" id="toggle-sheets">Sheets</button>'
        + '</div>';
    }

    html += '<div class="font-size-controls">'
      + '<button class="font-size-btn" id="font-dec">&#8722;</button>'
      + '<span class="font-size-label" id="font-label">' + currentFontSize + 'px</span>'
      + '<button class="font-size-btn" id="font-inc">&#43;</button>'
      + '</div>'
      + '</div>'
      + '</div>'
      + '<div class="lyrics-scroll" id="lyrics-scroll">'
      + '<div class="lyrics" id="lyrics-text">' + renderLyrics(song.lyrics) + '</div>'
      + '</div>';

    // Sheets view (hidden by default)
    if (hasSheets) {
      html += '<div class="sheets-scroll hidden" id="sheets-scroll">';
      song.sheets.forEach(function (sheetPath, si) {
        if (sheetPath) {
          html += '<img class="sheet-page-img" src="' + sheetPath + '" alt="Page ' + (si + 1) + '">';
        }
      });
      html += '</div>';
    }

    html += '<div class="lyrics-page-bar">'
      + '<div class="lyrics-page-dot active" id="page-dot-0"></div>'
      + '<div class="lyrics-page-dot" id="page-dot-1"></div>'
      + '<span class="lyrics-page-hint" id="page-hint">Swipe for more &#8250;</span>'
      + '</div>';

    // Bottom navigation bar — Back / Setlists / Next
    html += '<div class="bottom-nav">'
      + '<button class="bottom-nav-btn" id="bottom-back-btn">'
      + '<span class="bottom-nav-icon">&#8249;</span>'
      + '<span class="bottom-nav-label">Back</span>'
      + '</button>'
      + '<button class="bottom-nav-btn" id="bottom-setlists-btn">'
      + '<span class="bottom-nav-icon">&#9776;</span>'
      + '<span class="bottom-nav-label">Setlists</span>'
      + '</button>';

    if (hasNext) {
      var nextIdx = currentSetlist.songs.indexOf(songId) + 1;
      var nextSongData = data.songs[currentSetlist.songs[nextIdx]];
      var nextTitle = nextSongData ? nextSongData.title : '';
      html += '<button class="bottom-nav-btn bottom-nav-next" id="bottom-next-btn">'
        + '<span class="bottom-nav-next-stack">'
        + '<span class="bottom-nav-next-up">Up next</span>'
        + '<span class="bottom-nav-next-title">' + esc(nextTitle) + '</span>'
        + '</span>'
        + '<span class="bottom-nav-icon">&#8250;</span>'
        + '</button>';
    } else {
      html += '<button class="bottom-nav-btn bottom-nav-next disabled" disabled>'
        + '<span class="bottom-nav-label">End of setlist</span>'
        + '</button>';
    }

    html += '</div>';

    html += '</div>';

    main.innerHTML = html;

    var lyricsEl = document.getElementById('lyrics-text');
    var scrollEl = document.getElementById('lyrics-scroll');
    lyricsEl.style.fontSize = currentFontSize + 'px';

    document.getElementById('font-dec').addEventListener('click', function () {
      adjustFontSize(-1, lyricsEl);
    });
    document.getElementById('font-inc').addEventListener('click', function () {
      adjustFontSize(1, lyricsEl);
    });

    // Page dots + page snap on scroll-end.
    // Why JS not CSS: CSS scroll-snap with multi-column content only allows
    // one snap target (the .lyrics element itself), so it can't snap to
    // the half-way page break. We debounce the scroll event and animate
    // to the nearer page boundary once the user stops scrolling.
    var snapTimer = null;
    scrollEl.addEventListener('scroll', function () {
      var maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      if (maxScroll <= 0) return;
      var scrollPct = scrollEl.scrollLeft / maxScroll;
      var onPage2 = scrollPct > 0.3;
      document.getElementById('page-dot-0').classList.toggle('active', !onPage2);
      document.getElementById('page-dot-1').classList.toggle('active', onPage2);
      var hint = document.getElementById('page-hint');
      if (onPage2) {
        hint.innerHTML = '&#8249; Swipe back';
      } else {
        hint.innerHTML = 'Swipe for more &#8250;';
      }

      // Skip snap entirely in portrait — that view is a single column.
      if (window.matchMedia('(orientation: portrait)').matches) return;

      // Debounced snap: 140ms after the last scroll event, animate to
      // the nearest page boundary (0 or maxScroll). 140ms gives iOS
      // momentum-scroll time to come to rest before we step in.
      clearTimeout(snapTimer);
      snapTimer = setTimeout(function () {
        var targetLeft = scrollPct > 0.5 ? maxScroll : 0;
        if (Math.abs(scrollEl.scrollLeft - targetLeft) > 4) {
          scrollEl.scrollTo({ left: targetLeft, behavior: 'smooth' });
        }
      }, 140);
    });

    // Lyrics/Sheets toggle
    var toggleLyricsBtn = document.getElementById('toggle-lyrics');
    var toggleSheetsBtn = document.getElementById('toggle-sheets');
    if (toggleLyricsBtn && toggleSheetsBtn) {
      var sheetsScrollEl = document.getElementById('sheets-scroll');
      toggleLyricsBtn.addEventListener('click', function () {
        scrollEl.classList.remove('hidden');
        sheetsScrollEl.classList.add('hidden');
        toggleLyricsBtn.classList.add('active');
        toggleSheetsBtn.classList.remove('active');
        document.querySelector('.lyrics-page-bar').classList.remove('hidden');
      });
      toggleSheetsBtn.addEventListener('click', function () {
        scrollEl.classList.add('hidden');
        sheetsScrollEl.classList.remove('hidden');
        toggleSheetsBtn.classList.add('active');
        toggleLyricsBtn.classList.remove('active');
        document.querySelector('.lyrics-page-bar').classList.add('hidden');
      });
    }

    // Bottom nav buttons
    document.getElementById('bottom-back-btn').addEventListener('click', function () {
      main.classList.remove('lyrics-mode');
      // Pass the current song so the list scrolls back to it
      showSongList(currentSetlist, currentSong);
    });
    document.getElementById('bottom-setlists-btn').addEventListener('click', function () {
      main.classList.remove('lyrics-mode');
      showSetlists();
    });
    var bottomNextBtn = document.getElementById('bottom-next-btn');
    if (bottomNextBtn) {
      bottomNextBtn.addEventListener('click', playNextSong);
    }

    // Audio: do NOT touch what's already loaded/playing.
    // Whatever song is playing keeps playing until the user explicitly hits
    // play on a different song's lyrics view.
    if (playingSongId && audio.src) {
      // Something is loaded — keep player bar visible, update label so
      // the user can see what's actually playing if it's not this song.
      player.classList.remove('hidden');
      updateTrackLabel();
    } else if (song.track) {
      // Nothing loaded yet — show the player bar in a "ready to play
      // this song" state, but don't start playback.
      player.classList.remove('hidden');
    } else {
      // No loaded audio AND no track for this song
      player.classList.add('hidden');
    }
  }

  function adjustFontSize(delta, lyricsEl) {
    currentFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, currentFontSize + delta));
    lyricsEl.style.fontSize = currentFontSize + 'px';
    document.getElementById('font-label').textContent = currentFontSize + 'px';
    // Persist the new size for this song — survives refresh, app updates, etc.
    if (currentSong) savePref(currentSong, 'fontSize', currentFontSize);
  }

  // ── Audio Controls ──
  function togglePlay() {
    var viewedSong = currentSong ? data.songs[currentSong] : null;

    // If the user is on a song's lyrics view AND that song has a track AND
    // it's NOT the loaded one, switch to it and play. This is "I'm choosing
    // another song to play."
    if (viewedSong && viewedSong.track && currentSong !== playingSongId) {
      audio.pause();
      // Cache-bust to force the audio element to drop any prior failed load
      // for this URL and re-fetch through the SW (which now self-heals
      // zero-byte entries).
      audio.src = viewedSong.track + '?t=' + Date.now();
      audio.load();
      playingSongId = currentSong;
      progressBar.style.width = '0%';
      timeDisplay.textContent = '0:00';
      timeRemaining.textContent = '-0:00';
      audio.play().catch(function (err) {
        console.warn('Play failed:', err);
      });
      playBtn.innerHTML = '&#9646;&#9646;';
      updateTrackLabel();
      player.classList.remove('hidden');
      return;
    }

    // Otherwise toggle whatever's loaded
    if (audio.paused) {
      audio.play().catch(function () {
        // Autoplay blocked — user needs to tap again
      });
      playBtn.innerHTML = '&#9646;&#9646;';
      // Show track label so you know what's playing when browsing
      updateTrackLabel();
    } else {
      audio.pause();
      playBtn.innerHTML = '&#9654;';
    }
  }

  function stopAudio() {
    audio.pause();
    audio.src = '';
    playingSongId = null;
    playBtn.innerHTML = '&#9654;';
    progressBar.style.width = '0%';
    timeDisplay.textContent = '0:00';
    timeRemaining.textContent = '-0:00';
    trackLabel.textContent = '';
    trackLabel.classList.add('hidden');
    player.classList.add('hidden');
  }

  // Show player bar if audio is currently active (playing or paused with a loaded track)
  function showPlayerIfPlaying() {
    if (playingSongId && audio.src && !audio.ended) {
      player.classList.remove('hidden');
      updateTrackLabel();
    } else {
      player.classList.add('hidden');
    }
  }

  // Show/hide the "Now playing: ..." label — visible when not on the playing song's lyrics
  function updateTrackLabel() {
    if (!playingSongId || !data.songs[playingSongId]) {
      trackLabel.textContent = '';
      trackLabel.classList.add('hidden');
      return;
    }
    // Show label when browsing away from the playing song
    if (currentView !== 'lyrics' || currentSong !== playingSongId) {
      trackLabel.textContent = data.songs[playingSongId].title;
      trackLabel.classList.remove('hidden');
    } else {
      trackLabel.textContent = '';
      trackLabel.classList.add('hidden');
    }
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
    var remaining = Math.max(0, audio.duration - audio.currentTime);
    timeRemaining.textContent = '-' + formatTime(remaining);
  }

  function onTrackEnd() {
    playingSongId = null;
    playBtn.innerHTML = '&#9654;';
    progressBar.style.width = '100%';
    trackLabel.textContent = '';
    trackLabel.classList.add('hidden');
    // Hide player if we've navigated away from the lyrics view
    if (currentView !== 'lyrics') {
      player.classList.add('hidden');
    }
  }

  // ── Next Song ──
  // Navigates to the next song's lyrics WITHOUT touching the audio.
  // Whatever is currently playing keeps playing. The user must explicitly
  // tap Play (or Play on the new lyrics screen) to start a new track.
  function playNextSong() {
    if (!currentSetlist || !currentSetlist.songs) return;
    var songList = currentSetlist.songs;
    var activeSong = currentSong || playingSongId;
    if (!activeSong) return;

    var idx = songList.indexOf(activeSong);
    if (idx === -1 || idx >= songList.length - 1) return; // already at end

    var nextId = songList[idx + 1];
    var nextSong = data.songs[nextId];
    if (!nextSong) return;

    // Just switch the lyrics view — leave audio alone.
    showLyrics(nextId);
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
    btn.classList.remove('cached');
    btn.classList.remove('cache-partial');
    let cached = 0;
    let failed = 0;
    let quotaHit = false;
    const failures = [];

    const before = await getStorageInfo();
    if (before) console.log('Storage before caching:', before);

    try {
      const cache = await caches.open('gigalator-tracks-v1');

      for (const song of trackSongs) {
        try {
          const existing = await cache.match(song.track);

          // Treat a cached entry as VALID only if it actually has content.
          // Earlier we shipped some zero-byte MP3s by accident, and the SW
          // happily cached them. Without this check, the broken entries
          // are sticky forever because cache.match() returns a (zero-byte)
          // response and we skip the re-fetch.
          let isValid = false;
          if (existing) {
            const buf = await existing.clone().arrayBuffer();
            isValid = buf.byteLength > 0;
          }

          if (!isValid) {
            // Delete any broken/missing entry, then re-fetch fresh
            if (existing) await cache.delete(song.track);
            await cache.add(song.track);
          }

          // Verify the entry now exists AND has bytes
          const verify = await cache.match(song.track);
          if (!verify) throw new Error('Cache put did not persist');
          const verifyBuf = await verify.clone().arrayBuffer();
          if (verifyBuf.byteLength === 0) throw new Error('Cached entry is zero bytes');

          cached++;
        } catch (e) {
          console.warn('Failed to cache:', song.track, e);
          failed++;
          failures.push(song.title);
          // iOS/Safari throws QuotaExceededError when origin quota is hit
          if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
            quotaHit = true;
          }
        }
        btn.textContent = 'Caching ' + (cached + failed) + '/' + trackSongs.length;
      }

      const after = await getStorageInfo();
      if (after) console.log('Storage after caching:', after);

      if (failed === 0) {
        btn.textContent = 'Cached' + (after ? ' (' + after.usageMB + 'MB)' : '');
        btn.classList.add('cached');
      } else {
        btn.textContent = failed + ' failed — tap to retry';
        btn.classList.add('cache-partial');

        let msg = failed + ' of ' + trackSongs.length + ' tracks failed to cache.\n\n';
        if (after) {
          msg += 'Storage: ' + after.usageMB + ' MB used of ' + after.quotaMB + ' MB available'
               + (after.persisted ? ' (persistent)' : ' (NOT persistent — iOS may be limiting us)')
               + '.\n\n';
        }
        if (quotaHit) {
          msg += 'iOS cache quota hit. Your device has lots of free space but Safari caps '
               + 'the per-app cache. This usually lifts once persistent storage is granted '
               + '— try closing and reopening the app, then tap Cache Tracks again.\n\n';
        }
        msg += 'Failed tracks:\n' + failures.slice(0, 8).join('\n')
             + (failures.length > 8 ? '\n...and ' + (failures.length - 8) + ' more' : '');
        alert(msg);
      }
    } catch (e) {
      btn.textContent = 'Cache failed';
      console.error('Cache setup failed:', e);
    }

    btn.disabled = false;
  }

  // ── Helpers ──
  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Render lyrics with inline markdown-lite formatting.
  // Escapes HTML first (safe), then turns markers into tags.
  // Order matters: ** before *, ==highlight== before anything, __underline__ before single _.
  // All patterns allow the wrapped content to span newlines so multi-line
  // bold/highlight blocks render correctly.
  function renderLyrics(str) {
    var html = esc(str || '');
    // ==highlight==
    html = html.replace(/==([\s\S]+?)==/g, '<mark>$1</mark>');
    // **bold**
    html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    // __underline__
    html = html.replace(/__([\s\S]+?)__/g, '<u>$1</u>');
    // *italic*
    html = html.replace(/\*([\s\S]+?)\*/g, '<em>$1</em>');
    return html;
  }

  // ── Start ──
  document.addEventListener('DOMContentLoaded', init);
})();
