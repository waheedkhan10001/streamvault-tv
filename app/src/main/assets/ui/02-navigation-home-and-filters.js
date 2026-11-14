let navLoadSeq = 0;   // newest tab open wins: an older, slower load never draws over it
async function navigateToTab(tabId, customFilter = null, focusFirstCard = false) {
  const myNavSeq = ++navLoadSeq;
  if (sidebarOpenTimer) { clearTimeout(sidebarOpenTimer); sidebarOpenTimer = null; }
  if (tabId !== 'PROFILE') revertThemePreview();
  if (!getStoredAuthToken()) {
    showWelcomeScreen();
    return;
  }
  if (isAppLockedForPlaylist() && tabId !== 'SETTINGS') {
    showToast('⚙ Please enter your IPTV provider in Settings.');
    tabId = 'SETTINGS';
  }

  if (currentTab !== 'SETTINGS' && currentTab !== 'PROFILE' && (tabId === 'SETTINGS' || tabId === 'PROFILE')) {
    previousTab = currentTab;
  }
  const leavingTab = currentTab;
  // Coming into a tab from somewhere else always starts at the top; only a redraw of the same tab keeps the place
  if (currentTab !== tabId) delete tabFocusMemory[tabId];
  const memAtOpen = tabFocusMemory[tabId];   // the screen's own first-title focus must not overwrite this before we use it
  currentTab = tabId;
  renderCatalogStrip();
  lastContentFocusTarget = null;
  // Leaving the 18+ or Extras area locks it again
  if (leavingTab !== tabId) {
    if (leavingTab === 'VAULT_18') lockVault('adult', true);
    if (leavingTab === 'EXTRAS') lockVault('extras', true);
    if (tabId === 'VAULT_18' || tabId === 'EXTRAS') vaultPanelState[tabId] = 'MOVIES';
  }

  if (customFilter) {
    filterState = {
      searchQuery: customFilter.searchQuery || '',
      mediaTypeFilter: customFilter.mediaTypeFilter || (tabId === 'MOVIES' ? 'MOVIE' : tabId === 'SERIES' ? 'SERIES' : null),
      categoryFilter: customFilter.categoryFilter || null,
      yearFilter: customFilter.yearFilter || null,
      includedGenres: customFilter.includedGenres || [],
      excludedGenres: customFilter.excludedGenres || [],
      matchAllIncludedGenres: true,
      selectedLanguages: customFilter.selectedLanguages || [],
      qualityFilter: null,
      decade: null,
      minRating: 0,
      sortBy: customFilter.sortBy || 'NEWLY_ADDED',
      limit: 120
    };
  } else {
    // Clean slate on tab switch per user decision: clear query and reset filter dropdowns
    filterState = {
      searchQuery: '',
      mediaTypeFilter: tabId === 'MOVIES' ? 'MOVIE' : tabId === 'SERIES' ? 'SERIES' : vaultMediaType(tabId),
      categoryFilter: null,
      yearFilter: null,
      includedGenres: [],
      excludedGenres: [],
      matchAllIncludedGenres: true,
      selectedLanguages: [],
      qualityFilter: null,
      decade: null,
      minRating: 0,
      sortBy: 'NEWLY_ADDED',
      limit: 120
    };
  }
  closeAllDropdowns();

  renderSidebar();
  if (focusFirstCard) {
    // Keep focus off sidebar so first card in catalog receives focus
    // ...then, once the tab has drawn, move to the title the person was on last time (only if they have not pressed anything meanwhile)
    const navAtOpen = navKeyCounter;
    [650, 1200].forEach((ms) => setTimeout(() => {
      if (currentTab !== tabId || navKeyCounter !== navAtOpen) return;
      const r = findRememberedFocus(memAtOpen);
      if (r && document.activeElement !== r) { r.focus(); tvScrollIntoView(r, { block: 'nearest' }); }
    }, ms));
  } else if (tabId === 'PROFILE') {
    const userPill = document.getElementById('sidebarUserProfilePill') || document.querySelector('.user-profile-pill');
    if (userPill) userPill.focus();
  } else if (tabId === 'SETTINGS') {
    const settingsBtn = document.getElementById('sidebarSettingsBtn') || document.querySelector('.settings-icon-btn');
    if (settingsBtn) settingsBtn.focus();
  } else {
    const activeTabBtn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`) || document.querySelector('.nav-btn.active');
    if (activeTabBtn) activeTabBtn.focus();
  }
  const vp = document.getElementById('mainViewport');
  if (!vp) return;
  vp.innerHTML = '<div style="padding:40px;color:var(--muted);">Loading...</div>';

  if (tabId === 'HOME') {
    await loadHome(vp, myNavSeq);
  } else if (tabId === 'SEARCH') {
    loadSuperFilter(vp, 'Search');
    if (focusFirstCard) {
      setTimeout(() => {
        const firstCard = document.querySelector('#filterResultsGrid .poster-card');
        if (firstCard) { firstCard.focus(); playNavSound(); }
      }, 400);
    }
  } else if (tabId === 'MOVIES') {
    loadSuperFilter(vp, 'Movies');
    if (focusFirstCard) {
      setTimeout(() => {
        const firstCard = document.querySelector('#filterResultsGrid .poster-card');
        if (firstCard) { firstCard.focus(); playNavSound(); }
      }, 400);
    }
  } else if (tabId === 'SERIES') {
    loadSuperFilter(vp, 'Series');
    if (focusFirstCard) {
      setTimeout(() => {
        const firstCard = document.querySelector('#filterResultsGrid .poster-card');
        if (firstCard) { firstCard.focus(); playNavSound(); }
      }, 400);
    }
  } else if (tabId === 'VAULT_18') {
    if (currentActiveProfile && currentActiveProfile.isKids) {
      showToast('18+ Vault is not available in Kids Mode');
      navigateToTab('HOME');
      return;
    }
    const isAdultUnlocked = appStatus?.parentalControl && !appStatus.parentalControl.isLocked && appStatus.parentalControl.showAdult;
    if (!isAdultUnlocked) {
      openParentalPinModal({ action: 'unlock', target: 'adult' });
      return;
    }
    openVaultPanel(vp, 'VAULT_18', focusFirstCard);
  } else if (tabId === 'EXTRAS') {
    if (currentActiveProfile && currentActiveProfile.isKids) {
      showToast('Extras is not available in Kids Mode');
      navigateToTab('HOME');
      return;
    }
    if (!(appStatus?.parentalControl && appStatus.parentalControl.showExtras)) {
      navigateToTab('HOME');
      return;
    }
    openVaultPanel(vp, 'EXTRAS', focusFirstCard);
  } else if (tabId === 'LATEST') {
    await loadLatest(vp, focusFirstCard);
  } else if (tabId === 'LIVE_TV') {
    if (currentActiveProfile && currentActiveProfile.isKids) {
      showToast('Live TV is not available in Kids Mode');
      navigateToTab('HOME');
      return;
    }
    await loadLiveTv(vp);
  } else if (tabId === 'WATCHLIST') {
    await loadWatchlist(vp);
  } else if (tabId === 'PROFILE') {
    await loadProfile(vp);
  } else if (tabId === 'SETTINGS') {
    loadSettings(vp);
    const paintEnrich = () => updateEnrichStatusRow((appStatus && appStatus.syncStatus) || {});
    setTimeout(paintEnrich, 120);
    setTimeout(async () => { try { await refreshSyncStatusOnly(); } catch (_) {} paintEnrich(); }, 700);
  }
}

// 1. HOME SCREEN (Punchy Rows + Hero + Horizontal Strips)
// Shown on empty Home / Movies / Series while the catalog is still downloading (or when the download failed)
async function catalogNoticeHtml() {
  try { await refreshAppStatus(); } catch (_) {}
  const sync = (appStatus && appStatus.syncStatus) || {};
  const total = Number((appStatus && appStatus.totalCatalogCount) || 0);
  if (sync.error && !sync.isSyncing) {
    return `<div id="catalogNotice" style="padding:60px 24px;text-align:center;"><div style="font-size:18px;font-weight:900;color:#F87171;margin-bottom:8px;">Could not load your catalog</div><div style="font-size:13px;color:#D1D5DB;max-width:560px;margin:0 auto;">${escapeHtml(String(sync.error))}</div><div style="font-size:11px;color:#9CA3AF;margin-top:10px;">Check your IPTV details in Settings &rarr; IPTV Playlists, then use Check for new titles.</div></div>`;
  }
  if (sync.isSyncing || total === 0) {
    const phase = sync.phase ? escapeHtml(String(sync.phase)) : 'Getting started...';
    return `<div id="catalogNotice" style="padding:60px 24px;text-align:center;"><div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:8px;">Loading your catalog…</div><div style="font-size:13px;color:var(--theme-border);">${phase}</div><div style="font-size:11px;color:#9CA3AF;margin-top:10px;max-width:560px;margin-left:auto;margin-right:auto;">The first load can take a few minutes. Titles appear as they are ready, so you can browse meanwhile.</div></div>`;
  }
  return '';
}

