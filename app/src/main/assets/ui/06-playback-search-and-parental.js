async function loadMltPage(first) {
  if (mltPageState.busy) return;
  mltPageState.busy = true;
  const grid = document.getElementById('filterResultsGrid');
  try {
    const res = await fetch(`/api/related?dedupKey=${encodeURIComponent(mltPageState.key)}&offset=${mltPageState.offset}&limit=24&matchMode=${currentMltMode}&hideWatched=${currentMltHideWatched}`);
    const data = await res.json();
    const items = data.items || [];
    if (!grid) return;
    const old = grid.querySelector('.mlt-more-card');
    const hadFocusOnMore = old && document.activeElement === old;
    if (old) old.remove();
    const before = grid.querySelectorAll('.poster-card').length;
    grid.insertAdjacentHTML('beforeend', items.map((m) => renderPosterCard(m)).join(''));
    mltPageState.offset += items.length;
    mltPageState.hasMore = Boolean(data.hasMore);
    if (mltPageState.hasMore) {
      grid.insertAdjacentHTML('beforeend', `
        <div tabindex="0" class="poster-card mlt-more-card tv-focusable" onfocus="playNavSound()" onclick="loadMltPage(false)">
          <div class="poster-img-wrap" style="display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(145deg, rgba(var(--theme-deep-rgb),0.36) 0%, var(--card) 100%);border:1px solid rgba(var(--theme-border-rgb),0.35);border-radius:10px;">
            <div style="font-size:14px;font-weight:900;color:#FFFFFF;">Show more</div>
          </div>
        </div>`);
    }
    if (first && items.length === 0) {
      grid.outerHTML = '<div style="padding:40px;color:var(--muted);text-align:center;">No close matches found for this title.</div>';
      return;
    }
    // after loading more, put the remote on the first NEW title so the user can keep going from there
    if (!first && hadFocusOnMore) {
      const cards = grid.querySelectorAll('.poster-card:not(.mlt-more-card)');
      const target = cards[before];
      if (target) target.focus();
    } else if (first) {
      setTimeout(() => { const c = document.querySelector('#filterResultsGrid .poster-card'); if (c) c.focus(); }, 120);
    }
  } catch (_) {
    showToast('Could not load more titles. Please try again.');
  } finally {
    mltPageState.busy = false;
  }
}

async function playHeroMovie(dedupKey) {
  playNavSound();
  await startMoviePlayback(dedupKey, 0, 0);
}

// The TV engine builds the playable address (the IPTV password never reaches this screen).
// Returns the address, or '' after showing a clear message when it cannot be built.
async function resolveStreamUrl(kind, id, ext, announce, dedupKey = '') {
  let reply = null;
  try {
    const res = await fetch('/api/stream-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind, id: String(id == null ? '' : id), ext: ext || '', dedupKey: dedupKey || '' })
    });
    reply = await res.json();
  } catch (_) {}
  if (reply && reply.ok && reply.url) return reply.url;
  if (announce) {
    showToast((reply && reply.message) || 'Could not start playback. Please check your internet and try again.');
  }
  return '';
}