async function loadHome(vp, navSeq) {
  try {
    const res = await fetch('/api/home');
    const data = await res.json();
    if (navSeq !== undefined && navSeq !== navLoadSeq) return;   // the person already moved to another tab
    homeData = data;
  } catch (err) {
    vp.innerHTML = `<div style="padding:40px;color:#EF4444;">Failed to load Home: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const hero = homeData.hero;
  const rows = (homeData.rows || []).filter((r) => r.title !== 'My List');

  if (!hero && rows.every((r) => !(r.items || []).length)) {
    const notice = await catalogNoticeHtml();
    if (notice) {
      vp.innerHTML = notice;
      setTimeout(() => { if (currentTab === 'HOME' && document.getElementById('catalogNotice')) loadHome(document.getElementById('mainViewport')); }, 5000);
      return;
    }
  }

  let htmlStr = '';
  if (hero) {
    const backdrop = hero.backdropUrl || hero.posterUrl || '';
    const ratingDisplay = hero.rating > 0 ? `${ratingStar(hero)} ${ratingText(hero)}` : '';
    htmlStr += `
      <div class="hero" style="background-image:url('${backdrop}');">
        <div class="hero-content">
          <div class="hero-title">${escapeHtml(hero.cleanTitle)}</div>
          <div class="hero-meta">
            ${ratingDisplay ? `<span class="badge-rating">${ratingDisplay}</span>` : ''}
            <span class="badge-quality">${(hero.qualityBadges || ['HD'])[0]}</span>
            <span class="badge-language">${hero.language || 'English'}</span>
            <span style="color:#9CA3AF;font-weight:700;">${hero.year || ''}</span>
            <div style="display:flex;gap:4px;">
              ${(hero.genres || []).filter(g => g && g.replace(/[\.\s…\-–—\|]/g, '').length > 0 && g !== '…' && g !== '...').slice(0, 3).map((g) => `<span class="badge-genre">${escapeHtml(g)}</span>`).join('')}
            </div>
          </div>
          <div class="hero-plot">${escapeHtml(hero.plot || 'No synopsis available.')}</div>
          <div class="hero-actions">
            <button tabindex="0" class="btn btn-primary tv-focusable" onclick="playHeroMovie('${hero.dedupKey}')">Play Movie</button>
            <button tabindex="0" class="btn tv-focusable" onclick="openDetailModal('${hero.dedupKey}')">More Info</button>
          </div>
        </div>
      </div>
    `;
  }

  rows.forEach((row, rIdx) => {
    htmlStr += `
      <div class="row-section">
        <div class="row-header">
          <div class="row-title">${escapeHtml(row.title)}</div>
        </div>
        <div class="row-strip-wrapper">
          <button class="chevron-btn chevron-left" onclick="scrollRow('rowStrip_${rIdx}', -700)">‹</button>
          <div class="poster-strip" id="rowStrip_${rIdx}">
            ${(row.items || []).map((m) => renderPosterCard(m)).join('')}
          </div>
          <button class="chevron-btn chevron-right" onclick="scrollRow('rowStrip_${rIdx}', 700)">›</button>
        </div>
      </div>
    `;
  });

  vp.innerHTML = htmlStr;
}

function scrollRow(elementId, distance) {
  playNavSound();
  const el = document.getElementById(elementId);
  if (el) el.scrollBy({ left: distance, behavior: 'auto' });
}

function getSeriesSeasonTag(m) {
  if (m.mediaType !== 'SERIES') return null;
  if (m.seasonTag && m.seasonTag !== 'Series') return m.seasonTag;
  if (m.episodes && m.episodes.length > 0) {
    const seasons = [...new Set(m.episodes.map(e => e.season))].sort((a, b) => a - b);
    if (seasons.length > 1) return `${seasons.length} Seasons`;
    if (seasons.length === 1 && seasons[0] > 0) return `S${seasons[0]}`;
  }
  const raw = m.rawTitle || m.cleanTitle || '';
  const match = raw.match(/\bS0*(\d{1,2})\b/i) || raw.match(/\bSeason\s*(\d{1,2})\b/i);
  if (match) return `S${parseInt(match[1], 10)}`;
  return null;
}

function renderPosterCard(m) {
  const isSeries = m.mediaType === 'SERIES';
  const seriesTag = isSeries ? getSeriesSeasonTag(m) : null;
  const ratingStr = m.rating > 0 ? `${ratingStar(m)} ${ratingText(m)}` : '';
  const yearStr = m.year ? String(m.year) : '';
  const quality = (m.qualityBadges || [])[0] || 'HD';
  const lang = m.language || 'English';
  const isWatched = Boolean(m.isWatched);
  const hasProgress = (!isWatched && m.resumePositionMs > 30000 && m.durationMs > 0);
  const progressPct = hasProgress ? Math.min(100, Math.max(5, Math.round((m.resumePositionMs / m.durationMs) * 100))) : 0;

  return `
    <div tabindex="0" class="poster-card tv-focusable ${isSeries ? 'is-series' : ''}" onfocus="playNavSound()" onclick="openDetailModal('${m.dedupKey}')">
      <div class="poster-img-wrap">
        ${m.posterUrl
          ? `<img src="${m.posterUrl}" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
             <div class="poster-placeholder" style="display:none;">${escapeHtml(m.cleanTitle)}</div>`
          : `<div class="poster-placeholder">${escapeHtml(m.cleanTitle)}</div>`}
        ${ratingStr ? `<div class="card-top-left">${ratingStr}</div>` : ''}
        <div class="card-top-right">
          ${isWatched ? `<span class="badge-watched">Watched</span>` : ''}
          ${m.isAdult ? `<span class="badge-adult" style="background:#DC2626;color:#fff;font-size:10px;font-weight:900;padding:2px 6px;border-radius:4px;letter-spacing:0.5px;">18+</span>` : ''}
          <span class="badge-quality">${quality}</span>
        </div>
        ${m.matchReason ? `<div class="card-match-banner">${escapeHtml(m.matchReason)}</div>` : ''}
        ${hasProgress ? `
          <div class="card-progress-bar">
            <div class="card-progress-fill" style="width:${progressPct}%;"></div>
          </div>
        ` : ''}
        <div class="card-bottom-strip">
          ${yearStr ? `<span class="card-year-tag">${yearStr}</span>` : '<span></span>'}
          ${m.isAdult ? `
            <span class="badge-adult-pill" style="background:rgba(220,38,38,0.3);color:#FCA5A5;border:1px solid rgba(220,38,38,0.5);font-size:8.5px;font-weight:900;padding:1px 5px;border-radius:3px;">18+ VAULT</span>
          ` : isSeries ? `
            <span class="badge-series" style="font-size:8.5px;padding:1px 5px;font-weight:900;">${seriesTag || 'SERIES'}</span>
          ` : `
            <span class="badge-movie" style="font-size:8.5px;padding:1px 5px;font-weight:900;">MOVIE</span>
          `}
        </div>
      </div>
      <div class="card-title">${escapeHtml(m.cleanTitle)}</div>
      <div class="card-meta">
        ${(m.genres || []).slice(0, 2).map((g) => `<span class="badge-genre">${g}</span>`).join(' ')}
      </div>
    </div>
  `;
}

// 2. WORKING SEARCH & FILTERS (Snug Attached Dropdowns with TV Remote Focus Trapping)
function loadSuperFilter(vp, titleOverride = 'Search') {
  const isVault = currentTab === 'VAULT_18';
  vp.innerHTML = `
    <div class="filter-view-container" onclick="onFilterBackgroundClick(event)">
      <div class="search-input-bar">
        <div class="search-input-wrapper">
          <input id="filterSearchInput" class="search-field tv-focusable"
                 readonly
                 onclick="onSearchInputClicked(this)"
                 onfocus="onSearchFilterFocus()"
                 onblur="onSearchFilterBlur(this)"
                 value="${escapeHtml(filterState.searchQuery)}"
                 placeholder="${isVault ? 'Search 18+ titles & studios' : (currentTab === 'SERIES' ? 'Search series by title, actor or genre' : currentTab === 'MOVIES' ? 'Search movies by title, actor or genre' : 'Search movies and series by title, actor or genre')}"
                 oninput="onSearchFilterInput(this.value)"
                 onkeydown="onSearchInputKeyDown(this, event)" />
          <div id="searchSuggestionsContainer" class="search-suggestions-container" style="display:none;"></div>
        </div>
        <button id="filterSearchBtn" tabindex="0" class="btn btn-primary tv-focusable" style="padding:10px 18px;display:inline-flex;align-items:center;justify-content:center;border-radius:10px;height:44px;" onclick="onFilterSearchBtnClicked()" title="Search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        </button>
        <button id="btnVoiceSearch" tabindex="0" class="btn tv-focusable" style="padding:10px 16px;display:flex;align-items:center;justify-content:center;border-radius:10px;height:44px;" onclick="startVoiceSearch()" title="Voice Dictation">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="22"></line>
          </svg>
        </button>
      </div>

      ${isVault ? `
        <div class="filter-pill-row">
          <!-- Studio / Category Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="0">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.categoryFilter ? 'active' : ''}" onclick="toggleDropdown('dropAdultCat', event)">
              <span>Studio: ${filterState.categoryFilter || 'All'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropAdultCat">
              <div tabindex="0" class="dropdown-option tv-focusable ${!filterState.categoryFilter ? 'selected' : ''}" onclick="selectFilterAdultCategory('')" onfocus="playNavSound()">All Studios / Categories</div>
              ${ADULT_CATEGORIES.map((c) => `
                <div tabindex="0" class="dropdown-option tv-focusable ${filterState.categoryFilter === c ? 'selected' : ''}" onclick="selectFilterAdultCategory('${c}')" onfocus="playNavSound()">
                  <span>${c}</span>
                  ${filterState.categoryFilter === c ? '<span>✓</span>' : ''}
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Year Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="1">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.yearFilter || filterState.decade ? 'active' : ''}" onclick="toggleDropdown('dropAdultYear', event)">
              <span>Year: ${filterState.yearFilter || (filterState.decade ? filterState.decade + 's' : 'All')}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropAdultYear">
              <div tabindex="0" class="dropdown-option tv-focusable ${!filterState.yearFilter && !filterState.decade ? 'selected' : ''}" onclick="selectFilterYear(null)" onfocus="playNavSound()">All Years</div>
              ${[2026, 2025, 2024, 2023, 2022, 2021, 2020].map((y) => `
                <div tabindex="0" class="dropdown-option tv-focusable ${filterState.yearFilter === y ? 'selected' : ''}" onclick="selectFilterYear(${y})" onfocus="playNavSound()">${y}</div>
              `).join('')}
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.decade === 2010 ? 'selected' : ''}" onclick="selectFilterYear(2010)" onfocus="playNavSound()">2010s</div>
            </div>
          </div>

          <!-- Quality Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="2">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.qualityFilter ? 'active' : ''}" onclick="toggleDropdown('dropQuality', event)">
              <span>Quality: ${filterState.qualityFilter || 'All'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropQuality">
              <div tabindex="0" class="dropdown-option tv-focusable ${!filterState.qualityFilter ? 'selected' : ''}" onclick="selectFilterQuality(null)" onfocus="playNavSound()">All Qualities</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === '4K' ? 'selected' : ''}" onclick="selectFilterQuality('4K')" onfocus="playNavSound()">4K / UHD</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === '1080p' ? 'selected' : ''}" onclick="selectFilterQuality('1080p')" onfocus="playNavSound()">1080p / FHD</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === 'HD' ? 'selected' : ''}" onclick="selectFilterQuality('HD')" onfocus="playNavSound()">Standard HD</div>
            </div>
          </div>

          <!-- Sort Order Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="3">
            <button tabindex="0" class="filter-pill-btn tv-focusable" onclick="toggleDropdown('dropSort', event)">
              <span>Sort: ${getSortLabel(filterState.sortBy)}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropSort">
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'NEWLY_ADDED' ? 'selected' : ''}" onclick="selectFilterSort('NEWLY_ADDED')" onfocus="playNavSound()">Recently Added</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'RELEASE_YEAR_DESC' ? 'selected' : ''}" onclick="selectFilterSort('RELEASE_YEAR_DESC')" onfocus="playNavSound()">Newest Year</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'TITLE_ASC' ? 'selected' : ''}" onclick="selectFilterSort('TITLE_ASC')" onfocus="playNavSound()">Alphabetical (A → Z)</div>
            </div>
          </div>

          <!-- Clear Reset Button -->
          <button tabindex="0" class="filter-pill-btn tv-focusable" style="border-color:#374151;color:var(--muted);flex-shrink:0;" onclick="resetFilterState()">Reset</button>

          <!-- Quick Lock Button -->
          <button tabindex="0" class="filter-pill-btn tv-focusable" style="border-color:#EF4444;background:rgba(239,68,68,0.12);color:#F87171;flex-shrink:0;" onclick="lockVaultAndReturnHome()">🔒 Lock Vault</button>
        </div>
      ` : `
        <div class="filter-pill-row">
          <!-- Genre Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="0">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.includedGenres.length > 0 ? 'active' : ''}" onclick="toggleDropdown('dropGenre', event)">
              <span>Genre: ${filterState.includedGenres.length > 0 ? filterState.includedGenres.join(', ') : 'All'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropGenre">
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.includedGenres.length === 0 ? 'selected' : ''}" onclick="selectFilterGenre('')" onfocus="playNavSound()">All Genres</div>
              ${ALL_GENRES.map((g) => `
                <div tabindex="0" class="dropdown-option tv-focusable ${filterState.includedGenres.includes(g) ? 'selected' : ''}" onclick="selectFilterGenre('${g}')" onfocus="playNavSound()">
                  <span>${g}</span>
                  ${filterState.includedGenres.includes(g) ? '<span>✓</span>' : ''}
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Release Year Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="1">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.decade ? 'active' : ''}" onclick="toggleDropdown('dropYear', event)">
              <span>Year: ${filterState.decade ? filterState.decade + 's' : 'All'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropYear">
              <div tabindex="0" class="dropdown-option tv-focusable ${!filterState.decade ? 'selected' : ''}" onclick="selectFilterDecade(null)" onfocus="playNavSound()">All Years</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.decade === 2020 ? 'selected' : ''}" onclick="selectFilterDecade(2020)" onfocus="playNavSound()">2020s (Newest)</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.decade === 2010 ? 'selected' : ''}" onclick="selectFilterDecade(2010)" onfocus="playNavSound()">2010s</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.decade === 2000 ? 'selected' : ''}" onclick="selectFilterDecade(2000)" onfocus="playNavSound()">2000s</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.decade === 1990 ? 'selected' : ''}" onclick="selectFilterDecade(1990)" onfocus="playNavSound()">1990s & Older</div>
            </div>
          </div>

          <!-- Language Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="2">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.selectedLanguages.length > 0 ? 'active' : ''}" onclick="toggleDropdown('dropLang', event)">
              <span>Lang: ${filterState.selectedLanguages.length > 0 ? filterState.selectedLanguages.join(', ') : 'All'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropLang">
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.selectedLanguages.length === 0 ? 'selected' : ''}" onclick="selectFilterLang('')" onfocus="playNavSound()">All Languages</div>
              ${ALL_LANGS.map((l) => `
                <div tabindex="0" class="dropdown-option tv-focusable ${filterState.selectedLanguages.includes(l) ? 'selected' : ''}" onclick="selectFilterLang('${l}')" onfocus="playNavSound()">
                  <span>${l}</span>
                  ${filterState.selectedLanguages.includes(l) ? '<span>✓</span>' : ''}
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Quality Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="3">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.qualityFilter ? 'active' : ''}" onclick="toggleDropdown('dropQuality', event)">
              <span>Quality: ${filterState.qualityFilter || 'All'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropQuality">
              <div tabindex="0" class="dropdown-option tv-focusable ${!filterState.qualityFilter ? 'selected' : ''}" onclick="selectFilterQuality(null)" onfocus="playNavSound()">All Qualities</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === '4K' ? 'selected' : ''}" onclick="selectFilterQuality('4K')" onfocus="playNavSound()">4K / UHD</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === '1080p' ? 'selected' : ''}" onclick="selectFilterQuality('1080p')" onfocus="playNavSound()">1080p / FHD</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === 'HEVC' ? 'selected' : ''}" onclick="selectFilterQuality('HEVC')" onfocus="playNavSound()">HEVC / x265</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.qualityFilter === 'HD' ? 'selected' : ''}" onclick="selectFilterQuality('HD')" onfocus="playNavSound()">Standard HD</div>
            </div>
          </div>

          <!-- Rating Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="4">
            <button tabindex="0" class="filter-pill-btn tv-focusable ${filterState.minRating > 0 ? 'active' : ''}" onclick="toggleDropdown('dropRating', event)">
              <span>Rating: ${filterState.minRating > 0 ? filterState.minRating + '+ ★' : 'Any'}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropRating">
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.minRating === 0 ? 'selected' : ''}" onclick="selectFilterRating(0)" onfocus="playNavSound()">Any Rating</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.minRating === 6.5 ? 'selected' : ''}" onclick="selectFilterRating(6.5)" onfocus="playNavSound()">6.5+ ★ (Decent)</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.minRating === 7.0 ? 'selected' : ''}" onclick="selectFilterRating(7.0)" onfocus="playNavSound()">7.0+ ★ (Good)</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.minRating === 7.5 ? 'selected' : ''}" onclick="selectFilterRating(7.5)" onfocus="playNavSound()">7.5+ ★ (Very Good)</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.minRating === 8.0 ? 'selected' : ''}" onclick="selectFilterRating(8.0)" onfocus="playNavSound()">8.0+ ★ (Critically Acclaimed)</div>
            </div>
          </div>

          <!-- Sort Order Dropdown -->
          <div class="filter-pill-wrapper" data-pill-idx="5">
            <button tabindex="0" class="filter-pill-btn tv-focusable" onclick="toggleDropdown('dropSort', event)">
              <span>Sort: ${getSortLabel(filterState.sortBy)}</span>
              <span>▾</span>
            </button>
            <div class="filter-floating-dropdown" id="dropSort">
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'NEWLY_ADDED' ? 'selected' : ''}" onclick="selectFilterSort('NEWLY_ADDED')" onfocus="playNavSound()">Recently Added</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'RELEASE_YEAR_DESC' ? 'selected' : ''}" onclick="selectFilterSort('RELEASE_YEAR_DESC')" onfocus="playNavSound()">Newest Year</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'RATING_DESC' ? 'selected' : ''}" onclick="selectFilterSort('RATING_DESC')" onfocus="playNavSound()">Highest Rated</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'TITLE_ASC' ? 'selected' : ''}" onclick="selectFilterSort('TITLE_ASC')" onfocus="playNavSound()">Alphabetical (A → Z)</div>
              <div tabindex="0" class="dropdown-option tv-focusable ${filterState.sortBy === 'RANDOM' ? 'selected' : ''}" onclick="selectFilterSort('RANDOM')" onfocus="playNavSound()">Surprise Me</div>
            </div>
          </div>

          <!-- Clear Reset Button -->
          <button tabindex="0" class="filter-pill-btn tv-focusable" style="border-color:#374151;color:var(--muted);flex-shrink:0;" onclick="resetFilterState()">Reset</button>
        </div>
      `}

      <div class="results-count-bar">
        <span id="filterCountLabel">Searching...</span>
      </div>

      <div class="results-grid" id="filterResultsGrid"></div>
    </div>
  `;

  renderSearchSuggestions(filterState.searchQuery);
  executeFilterQuery();
}

function getSortLabel(sort) {
  if (sort === 'RELEASE_YEAR_DESC') return 'Newest';
  if (sort === 'RATING_DESC') return 'Highest';
  if (sort === 'TITLE_ASC') return 'A → Z';
  if (sort === 'RANDOM') return 'Surprise';
  return 'Recent';
}

function toggleDropdown(dropId, event) {
  if (event) event.stopPropagation();
  const el = document.getElementById(dropId);
  if (!el) return;
  const isShown = el.style.display === 'block';
  closeAllDropdowns();
  if (!isShown) {
    el.style.display = 'block';
    activeDropdownId = dropId;
    setTimeout(() => {
      const selected = el.querySelector('.dropdown-option.selected') || el.querySelector('.dropdown-option');
      if (selected) {
        selected.focus();
tvScrollIntoView(selected, { block: 'nearest' });
        playNavSound();
      }
    }, 40);
  }
}

function closeAllDropdowns() {
  document.querySelectorAll('.filter-floating-dropdown').forEach((d) => (d.style.display = 'none'));
  activeDropdownId = null;
}

function onFilterBackgroundClick(e) {
  if (!e.target.closest('.filter-pill-btn') && !e.target.closest('.filter-floating-dropdown')) {
    closeAllDropdowns();
  }
}