// 7. HIGH-PRECISION CUSTOM NETFLIX VIDEO PLAYER & EXOPLAYER BRIDGE
async function startMoviePlayback(dedupKey, verIdx = 0, startOffsetMs = 0, episodeId = null) {
  let item = selectedDetailItem;
  if (!item || item.dedupKey !== dedupKey) {
    try {
      const res = await fetch(`/api/detail?dedupKey=${encodeURIComponent(dedupKey)}`);
      const data = await res.json();
      if (data && data.item) {
        selectedDetailItem = data.item;
        item = data.item;
      }
    } catch (_) {}
  }
  if (!item) { showToast('Could not load this title. Please try again.'); return; }

  const ver = (item.versions || [])[verIdx] || { streamId: item.primaryStreamId, containerExtension: 'mp4' };
  // Check if background preview video was already playing
  const pVideo = document.getElementById('detailPreviewVideo');
  if (pVideo) pVideo.pause();

  const typePart = item.mediaType === 'SERIES' ? 'series' : 'movie';
  let streamId = ver.streamId;
  let ext = ver.containerExtension || 'mkv';
  let streamTitle = item.cleanTitle;

  if (item.mediaType === 'SERIES') {
    let ep = null;
    if (episodeId && item.episodes) {
      ep = item.episodes.find(e => String(e.id) === String(episodeId));
    }
    if (!ep && item.episodes && item.episodes.length > 0) {
      ep = item.episodes[0];
    }
    if (ep) {
      streamId = ep.id;
      ext = ep.containerExtension || 'mkv';
      streamTitle = `${item.cleanTitle} - S${ep.season} E${ep.episodeNum}: ${ep.title || 'Episode ' + ep.episodeNum}`;
    } else if (item.firstEpisodeStreamId) {
      streamId = item.firstEpisodeStreamId;
      ext = item.firstEpisodeExtension || 'mkv';
    }
  }

  const directUrl = await resolveStreamUrl(typePart, streamId, ext, true, item.dedupKey);
  if (!directUrl) return;
  const movieDurationMs = (item.runtimeMins && item.runtimeMins > 0) ? (item.runtimeMins * 60 * 1000) : (item.durationMs > 0 ? item.durationMs : 0);

  const seekMs = startOffsetMs > 0 ? startOffsetMs : (item.resumePositionMs > 30000 ? item.resumePositionMs : 0);

  // If running inside Android TV Native Shell (ExoPlayer with hardware acceleration)
  if (window.AndroidApp && typeof window.AndroidApp.playStream === 'function') {
    window.AndroidApp.playStream(directUrl, streamTitle, seekMs, item.dedupKey, movieDurationMs, ext || 'mkv');
    return;
  }

  // Fallback to PC Simulator / Web Player
  launchPlayer(directUrl, streamTitle, seekMs / 1000, movieDurationMs / 1000);
}

// Channel +/- on the remote while a live channel plays: the list the person picked from decides what "next" is
let liveZapList = [];
let liveZapCurrentId = null;
window.zapLiveChannel = async function(dir) {
  if (!Array.isArray(liveZapList) || liveZapList.length < 2 || liveZapCurrentId == null) return;
  const i = liveZapList.findIndex(c => String(c.streamId) === String(liveZapCurrentId));
  if (i < 0) return;
  const next = liveZapList[(i + dir + liveZapList.length) % liveZapList.length];
  if (next) await startLivePlayback(next.streamId, next.name);
};

async function startLivePlayback(streamId, chName) {
  liveZapCurrentId = streamId;
  const directUrl = await resolveStreamUrl('live', streamId, 'm3u8', true);
  if (!directUrl) return;

  if (window.AndroidApp && typeof window.AndroidApp.playStream === 'function') {
    window.AndroidApp.playStream(directUrl, chName, 0, 'live:' + streamId, 0, 'm3u8');
    return;
  }
  launchPlayer(directUrl, chName, 0);
}

// Watch Progress Recording & Bridge Callback from Android ExoPlayer
window.onPlaybackExited = async function(dedupKey, posMs, durMs) {
  recordPlaybackProgress(dedupKey, posMs, durMs);
  if (selectedDetailItem && selectedDetailItem.dedupKey === dedupKey) {
    selectedDetailItem.resumePositionMs = posMs;
    if (durMs > 0) selectedDetailItem.durationMs = durMs;
    const btnContainer = document.getElementById('detailActionButtonsContainer');
    if (btnContainer) {
      btnContainer.outerHTML = getDetailActionButtonsHtml(selectedDetailItem);
    }
  }
  setTimeout(() => {
    const focusTarget = document.querySelector('#detailActionButtonsContainer .btn-primary, #detailActionButtonsContainer button, .hero-actions .btn-primary, .nav-btn.active, .poster-card');
    if (focusTarget) {
      focusTarget.focus();
      playNavSound();
    }
  }, 120);
};

async function recordPlaybackProgress(dedupKey, posMs, durMs) {
  if (!dedupKey || posMs === undefined) return;
  try {
    await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKey, positionMs: posMs, durationMs: durMs })
    });
    if (typeof ProfileSyncManager !== 'undefined') {
      ProfileSyncManager.recordChange('progress', dedupKey, {
        resumePositionMs: posMs,
        durationMs: durMs,
        isWatched: (durMs > 60000 && (posMs / durMs) >= 0.9)
      });
    }
  } catch (_) {}

  // Update in-memory item
  if (selectedDetailItem && selectedDetailItem.dedupKey === dedupKey) {
    selectedDetailItem.resumePositionMs = posMs;
    selectedDetailItem.durationMs = durMs;
    if (durMs > 0 && (posMs / durMs) >= 0.90) {
      selectedDetailItem.isWatched = true;
    }
    const container = document.getElementById('detailActionButtonsContainer');
    if (container) {
      container.outerHTML = getDetailActionButtonsHtml(selectedDetailItem);
    }
  }
}