// After a choice the screen is rebuilt: put the remote back on the button of the dropdown that was just used.
function focusFilterPill(dropId) {
  setTimeout(() => {
    const drop = document.getElementById(dropId);
    const pill = drop && drop.parentElement && drop.parentElement.querySelector('.filter-pill-btn');
    if (pill) pill.focus();
  }, 40);
}

function selectFilterGenre(g) {
  if (!g) filterState.includedGenres = [];
  else {
    const idx = filterState.includedGenres.indexOf(g);
    if (idx >= 0) filterState.includedGenres.splice(idx, 1);
    else filterState.includedGenres.push(g);
  }
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'));
  focusFilterPill('dropGenre');
}

function selectFilterDecade(d) {
  filterState.decade = d;
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'));
  focusFilterPill('dropYear');
}

function selectFilterLang(l) {
  if (!l) filterState.selectedLanguages = [];
  else {
    const idx = filterState.selectedLanguages.indexOf(l);
    if (idx >= 0) filterState.selectedLanguages.splice(idx, 1);
    else filterState.selectedLanguages.push(l);
  }
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'));
  focusFilterPill('dropLang');
}

function selectFilterQuality(q) {
  filterState.qualityFilter = q;
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'));
  focusFilterPill('dropQuality');
}

function selectFilterRating(r) {
  filterState.minRating = r;
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'));
  focusFilterPill('dropRating');
}

function selectFilterSort(s) {
  filterState.sortBy = s;
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'), currentTab === 'VAULT_18' ? '18+ Vault' : currentTab === 'EXTRAS' ? 'Extras' : currentTab === 'SERIES' ? 'Series' : currentTab === 'MOVIES' ? 'Movies' : 'Search');
  focusFilterPill('dropSort');
}

function selectFilterAdultCategory(cat) {
  filterState.categoryFilter = cat || null;
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'), '18+ Vault');
  focusFilterPill('dropAdultCat');
}

function selectFilterYear(yr) {
  if (typeof yr === 'number' && yr >= 2000 && yr <= 2030) {
    filterState.yearFilter = yr;
    filterState.decade = null;
  } else {
    filterState.yearFilter = null;
    filterState.decade = yr;
  }
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'), currentTab === 'VAULT_18' ? '18+ Vault' : currentTab === 'EXTRAS' ? 'Extras' : currentTab === 'SERIES' ? 'Series' : currentTab === 'MOVIES' ? 'Movies' : 'Search');
  focusFilterPill((currentTab === 'VAULT_18' ? 'dropAdultYear' : 'dropYear'));
}

async function lockVaultAndReturnHome() {
  playNavSound();
  await window.lockParentalControls();
  navigateToTab('HOME');
}