let playerIndicatorTimeout = null;
function flashPlayerIndicator(text) {
  const el = document.getElementById('playerCenterIndicator');
  if (!el) return;
  el.innerText = text;
  el.classList.add('show');
  if (playerIndicatorTimeout) clearTimeout(playerIndicatorTimeout);
  playerIndicatorTimeout = setTimeout(() => {
    el.classList.remove('show');
  }, 750);
}

let activePlayerDurationSec = 0;

function launchPlayer(rawStreamUrl, title, startTime = 0, fallbackDurationSec = 0) {
  const pOv = document.getElementById('playerOverlay');
  pOv.style.display = 'flex';
  const proxyUrl = `/api/stream-proxy?url=${encodeURIComponent(rawStreamUrl)}`;
  activePlayerDurationSec = fallbackDurationSec > 0 ? fallbackDurationSec : 0;

  // Industry-Standard Netflix OSD: No top close button, bottom shows ONLY time bar scrubber
  pOv.innerHTML = `
    <video id="tvVideo" class="main-player-video" autoplay playsinline src="${proxyUrl}"></video>
    <div id="playerCenterIndicator" class="player-center-indicator"></div>
    <div class="player-osd-container" id="playerOsd" onmousemove="resetOsdTimer()">
      <div class="player-osd-top">
        <div class="player-title-text">${escapeHtml(title)}</div>
      </div>
      <div class="player-osd-bottom">
        <div class="timeline-bar-wrapper">
          <span id="playerCurrentTime">00:00:00</span>
          <input type="range" id="playerTimelineSlider" class="timeline-slider" min="0" max="100" value="0"
                 oninput="onTimelineSeek(this.value)" />
          <span id="playerDuration">${formatTime(activePlayerDurationSec)}</span>
        </div>
      </div>
    </div>
  `;

  const video = document.getElementById('tvVideo');
  if (startTime > 0) video.currentTime = startTime;

  video.ontimeupdate = updatePlayerTimeline;
  video.onloadedmetadata = () => {
    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      activePlayerDurationSec = video.duration;
    }
    document.getElementById('playerDuration').innerText = formatTime(activePlayerDurationSec);
  };
  video.onerror = () => {
    const err = video.error ? `${video.error.code}` : 'Network error';
    flashPlayerIndicator('Stream format error ' + err);
  };

  const pPromise = video.play();
  if (pPromise !== undefined) {
    pPromise.catch((e) => {
      console.warn('Browser autoplay prevented, click to unmute/start:', e);
      flashPlayerIndicator('Click OK to Play');
    });
  }

  resetOsdTimer();
}

function formatTime(sec) {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '00:00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updatePlayerTimeline() {
  const v = document.getElementById('tvVideo');
  const slider = document.getElementById('playerTimelineSlider');
  const cur = document.getElementById('playerCurrentTime');
  if (!v || !slider) return;
  const dur = (v.duration && isFinite(v.duration) && v.duration > 0) ? v.duration : activePlayerDurationSec;
  if (dur > 0) {
    slider.value = (v.currentTime / dur) * 100;
    if (cur) cur.innerText = formatTime(v.currentTime);
    const durEl = document.getElementById('playerDuration');
    if (durEl) durEl.innerText = formatTime(dur);
  }
}

function onTimelineSeek(percent) {
  const v = document.getElementById('tvVideo');
  const dur = (v && v.duration && isFinite(v.duration) && v.duration > 0) ? v.duration : activePlayerDurationSec;
  if (v && dur > 0) {
    v.currentTime = (percent / 100) * dur;
  }
  resetOsdTimer();
}

function togglePlayPause() {
  const v = document.getElementById('tvVideo');
  if (!v) return;
  if (v.paused) {
    v.play();
    flashPlayerIndicator('▶ Play');
  } else {
    v.pause();
    flashPlayerIndicator('❚❚ Pause');
  }
  resetOsdTimer();
}

function seekDelta(seconds) {
  const v = document.getElementById('tvVideo');
  if (!v) return;
  v.currentTime = Math.max(0, Math.min(v.duration || 999999, v.currentTime + seconds));
  flashPlayerIndicator(seconds > 0 ? '⟳ 10s' : '⟲ 10s');
  resetOsdTimer();
}