function resetFilterState() {
  const currentTabMediaType = (currentTab === 'SERIES') ? 'SERIES' : (currentTab === 'MOVIES') ? 'MOVIE' : vaultMediaType(currentTab);
  filterState = {
    searchQuery: '',
    mediaTypeFilter: currentTabMediaType,
    categoryFilter: null,
    yearFilter: null,
    includedGenres: [],
    excludedGenres: [],
    matchAllIncludedGenres: true,
    selectedLanguages: [],
    qualityFilter: null,
    decade: null,
    minRating: 0,
    sortBy: 'NEWLY_ADDED',
    limit: 120
  };
  closeAllDropdowns();
  loadSuperFilter(document.getElementById('mainViewport'), currentTab === 'VAULT_18' ? '18+ Vault' : currentTab === 'EXTRAS' ? 'Extras' : currentTab === 'SERIES' ? 'Series' : currentTab === 'MOVIES' ? 'Movies' : 'Search');
}

function onSearchFilterFocus() {
  const inp = document.getElementById('filterSearchInput');
  isSearchTypingSession = true;
  renderSearchSuggestions(inp ? inp.value : '');
}

function onFilterSearchBtnClicked() {
  dismissSuggestions();
  const q = filterState.searchQuery;
  if (q && q.trim().length >= 2) {
    saveSearchQuery(q);
  }
  executeFilterQuery();
}

function onSearchFilterInput(val) {
  filterState.searchQuery = val;
  isSearchTypingSession = true;
  renderSearchSuggestions(val);
  if (queryDebounceTimer) clearTimeout(queryDebounceTimer);
  queryDebounceTimer = setTimeout(executeFilterQuery, 220);
}

function selectAutoChip(term) {
  dismissSuggestions();
  filterState.searchQuery = term;
  const inp = document.getElementById('filterSearchInput');
  if (inp) inp.value = term;
  saveSearchQuery(term);
  executeFilterQuery();
}

let currentFilterOffset = 0;
let isLoadingMoreFilter = false;
let hasMoreFilterResults = false;
let pendingFilterDownCount = 0;
let pendingFilterDownFrom = null;   // a Down press that arrived while more titles were still loading
let currentTotalFilterMatched = 0;
let cachedFilterItems = [];
let windowStartIdx = 0;
const MAX_WINDOW_CARDS = 300;
const BATCH_SIZE = 120;

function getGridColumns(grid) {
  return 5;
}

function getGridRowHeight(grid) {
  const firstCard = grid.querySelector('.poster-card');
  return firstCard ? (firstCard.offsetHeight + 16) : 310;
}

function updateTopSpacer(grid) {
  let spacer = document.getElementById('gridTopSpacer');
  const cols = getGridColumns(grid);
  const rowHeight = getGridRowHeight(grid);
  const prunedRows = Math.floor(windowStartIdx / cols);
  const spacerHeight = prunedRows * rowHeight;

  if (spacerHeight > 0) {
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.id = 'gridTopSpacer';
      spacer.style.cssText = 'grid-column:1/-1;width:100%;pointer-events:none;margin:0;padding:0;';
      grid.prepend(spacer);
    }
    spacer.style.height = `${spacerHeight}px`;
  } else if (spacer) {
    spacer.remove();
  }
}

function restorePreviousGridWindow() {
  const grid = document.getElementById('filterResultsGrid');
  if (!grid || windowStartIdx <= 0) return false;
  const restoreCount = Math.min(BATCH_SIZE, windowStartIdx);
  const newStart = windowStartIdx - restoreCount;
  const prevItems = cachedFilterItems.slice(newStart, windowStartIdx);
  if (prevItems.length === 0) return false;

  windowStartIdx = newStart;
  updateTopSpacer(grid);

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = prevItems.map((m) => renderPosterCard(m)).join('');

  const firstCard = grid.querySelector('.poster-card');
  while (tempDiv.firstChild) {
    if (firstCard) {
      grid.insertBefore(tempDiv.firstChild, firstCard);
    } else {
      grid.appendChild(tempDiv.firstChild);
    }
  }

  // Prune from bottom to keep DOM strictly within MAX_WINDOW_CARDS
  const allCards = Array.from(grid.querySelectorAll('.poster-card'));
  if (allCards.length > MAX_WINDOW_CARDS) {
    const pruneFromBottom = allCards.slice(MAX_WINDOW_CARDS);
    pruneFromBottom.forEach(c => c.remove());
  }

  const curCount = grid.querySelectorAll('.poster-card').length;
  const countLbl = document.getElementById('filterCountLabel');
  if (countLbl) {
    countLbl.innerText = `Showing ${windowStartIdx + 1} - ${windowStartIdx + curCount} of ${currentTotalFilterMatched.toLocaleString()} titles`;
  }
  return true;
}