function resetOsdTimer() {
  const osd = document.getElementById('playerOsd');
  if (!osd) return;
  osd.style.opacity = '1';
  if (osdHideTimeout) clearTimeout(osdHideTimeout);
  osdHideTimeout = setTimeout(() => {
    const v = document.getElementById('tvVideo');
    if (v && !v.paused) {
      osd.style.opacity = '0';
    }
  }, 3500);
}

function exitPlayer() {
  const v = document.getElementById('tvVideo');
  if (v) {
    const curTimeMs = Math.floor(v.currentTime * 1000);
    const durMs = Math.floor((v.duration || 0) * 1000);
    if (selectedDetailItem && curTimeMs > 0) {
      recordPlaybackProgress(selectedDetailItem.dedupKey, curTimeMs, durMs);
      selectedDetailItem.resumePositionMs = curTimeMs;
      if (durMs > 0) selectedDetailItem.durationMs = durMs;
      const btnContainer = document.getElementById('detailActionButtonsContainer');
      if (btnContainer) {
        btnContainer.outerHTML = getDetailActionButtonsHtml(selectedDetailItem);
      }
    }
    v.pause();
    v.src = '';
  }
  document.getElementById('playerOverlay').style.display = 'none';
  document.getElementById('playerOverlay').innerHTML = '';
  setTimeout(() => {
    const focusTarget = document.querySelector('#detailActionButtonsContainer .btn-primary, #detailActionButtonsContainer button, .hero-actions .btn-primary, .nav-btn.active, .poster-card');
    if (focusTarget) {
      focusTarget.focus();
      playNavSound();
    }
  }, 100);
}

// 7.5. SEARCH HISTORY & SUGGESTIONS ENGINE (YouTube TV Style)
let cachedSearchHistory = [];
let pendingDeleteHistoryQuery = null;
let historyLongPressTimer = null;
let historyLongPressTriggered = false;

async function fetchSearchHistory() {
  try {
    const res = await fetch('/api/search-history');
    const d = await res.json();
    cachedSearchHistory = d.history || [];
    return cachedSearchHistory;
  } catch (e) {
    return cachedSearchHistory;
  }
}

async function saveSearchQuery(q) {
  if (currentTab === 'VAULT_18' || currentTab === 'EXTRAS') return; // Strictly never record adult / extras search queries!
  const query = (q || '').trim();
  if (!query || query.length < 2) return;
  try {
    await fetch('/api/search-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, isVault: currentTab === 'VAULT_18' || currentTab === 'EXTRAS' })
    });
    cachedSearchHistory = [query, ...cachedSearchHistory.filter(h => h.toLowerCase() !== query.toLowerCase())].slice(0, 20);
  } catch (e) {}
}

let isSearchTypingSession = false;

function dismissSuggestions() {
  isSearchTypingSession = false;
  const container = document.getElementById('searchSuggestionsContainer');
  if (container) {
    container.style.display = 'none';
    container.innerHTML = '';
  }
}

function onSearchInputClicked(inp) {
  inp.removeAttribute('readonly');
  inp.focus();
  isSearchTypingSession = true;
  renderSearchSuggestions(inp.value);
}

function onSearchFilterBlur(inp) {
  inp.setAttribute('readonly', 'true');
  setTimeout(() => {
    if (!document.activeElement || !document.activeElement.classList.contains('search-suggestion-item')) {
      dismissSuggestions();
    }
  }, 250);
}

function onSearchInputKeyDown(inp, e) {
  if (e.key === 'Enter' || e.keyCode === 13) {
    inp.setAttribute('readonly', 'true');
    dismissSuggestions();
    const q = inp.value;
    if (q && q.trim().length >= 2) {
      saveSearchQuery(q);
    }
    executeFilterQuery();
  }
}