async function executeFilterQuery(append = false) {
  const grid = document.getElementById('filterResultsGrid');
  const countLbl = document.getElementById('filterCountLabel');
  const acRow = document.getElementById('searchAutocompleteRow');
  if (!grid) return;

  if (append) {
    if (isLoadingMoreFilter || !hasMoreFilterResults) return;
    isLoadingMoreFilter = true;
    currentFilterOffset += 120;
    const loaderPill = document.createElement('div');
    loaderPill.id = 'filterScrollLoader';
    loaderPill.style.cssText = 'grid-column:1/-1;padding:24px;text-align:center;color:var(--theme-border);font-weight:700;font-size:13px;letter-spacing:0.3px;';
    loaderPill.innerText = '⟳ Loading more titles...';
    grid.appendChild(loaderPill);
  } else {
    currentFilterOffset = 0;
    cachedFilterItems = [];
    windowStartIdx = 0;
    isLoadingMoreFilter = false;
    hasMoreFilterResults = false;
    grid.innerHTML = '<div style="grid-column:1/-1;padding:40px;color:var(--muted);text-align:center;">Filtering catalog...</div>';
  }

  const tabAtQuery = currentTab;
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...filterState, adultOnly: currentTab === 'VAULT_18', extrasOnly: currentTab === 'EXTRAS', limit: 120, offset: currentFilterOffset })
    });
    const data = await res.json();
    if (currentTab !== tabAtQuery) return;   // the person already moved to another tab
    const items = data.items || [];
    const matchCount = data.totalMatched !== undefined ? data.totalMatched : items.length;
    currentTotalFilterMatched = matchCount;
    hasMoreFilterResults = Boolean(data.hasMore);

    const oldLoader = document.getElementById('filterScrollLoader');
    if (oldLoader) oldLoader.remove();

    if (append) {
      if (items.length > 0) {
        cachedFilterItems = cachedFilterItems.concat(items);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = items.map((m) => renderPosterCard(m)).join('');
        while (tempDiv.firstChild) {
          grid.appendChild(tempDiv.firstChild);
        }

        // Sliding Window Guard: Prune from top if DOM exceeds MAX_WINDOW_CARDS
        const allCards = Array.from(grid.querySelectorAll('.poster-card'));
        if (allCards.length > MAX_WINDOW_CARDS) {
          const pruneCount = BATCH_SIZE;
          for (let i = 0; i < pruneCount; i++) {
            if (allCards[i]) allCards[i].remove();
          }
          windowStartIdx += pruneCount;
          updateTopSpacer(grid);
        }
      }
      isLoadingMoreFilter = false;
      if (pendingFilterDownFrom) {
        const from = pendingFilterDownFrom; const n = pendingFilterDownCount; pendingFilterDownFrom = null; pendingFilterDownCount = 0;
        const list = Array.from(grid.querySelectorAll('.poster-card'));
        const at = list.indexOf(from);
        const c = getGridColumns(grid);
        if (at >= 0 && document.activeElement === from) {
          // every Down press that came in while loading counts: go down that many rows, as far as there are titles
          const rowsAvailable = Math.floor((list.length - 1 - at) / c);
          const rows = Math.min(n, rowsAvailable);
          const tgt = list[at + rows * c];
          if (tgt && rows > 0) { tgt.focus(); tvScrollIntoView(tgt, { block: 'nearest' }); }
          if (n > rows && hasMoreFilterResults && tgt) {      // more presses than loaded titles: carry on after the next batch
            pendingFilterDownFrom = tgt; pendingFilterDownCount = n - rows;
            executeFilterQuery(true);
          }
        }
      }
      const curCount = grid.querySelectorAll('.poster-card').length;
      if (countLbl) {
        countLbl.innerText = `Showing ${windowStartIdx + 1} - ${windowStartIdx + curCount} of ${matchCount.toLocaleString()} titles`;
      }
      return;
    }

    cachedFilterItems = items;
    windowStartIdx = 0;

    if (countLbl) {
      if (matchCount > items.length) {
        countLbl.innerText = `Showing 1 - ${items.length.toLocaleString()} of ${matchCount.toLocaleString()} titles`;
      } else {
        countLbl.innerText = `${matchCount.toLocaleString()} titles found`;
      }
    }

    renderSearchSuggestions(filterState.searchQuery, data.autoChips || []);

    if (items.length === 0 && !isVaultTab(currentTab) && !filterState.searchQuery) {
      const notice = await catalogNoticeHtml();
      if (notice) {
        grid.innerHTML = '<div style="grid-column:1/-1;">' + notice + '</div>';
        setTimeout(() => { if (document.getElementById('catalogNotice') && document.getElementById('filterResultsGrid')) executeFilterQuery(false); }, 5000);
        return;
      }
    }
    if (items.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;padding:60px 20px;color:var(--muted);text-align:center;font-size:15px;">No titles match these filters.<br/><button tabindex="0" id="btnResetFiltersEmpty" class="btn btn-primary tv-focusable" style="margin-top:14px;padding:8px 18px;font-size:13px;" onclick="resetFilterState()" onfocus="playNavSound()">Reset all filters</button></div>';
      return;
    }
    grid.innerHTML = items.map((m) => renderPosterCard(m)).join('');

    // Attach scroll listener for smooth infinite scrolling and window re-hydration
    grid.onscroll = () => {
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 600) {
        if (hasMoreFilterResults && !isLoadingMoreFilter) {
          executeFilterQuery(true);
        }
      } else if (grid.scrollTop <= 200 && windowStartIdx > 0) {
        restorePreviousGridWindow();
      }
    };
  } catch (err) {
    if (countLbl) countLbl.innerText = 'Search error';
    isLoadingMoreFilter = false; pendingFilterDownFrom = null; pendingFilterDownCount = 0;
  }
}

// 3. LIVE TV
let currentLiveTab = 'ALL';
let currentLiveSearch = '';