async function renderSearchSuggestions(query = '', autoChips = []) {
  const container = document.getElementById('searchSuggestionsContainer');
  if (!container) return;

  if (!isSearchTypingSession) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  if (cachedSearchHistory.length === 0) {
    await fetchSearchHistory();
  }

  const qTrim = (query || '').trim().toLowerCase();
  const searchInput = document.getElementById('filterSearchInput');

  // If query is empty, show up to 5 recent searches
  if (!qTrim) {
    if (cachedSearchHistory.length === 0) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    const recentItems = cachedSearchHistory.slice(0, 5);
    container.style.display = 'block';
    container.innerHTML = `
      <div class="search-suggestions-header">
        <span>Recent Searches</span>
      </div>
      <div class="search-suggestions-list" id="searchSuggestionsList">
        ${recentItems.map(item => `
          <div tabindex="0" class="search-suggestion-item is-history tv-focusable" data-query="${escapeHtml(item)}" onfocus="playNavSound()">
            <div class="suggestion-left">
              <span class="suggestion-icon" style="color:var(--theme-border);">🕒</span>
              <span>${escapeHtml(item)}</span>
            </div>
            <span class="suggestion-hint">Hold OK to remove</span>
          </div>
        `).join('')}
      </div>
    `;
    return;
  }

  // When query is non-empty: matching history first, then catalog suggestions (max 5 total)
  const matchingHistory = cachedSearchHistory.filter(h => h.toLowerCase().includes(qTrim) && h.toLowerCase() !== qTrim).slice(0, 2);
  const cleanChips = (autoChips || []).filter(c => c.toLowerCase() !== qTrim && !matchingHistory.includes(c)).slice(0, 5 - matchingHistory.length);

  if (matchingHistory.length === 0 && cleanChips.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  let html = `
    <div class="search-suggestions-header">
      <span>Suggestions</span>
      <span style="font-size:10px;color:rgba(255,255,255,0.45);text-transform:none;">Recent &amp; Catalog</span>
    </div>
    <div class="search-suggestions-list" id="searchSuggestionsList">
  `;

  matchingHistory.forEach(item => {
    html += `
      <div tabindex="0" class="search-suggestion-item is-history tv-focusable" data-query="${escapeHtml(item)}" onfocus="playNavSound()">
        <div class="suggestion-left">
          <span class="suggestion-icon" style="color:var(--theme-border);">🕒</span>
          <span>${escapeHtml(item)}</span>
        </div>
        <span class="suggestion-hint">Hold OK to remove</span>
      </div>
    `;
  });

  cleanChips.forEach(chip => {
    html += `
      <div tabindex="0" class="search-suggestion-item tv-focusable" data-query="${escapeHtml(chip)}" onfocus="playNavSound()">
        <div class="suggestion-left">
          <span class="suggestion-icon" style="color:#9CA3AF;">🔍</span>
          <span>${escapeHtml(chip)}</span>
        </div>
        <span class="suggestion-hint">Search</span>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

function applySearchSuggestion(term) {
  if (historyLongPressTriggered) {
    historyLongPressTriggered = false;
    return;
  }
  dismissSuggestions();
  filterState.searchQuery = term;
  const inp = document.getElementById('filterSearchInput');
  if (inp) {
    inp.value = term;
    inp.setAttribute('readonly', 'true');
  }
  saveSearchQuery(term);
  executeFilterQuery();
  setTimeout(() => {
    const firstCard = document.querySelector('#filterResultsGrid .poster-card');
    if (firstCard) { firstCard.focus(); playNavSound(); }
  }, 350);
}

function openDeleteHistoryModal(query) {
  playNavSound();
  pendingDeleteHistoryQuery = query;
  const m = document.getElementById('deleteHistoryModal');
  const txt = document.getElementById('deleteHistoryModalText');
  if (txt) {
    txt.innerHTML = `Do you want to remove "<b>${escapeHtml(query)}</b>" from your search history?`;
  }
  if (m) {
    m.style.display = 'flex';
    setTimeout(() => {
      const cancelBtn = document.getElementById('btnCancelDeleteHistory');
      if (cancelBtn) { cancelBtn.focus(); playNavSound(); }
    }, 40);
  }
}

function closeDeleteHistoryModal() {
  playNavSound();
  pendingDeleteHistoryQuery = null;
  const m = document.getElementById('deleteHistoryModal');
  if (m) m.style.display = 'none';
  const inp = document.getElementById('filterSearchInput');
  if (inp) inp.focus();
}

async function confirmDeleteSearchHistory() {
  playNavSound();
  const query = pendingDeleteHistoryQuery;
  closeDeleteHistoryModal();
  if (!query) return;
  try {
    await fetch('/api/search-history/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    cachedSearchHistory = cachedSearchHistory.filter(h => h.toLowerCase() !== query.toLowerCase());
    renderSearchSuggestions(filterState.searchQuery);
  } catch (e) {
    console.error('[SEARCH] Delete history error:', e);
  }
}

function openClearAllHistoryModal() {
  playNavSound();
  const m = document.getElementById('clearAllHistoryModal');
  if (m) {
    m.style.display = 'flex';
    setTimeout(() => {
      const cancelBtn = document.getElementById('btnCancelClearAllHistory');
      if (cancelBtn) { cancelBtn.focus(); playNavSound(); }
    }, 40);
  }
}

function closeClearAllHistoryModal() {
  playNavSound();
  const m = document.getElementById('clearAllHistoryModal');
  if (m) m.style.display = 'none';
  const clearBtn = document.querySelector('button[onclick="openClearAllHistoryModal()"]');
  if (clearBtn) clearBtn.focus();
}

async function confirmClearAllSearchHistory() {
  playNavSound();
  closeClearAllHistoryModal();
  try {
    await fetch('/api/search-history/clear', { method: 'POST' });
    cachedSearchHistory = [];
    const statusLbl = document.getElementById('searchHistoryClearStatus');
    if (statusLbl) {
      statusLbl.innerText = 'All search history cleared successfully!';
      statusLbl.style.color = '#10B981';
      setTimeout(() => { if (statusLbl) statusLbl.innerText = ''; }, 3000);
    }
  } catch (e) {
    console.error('[SEARCH] Clear all history error:', e);
  }
}

// 8. 4-DIGIT PARENTAL CONTROL PIN & STANDBY AUTO-LOCK
async function updateParentalStatusInSettings() {
  try {
    const res = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' })
    });
    const d = await res.json();
    const adultOpen = Boolean(d.showAdult);
    const extrasOpen = Boolean(d.showExtras);
    const bA = document.getElementById('btnToggleParentalLock');
    const bE = document.getElementById('btnToggleExtrasLock');
    if (bA) bA.innerText = adultOpen ? 'Lock' : 'Unlock';
    if (bE) bE.innerText = extrasOpen ? 'Lock' : 'Unlock';
    if (appStatus && appStatus.parentalControl) {
      appStatus.parentalControl.showAdult = adultOpen;
      appStatus.parentalControl.showExtras = extrasOpen;
      appStatus.parentalControl.isLocked = !adultOpen;
    }
  } catch (e) {}
}

// One switch per area: target is 'adult' or 'extras'. Unlocking needs the Master PIN; locking does not.
async function toggleVaultSession(target) {
  playNavSound();
  if (currentActiveProfile && currentActiveProfile.isKids) {
    showToast('Not available in Kids Mode');
    return;
  }
  try {
    const res = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' })
    });
    const d = await res.json();
    const open = target === 'extras' ? d.showExtras : d.showAdult;
    if (open) {
      await lockVault(target);
    } else {
      openParentalPinModal({ action: 'unlock', target });
    }
  } catch (e) {}
}

async function toggleParentalLockSession() { return toggleVaultSession('adult'); }
async function toggleExtrasLockSession() { return toggleVaultSession('extras'); }

window.lockParentalControls = async function() {
  try {
    await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lock' })
    });
    console.log('[PARENTAL] Session re-locked on app background/standby');
    if (appStatus && appStatus.parentalControl) {
      appStatus.parentalControl.isLocked = true;
      appStatus.parentalControl.showAdult = false;
    appStatus.parentalControl.showExtras = false;
    }
    renderSidebar();
    if (currentTab === 'VAULT_18' || currentTab === 'EXTRAS') {
      navigateToTab('HOME');
    } else if (currentTab === 'LIVE_TV' || currentTab === 'SEARCH') {
      navigateToTab(currentTab);
    }
  } catch (e) {}
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    window.lockParentalControls();
  }
});

let parentalPinContext = { action: 'unlock', onComplete: null };
let isCreatingPinMode = false;

async function openParentalPinModal(context = { action: 'unlock' }) {
  parentalPinContext = context;
  playNavSound();
  enteredPin = '';
  updatePinDots();

  // Check if Master PIN has been set
  let hasPin = false;
  try {
    const res = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' })
    });
    const d = await res.json();
    hasPin = Boolean(d.hasCustomPin || d.hasPin);
  } catch (_) {}

  isCreatingPinMode = !hasPin;

  const title = document.getElementById('parentalPinTitle');
  if (title) {
    if (isCreatingPinMode) {
      title.innerText = 'Create Master PIN';
    } else {
      title.innerText = context.action === 'disable_kids' ? 'Master PIN Required' : 'Parental Control';
    }
  }
  const sub = document.getElementById('parentalPinSubtitle');
  if (sub) {
    if (isCreatingPinMode) {
      sub.innerText = 'Set a 4-digit Master PIN to protect adult content & settings';
    } else {
      sub.innerText = context.action === 'disable_kids' ? 'Enter Master PIN to disable Kids Mode' : ('Enter 4-digit Master PIN to unlock ' + (context.target === 'extras' ? 'Extras' : '18+ Vault'));
    }
  }
  document.getElementById('pinErrorMessage').innerText = '';
  const m = document.getElementById('parentalPinModal');
  if (m) {
    m.style.display = 'flex';
    setTimeout(() => {
      const firstBtn = m.querySelector('.pin-btn');
      if (firstBtn) { firstBtn.focus(); playNavSound(); }
    }, 40);
  }
}

function closeParentalPinModal() {
  document.getElementById('parentalPinModal').style.display = 'none';
  if (parentalPinContext && parentalPinContext.action === 'disable_kids') {
    const kidsBtn = document.getElementById('btnToggleKidsMode');
    if (kidsBtn) kidsBtn.focus();
  } else {
    const lockBtn = document.getElementById('btnToggleParentalLock');
    if (lockBtn && (currentTab === 'SETTINGS' || currentTab === 'PROFILE')) lockBtn.focus();
  }
}

function pressPinDigit(d) {
  playNavSound();
  if (enteredPin.length < 4) {
    enteredPin += d;
    updatePinDots();
    if (enteredPin.length === 4) verifyParentalPin();
  }
}

function clearPin() {
  playNavSound();
  enteredPin = '';
  updatePinDots();
  document.getElementById('pinErrorMessage').innerText = '';
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dot');
  dots.forEach((dot, idx) => {
    if (idx < enteredPin.length) dot.classList.add('filled');
    else dot.classList.remove('filled');
  });
}

async function verifyParentalPin() {
  try {
    if (!/^\d{4}$/.test(enteredPin)) {
      document.getElementById('pinErrorMessage').innerText = 'PIN must be 4 numeric digits';
      setTimeout(clearPin, 500);
      return;
    }
    const isCallbackAction = parentalPinContext && (parentalPinContext.action === 'disable_kids' || parentalPinContext.action === 'verify_only');

    if (isCreatingPinMode) {
      const res = await fetch('/api/parental-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_pin', newPin: enteredPin })
      });
      const d = await res.json();
      if (d.success) {
        syncPinToCloud(d); // first PIN for this account: no proof needed
        showToast('✓ Master PIN created!');
        isCreatingPinMode = false;
        const pinUsed = enteredPin;
        closeParentalPinModal();
        if (isCallbackAction) {
          if (typeof parentalPinContext.onComplete === 'function') {
            parentalPinContext.onComplete(pinUsed);
          }
        } else {
          await fetch('/api/parental-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unlock', pin: pinUsed, target: (parentalPinContext && parentalPinContext.target) || 'adult' })
          });
          if (appStatus && appStatus.parentalControl) {
            if (parentalPinContext && parentalPinContext.target === 'extras') { appStatus.parentalControl.showExtras = true; }
            else { appStatus.parentalControl.isLocked = false; appStatus.parentalControl.showAdult = true; }
          }
          renderSidebar();
          if (currentTab === 'SETTINGS' || currentTab === 'PROFILE') {
            updateParentalStatusInSettings();
          } else {
            navigateToTab(currentTab);
          }
        }
        return;
      } else {
        document.getElementById('pinErrorMessage').innerText = d.error || 'Failed to set PIN';
        setTimeout(clearPin, 600);
        return;
      }
    }

    const actionParam = isCallbackAction ? 'verify' : 'unlock';
    const res = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: actionParam, pin: enteredPin, target: (parentalPinContext && parentalPinContext.target) || 'adult' })
    });
    const d = await res.json();
    if (d.success || d.ok) {
      const pinUsed = enteredPin;
      closeParentalPinModal();
      if (isCallbackAction) {
        if (typeof parentalPinContext.onComplete === 'function') {
          parentalPinContext.onComplete(pinUsed);
        }
      } else {
        if (appStatus && appStatus.parentalControl) {
          if (parentalPinContext && parentalPinContext.target === 'extras') { appStatus.parentalControl.showExtras = true; }
          else { appStatus.parentalControl.isLocked = false; appStatus.parentalControl.showAdult = true; }
        }
        renderSidebar();
        if (currentTab === 'SETTINGS' || currentTab === 'PROFILE') {
          updateParentalStatusInSettings();
        } else {
          navigateToTab(currentTab);
        }
      }
    } else {
      document.getElementById('pinErrorMessage').innerText = d.error || 'Incorrect PIN';
      setTimeout(clearPin, 600);
    }
  } catch (err) {
    document.getElementById('pinErrorMessage').innerText = 'Connection error';
  }
}

function openResetPinModal() {
  closeParentalPinModal();
  playNavSound();
  const m = document.getElementById('resetPinModal');
  if (m) {
    document.getElementById('resetPinPasswordInput').value = '';
    const codeBox = document.getElementById('resetPinCodeInput');
    if (codeBox) codeBox.value = '';
    document.getElementById('resetPinNewInput').value = '';
    document.getElementById('resetPinErrorMessage').innerText = '';
    m.style.display = 'flex';
    setTimeout(() => {
      const input = document.getElementById('resetPinPasswordInput');
      if (input) { input.focus(); playNavSound(); }
    }, 40);
  }
}

let diagPages = [], diagPageNo = 0;
function openDiagModal() {
  const m = document.getElementById('diagModal');
  if (!m) return;
  m.style.display = 'flex';
  const pre = document.getElementById('diagText');
  if (pre) pre.textContent = 'Loading the report… (it can take a few seconds while the TV is busy)';
  const c = document.getElementById('btnDiagClose');
  if (c) c.focus();
  setTimeout(loadDiagText, 30);
}
function closeDiagModal() {
  const m = document.getElementById('diagModal');
  if (m) m.style.display = 'none';
  const b = document.getElementById('btnReportProblem');
  if (b && b.offsetParent !== null) b.focus();
}
function renderDiagPage() {
  const pre = document.getElementById('diagText');
  if (!pre || !diagPages.length) return;
  if (diagPageNo >= diagPages.length) diagPageNo = 0;
  pre.textContent = 'Page ' + (diagPageNo + 1) + ' of ' + diagPages.length + '   (take a photo of EVERY page)\n' + diagPages[diagPageNo].join('\n');
}
function diagNextPage() { diagPageNo = (diagPageNo + 1) % Math.max(1, diagPages.length); renderDiagPage(); }
async function loadDiagText() {
  const pre = document.getElementById('diagText');
  if (!pre) return;
  try {
    const r = await fetch('/api/diag');
    const d = r && r.ok ? await r.json() : null;
    if (!d) { pre.textContent = 'The report is not available on this device.'; return; }
    const until = d.cloudPausedUntil && d.cloudPausedUntil > Date.now() ? new Date(d.cloudPausedUntil).toLocaleString() : 'no';
    const basic = [
      `StreamVault ${d.appVersion}  |  ${d.device}`,
      `Titles: ${d.titles}  |  with details: ${d.enriched}  |  waiting for the cloud: ${d.cloudPending}  |  cloud paused until: ${until}  |  signed in: ${d.signedIn ? 'yes' : 'no'}`,
      d.lastCrash ? `Last crash: ${String(d.lastCrash).slice(0, 300)}` : 'No crash recorded.',
      '--- latest events ---',
      ...(d.lines && d.lines.length ? d.lines.slice(-22) : ['(nothing recorded yet)'])
    ];
    const lines = (d.report && d.report.length ? d.report : basic).flatMap((l) => {
      const t = String(l); const out = [];
      for (let i = 0; i < t.length; i += 150) out.push(t.slice(i, i + 150));
      return out.length ? out : [''];
    });
    // pages: a new page starts at each "=== SECTION ===" once the current page has enough lines
    diagPages = []; let cur = [];
    for (const l of lines) {
      if ((l.startsWith('===') && cur.length >= 14) || cur.length >= 24) { diagPages.push(cur); cur = []; }
      cur.push(l);
    }
    if (cur.length) diagPages.push(cur);
    diagPageNo = 0;
    renderDiagPage();
  } catch (_) { pre.textContent = 'The report could not be loaded.'; }
}

