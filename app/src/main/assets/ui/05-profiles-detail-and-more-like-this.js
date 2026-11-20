async function saveActiveProfileChanges() {
  playNavSound();
  const wasKids = Boolean(currentActiveProfile.isKids);
  const nameInp = document.getElementById('profNameInput');
  if (nameInp) currentActiveProfile.name = nameInp.value.trim() || currentActiveProfile.name;
  
  try {
    const res = await fetch('/api/profiles/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentActiveProfile.id,
        name: currentActiveProfile.name,
        avatarColor: currentActiveProfile.avatarColor || '#8B5CF6',
        theme: currentActiveProfile.theme || 'purple',
        isKids: (window.pendingKids === true || window.pendingKids === false) ? window.pendingKids : Boolean(currentActiveProfile.isKids),
        pin: lastVerifiedPin
      })
    });
    const d = await res.json();
    if (!d.ok && !d.success) {
      showToast(d.error || 'Failed to update profile');
      return;
    }
    if (d.profile) {
      currentActiveProfile = { ...currentActiveProfile, ...d.profile };
    }
  } catch (e) {
    showToast('Error updating profile');
    return;
  }
  
  const pinUsed = lastVerifiedPin;
  lastVerifiedPin = '';
  applyProfileTheme(currentActiveProfile.theme || 'purple');   // saved: the preview becomes the theme

  const statusLbl = document.getElementById('profSaveStatus');
  if (statusLbl) {
    statusLbl.innerText = '✓ Profile Saved';
    setTimeout(() => { if (statusLbl) statusLbl.innerText = ''; }, 3000);
  }

  // Update profile header pill & sidebar
  updateUserProfileUI();
  window.pendingKids = null;
  if (!wasKids && currentActiveProfile.isKids) {
    // Kids Mode just turned on: remember in-memory only (never in localStorage), then close 18+ and Extras
    const pc = (appStatus && appStatus.parentalControl) || {};
    window.vaultBeforeKids = { adult: !!pc.showAdult, extras: !!pc.showExtras };
    try { localStorage.removeItem('sv_vault_before_kids'); } catch (e) {}
    await lockVault('adult', true);
    await lockVault('extras', true);
    if (['VAULT_18', 'EXTRAS', 'LIVE_TV'].includes(currentTab)) navigateToTab('HOME');
  } else if (wasKids && !currentActiveProfile.isKids && pinUsed) {
    if (window.vaultBeforeKids) {
      // Kids Mode just turned off with the PIN: restore session-only state without persisting to disk
      for (const target of ['adult', 'extras']) {
        if (!window.vaultBeforeKids[target]) continue;
        try { await fetch('/api/parental-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unlock', pin: pinUsed, target }) }); } catch (e) {}
      }
      window.vaultBeforeKids = null;
    }
    try { localStorage.removeItem('sv_vault_before_kids'); } catch (e) {}
  }
  try { await refreshAppStatus(); } catch (e) {}   // the Adult / Extras tabs depend on the saved Kids setting
  renderSidebar();
  showToast('✓ Profile updated');
  
  pushProfileUpdateToWorker(currentActiveProfile);
}

async function switchUserProfile(profileId, pin = '') {
  playNavSound();
  if (typeof ProfileSyncManager !== 'undefined') {
    await ProfileSyncManager.flush();
  }
  try {
    const res = await fetch('/api/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profileId, pin: pin || '' })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 || data.requirePin) {
      openParentalPinModal({
        action: 'verify_only',
        onComplete: (verifiedPin) => switchUserProfile(profileId, verifiedPin)
      });
      return;
    }
    if (res.ok && data.profile) {
      currentActiveProfile = { ...data.profile };
      window.currentActiveProfile = currentActiveProfile;
    }
  } catch (_) {}

  if (typeof ProfileSyncManager !== 'undefined') {
    await ProfileSyncManager.pull(profileId);
  }
  
  localStorage.setItem('sv_last_profile_id', profileId);
  sessionStorage.setItem('sv_session_profile_active', 'true');
  
  // Phase B Rule: Re-lock 18+ Vault on profile switch!
  if (appStatus && appStatus.parentalControl) {
    appStatus.parentalControl.isLocked = true;
    appStatus.parentalControl.showAdult = false;
    appStatus.parentalControl.showExtras = false;
  }
  
  if (currentActiveProfile && currentActiveProfile.theme) {
    applyProfileTheme(currentActiveProfile.theme);
  }
  updateUserProfileUI();
  renderSidebar();
  showToast(`Switched to ${currentActiveProfile?.name || 'profile'}`);
  
  const vp = document.getElementById('mainViewport');
  if (vp && currentTab === 'PROFILE') {
    await loadProfile(vp);
  } else {
    await navigateToTab((currentTab === 'VAULT_18' || currentTab === 'EXTRAS') ? 'HOME' : currentTab);
  }
}

let newProfileAvatarColor = '#7C3AED';
let newProfileIsKids = false;

function selectNewProfileColor(color) {
  playNavSound();
  newProfileAvatarColor = color;
  document.querySelectorAll('.add-prof-color-chip').forEach(c => {
    if (c.getAttribute('data-color') === color) {
      c.style.border = '2.5px solid #FFFFFF';
    } else {
      c.style.border = '1.5px solid rgba(255,255,255,0.2)';
    }
  });
}

function toggleNewProfileKids() {
  playNavSound();
  newProfileIsKids = !newProfileIsKids;
  const btn = document.getElementById('btnAddProfileKidsToggle');
  if (btn) {
    btn.innerText = newProfileIsKids ? 'Enabled' : 'Disabled';
    btn.style.background = newProfileIsKids ? '#059669' : '#262A38';
    btn.style.borderColor = newProfileIsKids ? '#10B981' : '#374151';
    btn.style.color = newProfileIsKids ? '#FFFFFF' : '#9CA3AF';
  }
}

function promptAddNewProfile() {
  playNavSound();
  newProfileAvatarColor = '#7C3AED';
  newProfileIsKids = false;
  const modal = document.getElementById('addProfileModal');
  if (!modal) return;
  const nameInp = document.getElementById('newProfileNameInput');
  if (nameInp) nameInp.value = '';
  const err = document.getElementById('newProfileError');
  if (err) err.innerText = '';
  const kidsBtn = document.getElementById('btnAddProfileKidsToggle');
  if (kidsBtn) {
    kidsBtn.innerText = 'Disabled';
    kidsBtn.style.background = '#262A38';
    kidsBtn.style.borderColor = '#374151';
    kidsBtn.style.color = '#9CA3AF';
  }
  selectNewProfileColor('#7C3AED');
  modal.style.display = 'flex';
  setTimeout(() => {
    if (nameInp) { nameInp.removeAttribute('readonly'); nameInp.focus(); }
  }, 50);
}

function closeAddProfileModal() {
  const modal = document.getElementById('addProfileModal');
  if (modal) modal.style.display = 'none';
  const firstProf = document.querySelector('.profile-card-item');
  if (firstProf) firstProf.focus();
}

async function confirmCreateProfile(pin = '') {
  playNavSound();
  const nameInp = document.getElementById('newProfileNameInput');
  const name = nameInp ? nameInp.value.trim() : '';
  const err = document.getElementById('newProfileError');
  if (!name) {
    if (err) err.innerText = 'Please enter a profile name';
    return;
  }
  
  try {
    const res = await fetch('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        avatarColor: safeColor(newProfileAvatarColor, '#7C3AED'),
        theme: 'purple',
        isKids: newProfileIsKids,
        pin: pin || ''
      })
    });
    const d = await res.json();
    if (!d.ok && !d.success) {
      if (d.status === 403 || res.status === 403) {
        closeAddProfileModal();
        openParentalPinModal({
          action: 'verify_only',
          onComplete: (verifiedPin) => confirmCreateProfile(verifiedPin)
        });
        return;
      }
      if (err) err.innerText = d.error || 'Failed to create profile';
      return;
    }
    
    closeAddProfileModal();
    showToast(`✓ Profile "${name}" created`);
    
    // Mirror to cloud worker in background if authed
    const token = getStoredAuthToken();
    if (token) {
      fetch(CLOUD_SYNC_BASE + '/api/profiles/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ displayName: name, avatarColor: newProfileAvatarColor, theme: 'purple', isKids: newProfileIsKids })
      }).catch(() => null);
    }
    
    const vp = document.getElementById('mainViewport');
    if (vp && currentTab === 'PROFILE') {
      await loadProfile(vp);
    }
  } catch (e) {
    if (err) err.innerText = 'Connection error';
  }
}

function promptDeleteCurrentProfile() {
  playNavSound();
  if (currentActiveProfile.isPrimary) {
    showToast('Primary profile cannot be deleted');
    return;
  }
  const modal = document.getElementById('deleteProfileModal');
  if (!modal) return;
  const nameSpan = document.getElementById('deleteProfileNameSpan');
  if (nameSpan) nameSpan.innerText = `"${currentActiveProfile.name}"`;
  modal.style.display = 'flex';
  setTimeout(() => {
    const cancelBtn = document.getElementById('btnCancelDeleteProfile');
    if (cancelBtn) cancelBtn.focus();
  }, 50);
}

function closeDeleteProfileModal() {
  const modal = document.getElementById('deleteProfileModal');
  if (modal) modal.style.display = 'none';
  const saveBtn = document.getElementById('btnSaveProfile');
  if (saveBtn) saveBtn.focus();
}

async function confirmDeleteProfile(pin = '') {
  playNavSound();
  const idToDelete = currentActiveProfile.id;
  try {
    const res = await fetch('/api/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idToDelete, pin: pin || '' })
    });
    const d = await res.json();
    if (!d.ok && !d.success) {
      if (d.status === 403 || res.status === 403) {
        closeDeleteProfileModal();
        openParentalPinModal({
          action: 'verify_only',
          onComplete: (verifiedPin) => confirmDeleteProfile(verifiedPin)
        });
        return;
      }
      showToast(d.error || 'Failed to delete profile');
      return;
    }
    
    closeDeleteProfileModal();
    showToast('✓ Profile deleted');
    
    // Mirror to worker
    const token = getStoredAuthToken();
    if (token) {
      fetch(CLOUD_SYNC_BASE + '/api/profiles/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ profileId: idToDelete })
      }).catch(() => null);
    }
    
    const vp = document.getElementById('mainViewport');
    if (vp && currentTab === 'PROFILE') {
      await loadProfile(vp);
    }
  } catch (e) {
    showToast('Error deleting profile');
  }
}

async function pushProfileUpdateToWorker(profile) {
  const token = getStoredAuthToken();
  if (!token) return;
  try {
    await fetch(CLOUD_SYNC_BASE + '/api/profiles/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        profileId: profile.id,
        displayName: profile.name,
        avatarColor: profile.avatarColor,
        theme: profile.theme,
        isKids: profile.isKids
      })
    }).catch(() => null);
  } catch (_) {}
}

// 6. DETAIL MODAL WITH BACKGROUND PREVIEW + 5-STAR RATING + SMART RECOMMENDATIONS
let currentMltMode = 'everything';
let currentMltHideWatched = false;

let selectedDetailSeason = 1;

function getDetailActionButtonsHtml(item) {
  const isWatched = Boolean(item.isWatched);
  const hasResume = (item.resumePositionMs && item.resumePositionMs > 30000 && !isWatched);
  const resumeTimeStr = hasResume ? formatTime(item.resumePositionMs / 1000) : '';

  if (item.mediaType === 'SERIES') {
    const firstEp = (item.episodes && item.episodes.length > 0) ? item.episodes[0] : null;
    const epId = firstEp ? firstEp.id : '';
    const epLabel = firstEp ? `S${firstEp.season} E${firstEp.episodeNum}` : 'Episode 1';
    const safeDk = escapeHtml(item.dedupKey);
    const safeEpId = escapeHtml(epId);
    const safeResumeMs = Number(item.resumePositionMs) || 0;

    return `
      <div id="detailActionButtonsContainer" style="display:flex;gap:12px;align-items:center;padding-top:10px;flex-wrap:wrap;">
        ${hasResume ? `
          <button tabindex="0" class="btn btn-primary tv-focusable detail-action-btn js-detail-play" data-dedup-key="${safeDk}" data-ver-idx="0" data-start-ms="${safeResumeMs}" data-ep-id="${safeEpId}" onfocus="playNavSound()">
            ▶ Resume ${escapeHtml(epLabel)}
          </button>
          <button tabindex="0" class="btn tv-focusable detail-action-btn js-detail-play" data-dedup-key="${safeDk}" data-ver-idx="0" data-start-ms="0" data-ep-id="${safeEpId}" onfocus="playNavSound()">
            ↺ Restart
          </button>
        ` : `
          <button tabindex="0" class="btn btn-primary tv-focusable detail-action-btn js-detail-play" data-dedup-key="${safeDk}" data-ver-idx="0" data-start-ms="0" data-ep-id="${safeEpId}" onfocus="playNavSound()">
            ▶ Play ${escapeHtml(epLabel)}
          </button>
        `}
        <button tabindex="0" id="detailWatchlistBtn" class="btn tv-focusable detail-action-btn js-detail-watchlist" data-dedup-key="${safeDk}" onfocus="playNavSound()">
          ${item.inWatchlist ? '✓ In My List' : '+ Add to List'}
        </button>
        <button tabindex="0" id="detailWatchedBtn" class="btn tv-focusable detail-action-btn js-detail-watched ${isWatched ? 'btn-watched-active' : ''}" data-dedup-key="${safeDk}" onfocus="playNavSound()">
          ${isWatched ? '✓ Watched' : 'Mark Watched'}
        </button>
        ${hasResume ? `<span style="font-size:12px;color:var(--theme-border);font-weight:700;margin-left:4px;">(at ${escapeHtml(resumeTimeStr)})</span>` : ''}
      </div>
    `;
  }

  const safeDk = escapeHtml(item.dedupKey);
  const safeResumeMs = Number(item.resumePositionMs) || 0;
  return `
    <div id="detailActionButtonsContainer" style="display:flex;gap:12px;align-items:center;padding-top:10px;flex-wrap:wrap;">
      ${hasResume ? `
        <button tabindex="0" class="btn btn-primary tv-focusable detail-action-btn js-detail-play" data-dedup-key="${safeDk}" data-ver-idx="0" data-start-ms="${safeResumeMs}" onfocus="playNavSound()">
          ▶ Resume
        </button>
        <button tabindex="0" class="btn tv-focusable detail-action-btn js-detail-play" data-dedup-key="${safeDk}" data-ver-idx="0" data-start-ms="0" onfocus="playNavSound()">
          ↺ Restart
        </button>
      ` : `
        <button tabindex="0" class="btn btn-primary tv-focusable detail-action-btn js-detail-play" data-dedup-key="${safeDk}" data-ver-idx="0" data-start-ms="0" onfocus="playNavSound()">
          ▶ Watch Now
        </button>
      `}
      <button tabindex="0" id="detailWatchlistBtn" class="btn tv-focusable detail-action-btn js-detail-watchlist" data-dedup-key="${safeDk}" onfocus="playNavSound()">
        ${item.inWatchlist ? '✓ In My List' : '+ Add to List'}
      </button>
      <button tabindex="0" id="detailWatchedBtn" class="btn tv-focusable detail-action-btn js-detail-watched ${isWatched ? 'btn-watched-active' : ''}" data-dedup-key="${safeDk}" onfocus="playNavSound()">
        ${isWatched ? '✓ Watched' : 'Mark Watched'}
      </button>
      ${hasResume ? `<span style="font-size:12px;color:var(--theme-border);font-weight:700;margin-left:4px;">(at ${escapeHtml(resumeTimeStr)})</span>` : ''}
      ${(item.versions && item.versions.length > 1) ? `
        <div id="detailVersionsContainer" style="display:flex;gap:8px;align-items:center;width:100%;margin-top:6px;flex-wrap:wrap;">
          <span style="font-size:11px;font-weight:700;color:var(--muted);margin-right:2px;">Versions (${item.versions.length}):</span>
          ${item.versions.map((v, vIdx) => {
            const isCam = v.isCam || /\b(CAM|HDCAM|TS|DRAGON MONEY)\b/i.test(v.rawTitle || '');
            const hasStar = (v.rawTitle || '').includes('*');
            const sizeStr = v.fileSizeStr ? ` • ${v.fileSizeStr}` : '';
            let vLabel = '';
            if (isCam) {
              vLabel = `⚠️ CAM Rip (${v.qualityTag || 'CAM'}${sizeStr})`;
            } else if (hasStar || (v.qualityScore && v.qualityScore >= 25)) {
              vLabel = `⭐ Clean HQ* (${v.qualityTag || '1080p'}${sizeStr})`;
            } else {
              vLabel = `Version ${vIdx + 1}: ${v.languageTag || 'Standard'} (${v.qualityTag || 'HD'}${sizeStr})`;
            }
            return `
              <button tabindex="0" class="btn tv-focusable detail-version-pill js-detail-play"
                      style="padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid ${isCam ? '#EF4444' : vIdx === 0 ? 'var(--theme-accent)' : '#2D3345'};background:${isCam ? 'rgba(239,68,68,0.15)' : vIdx === 0 ? 'rgba(var(--theme-accent-rgb),0.2)' : 'rgba(255,255,255,0.05)'};color:${isCam ? '#FCA5A5' : vIdx === 0 ? 'var(--theme-pale)' : '#9CA3AF'};"
                      data-dedup-key="${safeDk}" data-ver-idx="${vIdx}" data-start-ms="0" onfocus="playNavSound()">
                ▶ ${escapeHtml(vLabel)}
              </button>
            `;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderEpisodeCardsHtml(item, season) {
  const eps = (item.episodes || []).filter(e => e.season === season);
  if (eps.length === 0) {
    return '<div style="color:var(--muted);font-size:13px;padding:12px 0;">No episodes found for Season ' + season + '.</div>';
  }
  const safeDk = escapeHtml(item.dedupKey);
  return eps.map(ep => `
    <div tabindex="0" class="episode-card tv-focusable" data-dedup-key="${safeDk}" data-ep-id="${escapeHtml(ep.id)}" onfocus="playNavSound()">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="episode-badge">S${ep.season} E${ep.episodeNum}</span>
        ${ep.durationSecs > 0 ? `<span style="font-size:11px;color:#9CA3AF;font-weight:700;">${Math.round(ep.durationSecs / 60)} min</span>` : ''}
      </div>
      <div>
        <div class="episode-title">${escapeHtml(ep.title || 'Episode ' + ep.episodeNum)}</div>
        <div class="episode-plot">${escapeHtml(ep.plot || 'Play this episode.')}</div>
      </div>
    </div>
  `).join('');
}

function selectSeriesSeason(s) {
  selectedDetailSeason = s;
  playNavSound();
  document.querySelectorAll('.season-pill').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-season') == s || btn.innerText.includes('Season ' + s));
  });
  const strip = document.getElementById('seriesEpisodesStrip');
  if (strip && selectedDetailItem) {
    strip.innerHTML = renderEpisodeCardsHtml(selectedDetailItem, s);
  }
}

function switchDetailLowerTab(tab) {
  playNavSound();
  const epBtn = document.getElementById('tabBtnEpisodes');
  const relBtn = document.getElementById('tabBtnRelated');
  const epStrip = document.getElementById('seriesEpisodesStrip');
  const relStrip = document.getElementById('mltPosterStrip');
  const seasonPills = document.getElementById('seasonPillsContainer');

  if (tab === 'EPISODES') {
    if (epBtn) epBtn.classList.add('active');
    if (relBtn) relBtn.classList.remove('active');
    if (epStrip) epStrip.style.display = 'flex';
    if (relStrip) relStrip.style.display = 'none';
    if (seasonPills) seasonPills.style.display = 'flex';
  } else {
    if (relBtn) relBtn.classList.add('active');
    if (epBtn) epBtn.classList.remove('active');
    if (epStrip) epStrip.style.display = 'none';
    if (relStrip) relStrip.style.display = 'flex';
    if (seasonPills) seasonPills.style.display = 'none';
  }
}

function renderRelatedStripHtml(related, item) {
  if (!related || related.length === 0) {
    return '<div style="color:var(--muted);font-size:13px;padding:12px 0;">No matching titles found under current criteria.</div>';
  }
  if (related.length < 8) return related.map((r) => renderPosterCard(r)).join('');   // fewer than a full row: nothing more to show
  return related.map((r) => renderPosterCard(r)).join('') + `
    <div tabindex="0" class="poster-card show-more-card tv-focusable" data-dedup-key="${escapeHtml(item.dedupKey)}" onfocus="playNavSound()">
      <div class="poster-img-wrap" style="display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(145deg, rgba(var(--theme-deep-rgb),0.36) 0%, var(--card) 100%);border:1px solid rgba(var(--theme-border-rgb),0.35);border-radius:10px;">
        <div style="width:44px;height:44px;border-radius:50%;background:rgba(var(--theme-deep-rgb),0.35);display:flex;align-items:center;justify-content:center;margin-bottom:10px;border:1.5px solid var(--theme-border);box-shadow:0 4px 14px rgba(var(--theme-deep-rgb),0.4);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </div>
        <div style="font-size:14px;font-weight:900;color:#FFFFFF;letter-spacing:0.3px;">Show More</div>
      </div>
    </div>
  `;
}

// Age rating as printed on the badge: "FSK 12" -> "12+", "TV-14" stays, "PG-13" stays
function ageRatingLabel(c) {
  const t = String(c || '').trim();
  const m = t.match(/^(?:FSK|DE|NL|AU|CA|IN|UK)?\s*(\d{1,2})$/i);
  if (m) return m[1] + '+';
  return t;
}

async function openDetailModal(dedupKey, matchMode = null, hideWatched = null) {
  playNavSound();
  if (document.activeElement && !document.getElementById('detailOverlay')?.contains(document.activeElement)) {
    lastContentFocusTarget = document.activeElement;
  }
  if (currentTab === 'SEARCH' && filterState.searchQuery && filterState.searchQuery.trim().length >= 2) {
    saveSearchQuery(filterState.searchQuery);
  }
  if (previewBufferTimeout) clearTimeout(previewBufferTimeout);
  if (matchMode) currentMltMode = matchMode;
  if (hideWatched !== null) currentMltHideWatched = hideWatched;

  const ov = document.getElementById('detailOverlay');
  ov.style.display = 'flex';
  ov.style.padding = '16px 36px 14px 36px';
  ov.innerHTML = `
    <div style="position:relative;z-index:2;height:100%;display:flex;flex-direction:column;justify-content:space-between;max-width:1240px;margin:0 auto;width:100%;">
      <div style="display:flex;gap:28px;align-items:flex-start;">
        <div class="skeleton-box" style="width:170px;height:255px;border-radius:10px;flex-shrink:0;"></div>
        <div id="detailInfoColumn" style="flex:1;min-height:264px;display:flex;flex-direction:column;justify-content:space-between;">
          <div>
            <div class="skeleton-box" style="width:60%;height:32px;margin-bottom:10px;"></div>
            <div class="skeleton-box" style="width:40%;height:20px;margin-bottom:12px;"></div>
            <div class="skeleton-box" style="width:90%;height:14px;margin-bottom:6px;"></div>
            <div class="skeleton-box" style="width:80%;height:14px;margin-bottom:6px;"></div>
            <div class="skeleton-box" style="width:65%;height:14px;margin-bottom:14px;"></div>
          </div>
          <div style="display:flex;gap:12px;">
            <div class="skeleton-box" style="width:130px;height:40px;border-radius:8px;"></div>
            <div class="skeleton-box" style="width:130px;height:40px;border-radius:8px;"></div>
          </div>
        </div>
      </div>
      <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;">
        <div class="skeleton-box" style="width:180px;height:24px;margin-bottom:12px;"></div>
        <div style="display:flex;gap:14px;">
          <div class="skeleton-box" style="width:220px;height:110px;border-radius:10px;"></div>
          <div class="skeleton-box" style="width:220px;height:110px;border-radius:10px;"></div>
          <div class="skeleton-box" style="width:220px;height:110px;border-radius:10px;"></div>
        </div>
      </div>
    </div>
  `;

  try {
    const res = await fetch(`/api/detail?dedupKey=${encodeURIComponent(dedupKey)}&matchMode=${currentMltMode}&hideWatched=${currentMltHideWatched}&fast=1`);
    const data = await res.json();
    if (!data || !data.item) {      // for example a Kids profile opening a title that is not child-rated
      ov.style.display = 'none'; ov.innerHTML = '';
      showToast((data && data.error) || 'Could not open this title.');
      if (lastContentFocusTarget && lastContentFocusTarget.focus) { try { lastContentFocusTarget.focus(); } catch (_) {} }
      return;
    }
    const item = data.item;
    const related = data.related || [];
    selectedDetailItem = item;

    userStarRating = ((appStatus && appStatus.userRatings) || {})[item.dedupKey] || 0;
    const backdrop = safeUrl(item.backdropUrl || item.posterUrl || '');
    const isWatched = Boolean(item.isWatched);
    const isSeries = item.mediaType === 'SERIES';
    const seasons = (item.episodes && item.episodes.length > 0) ? [...new Set(item.episodes.map(e => e.season))].sort((a,b) => a - b) : [1];
    selectedDetailSeason = seasons[0] || 1;
    const seriesTag = isSeries ? (seasons.length > 1 ? `${seasons.length} Seasons` : `Season ${seasons[0] || 1}`) : null;

    let genresToShow = (item.genres && item.genres.length > 0) ? item.genres : [];
    if (genresToShow.length === 0 && item.categoryName) {
      genresToShow = item.categoryName.split(/[\/,|•]/).map(s => s.trim()).filter(Boolean);
    }
    if (genresToShow.length === 0) {
      genresToShow = isSeries ? ['Drama', 'Series'] : ['Feature Film'];
    }
    genresToShow = genresToShow.slice(0, 4);

    ov.innerHTML = `
      <!-- Ambient Fullscreen Blurred Backdrop -->
      <div style="position:fixed;inset:0;${backdrop ? `background-image:url('${backdrop}');` : ''}background-size:cover;background-position:center 20%;filter:brightness(0.18) blur(22px);transform:scale(1.08);z-index:0;pointer-events:none;"></div>
      <div style="position:fixed;inset:0;background:linear-gradient(90deg, var(--bg) 0%, rgba(9,7,20,0.88) 48%, rgba(9,7,20,0.96) 100%);z-index:1;pointer-events:none;"></div>

      <div style="position:relative;z-index:2;height:100%;display:flex;flex-direction:column;justify-content:space-between;max-width:1240px;margin:0 auto;width:100%;">
        <!-- Upper Hero Section: Fits 100% On-Screen with 0 vertical scroll -->
        <div style="display:flex;gap:28px;align-items:flex-start;">
          <div id="detailPosterBox" style="position:relative;width:176px;height:264px;flex-shrink:0;">
            ${safeUrl(item.posterUrl) ? `<img src="${safeUrl(item.posterUrl)}" data-fallback-hide="1" style="width:176px;height:264px;object-fit:cover;border-radius:10px;border:1.5px solid #2B3042;box-shadow:0 12px 30px rgba(0,0,0,0.85);" />` : ''}
            ${isWatched ? `<div style="position:absolute;top:8px;right:8px;background:#10B981;color:#fff;font-size:10px;font-weight:900;padding:2px 7px;border-radius:5px;box-shadow:0 4px 10px rgba(16,185,129,0.5);">✓ Watched</div>` : ''}
          </div>

          <div style="flex:1;min-height:255px;display:flex;flex-direction:column;justify-content:space-between;">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div style="font-size:28px;font-weight:900;margin-bottom:6px;line-height:1.15;letter-spacing:-0.3px;">
                  ${escapeHtml(item.cleanTitle)}
                  ${isSeries ? `<span class="detail-season-tag">${escapeHtml(seriesTag)}</span>` : ''}
                </div>
                <button tabindex="0" id="detailCloseBtn" class="btn-icon-round tv-focusable" style="margin-left:16px;flex-shrink:0;" onclick="closeDetailModal()" title="Close">✕</button>
              </div>

              <div style="display:flex;gap:7px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:8px;flex-wrap:wrap;">
                ${item.certification ? `<span class="badge-age" title="Age rating" style="border:1.5px solid #E5E7EB;color:#F9FAFB;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:900;letter-spacing:0.3px;">${escapeHtml(ageRatingLabel(item.certification))}</span>` : ''}
                <span class="badge-rating" style="padding:2px 7px;font-size:11px;">${item.rating > 0 ? ratingStar(item) + ' ' + ratingText(item, true) : 'Not rated'}</span>
                ${(item.qualityBadges || []).slice(0, 1).map((q) => `<span class="badge-quality" style="padding:2px 7px;font-size:11px;">${escapeHtml(q)}</span>`).join('')}
                <span class="badge-language" style="padding:2px 7px;font-size:11px;">${escapeHtml(item.language || 'English')}</span>
                <span class="badge-audio" style="background:#2E1065;color:var(--theme-pale);border:1px solid var(--theme-deep);padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;">Multi-Audio</span>
                <span class="badge-subtitles" style="padding:2px 7px;font-size:11px;">CC Subtitles</span>
                <span style="color:#9CA3AF;font-weight:700;">${escapeHtml(item.year || '')}</span>
                <span>${!isSeries && item.runtimeMins ? item.runtimeMins + ' min' : (isSeries ? (item.episodes || []).length + ' Episodes' : '')}</span>
                ${genresToShow.map((g) => `<span class="badge-genre-cinema">${escapeHtml(g)}</span>`).join('')}
              </div>

              <!-- 5-Star Interactive Rating Widget -->
              <div id="detailStarRatingRow" class="star-rating-row" style="margin-bottom:8px;">
                <span style="font-size:11px;color:var(--muted);margin-right:6px;">Your Rating:</span>
                ${[1,2,3,4,5].map((s) => `
                  <span tabindex="0" class="star-btn tv-focusable js-detail-star ${userStarRating >= s ? 'gold' : ''}"
                        data-dedup-key="${escapeHtml(item.dedupKey)}" data-star="${s}"
                        title="Click to rate ${s} stars">★</span>
                `).join('')}
                <span id="userRatingLabel" style="font-size:11px;color:#F59E0B;margin-left:8px;font-weight:700;">
                  ${userStarRating > 0 ? userStarRating + '/5 Saved' : 'Rate this'}
                </span>
              </div>

              <div style="font-size:13px;line-height:1.45;color:#D1D5DB;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">
                ${escapeHtml(item.plot || 'No synopsis available.')}
              </div>

              <div style="font-size:12px;color:var(--muted);margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${item.cast && item.cast.length > 0 ? `<span><b>Starring:</b> ${escapeHtml(item.cast.slice(0, 5).join(', '))}</span>` : ''}
                ${item.director ? `<span style="margin-left:14px;"><b>Director:</b> ${escapeHtml(item.director)}</span>` : ''}
              </div>
            </div>

            <!-- Action Buttons Bar -->
            ${getDetailActionButtonsHtml(item)}
          </div>
        </div>

        <!-- Lower Section (Episodes or More Like This) -->
        <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;">
          ${isSeries ? `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <div style="display:flex;gap:10px;align-items:center;">
                <button tabindex="0" class="detail-lower-tab tv-focusable active" id="tabBtnEpisodes" onclick="switchDetailLowerTab('EPISODES')">Episodes (${(item.episodes || []).length})</button>
                <button tabindex="0" class="detail-lower-tab tv-focusable" id="tabBtnRelated" onclick="switchDetailLowerTab('RELATED')">More Like This (${related.length})</button>
              </div>
              <div id="seasonPillsContainer" style="display:flex;gap:8px;align-items:center;">
                ${seasons.map(s => `
                  <button tabindex="0" class="season-pill tv-focusable ${s === selectedDetailSeason ? 'active' : ''}" data-season="${s}">Season ${s}</button>
                `).join('')}
              </div>
            </div>
            <div class="poster-strip" id="seriesEpisodesStrip" style="min-height:115px;">
              ${renderEpisodeCardsHtml(item, selectedDetailSeason)}
            </div>
            <div class="poster-strip" id="mltPosterStrip" style="display:none;min-height:115px;padding:16px 20px 22px 20px;overflow-y:visible;overflow-x:auto;">
              ${renderRelatedStripHtml(related, item)}
            </div>
          ` : `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
              <div style="font-size:18px;font-weight:800;">More Like This</div>
              <div class="mlt-filter-chips">
                <button tabindex="0" class="mlt-chip tv-focusable js-mlt-chip ${currentMltMode === 'everything' ? 'active' : ''}" data-mode="everything" data-dedup-key="${escapeHtml(item.dedupKey)}">Everything</button>
                <button tabindex="0" class="mlt-chip tv-focusable js-mlt-chip ${currentMltMode === 'story' ? 'active' : ''}" data-mode="story" data-dedup-key="${escapeHtml(item.dedupKey)}">Story & Tone</button>
                <button tabindex="0" class="mlt-chip tv-focusable js-mlt-chip ${currentMltMode === 'setting' ? 'active' : ''}" data-mode="setting" data-dedup-key="${escapeHtml(item.dedupKey)}">Setting</button>
                <button tabindex="0" class="mlt-chip tv-focusable js-mlt-chip ${currentMltMode === 'cast_director' ? 'active' : ''}" data-mode="cast_director" data-dedup-key="${escapeHtml(item.dedupKey)}">Cast & Director</button>
                <button tabindex="0" id="mltHideWatchedChip" class="mlt-chip tv-focusable js-mlt-hide-watched ${currentMltHideWatched ? 'active' : ''}" data-dedup-key="${escapeHtml(item.dedupKey)}">Hide Watched</button>
              </div>
            </div>
            <div class="poster-strip" id="mltPosterStrip" style="min-height:115px;padding:16px 20px 22px 20px;overflow-y:visible;overflow-x:auto;">
              ${renderRelatedStripHtml(related, item)}
            </div>
          `}
        </div>
      </div>
    `;

    // "More Like This" is looked up after the screen is already showing
    fetch(`/api/related?dedupKey=${encodeURIComponent(item.dedupKey)}&matchMode=${currentMltMode}&hideWatched=${currentMltHideWatched}&limit=8`)
      .then((r) => r.json())
      .then((d) => {
        if (!d || !Array.isArray(d.items) || !selectedDetailItem || selectedDetailItem.dedupKey !== item.dedupKey) return;
        const strip = document.getElementById('mltPosterStrip');
        if (!strip) return;
        const keep = strip.contains(document.activeElement);
        strip.innerHTML = renderRelatedStripHtml(d.items, item);
        const tb = document.getElementById('tabBtnRelated');
        if (tb) tb.innerText = `More Like This (${d.items.length})`;
        if (keep) { const f = strip.querySelector('.tv-focusable'); if (f) f.focus(); }
      }).catch(() => {});

    // Auto-focus primary action button
    setTimeout(() => {
      const primaryBtn = ov.querySelector('#detailActionButtonsContainer .btn-primary') || ov.querySelector('#detailActionButtonsContainer button');
      if (primaryBtn) {
        primaryBtn.focus();
        playNavSound();
      }
    }, 60);

    // Fast Background Probing of Stream Sizes for Multi-Version Releases
    if (item.versions && item.versions.length > 1) {
      fetch(`/api/probe-versions?dedupKey=${encodeURIComponent(item.dedupKey)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok && Array.isArray(d.versions) && d.versions.length > 1) {
            item.versions = d.versions;
            const vContainer = document.getElementById('detailVersionsContainer');
            if (vContainer) {
              // keep the remote's focus on the same version pill when the row is redrawn with the sizes
              const keepIdx = Array.from(vContainer.querySelectorAll('.detail-version-pill')).indexOf(document.activeElement);
              vContainer.innerHTML = `
                <span style="font-size:11px;font-weight:700;color:var(--muted);margin-right:2px;">Versions (${item.versions.length}):</span>
                ${item.versions.map((v, vIdx) => {
                  const isCam = v.isCam || /\b(CAM|HDCAM|TS|DRAGON MONEY)\b/i.test(v.rawTitle || '');
                  const hasStar = (v.rawTitle || '').includes('*');
                  const sizeStr = v.fileSizeStr ? ` • ${v.fileSizeStr}` : '';
                  let vLabel = '';
                  if (isCam) {
                    vLabel = `⚠️ CAM Rip (${v.qualityTag || 'CAM'}${sizeStr})`;
                  } else if (hasStar || (v.qualityScore && v.qualityScore >= 25)) {
                    vLabel = `⭐ Clean HQ* (${v.qualityTag || '1080p'}${sizeStr})`;
                  } else {
                    vLabel = `Version ${vIdx + 1}: ${v.languageTag || 'Standard'} (${v.qualityTag || 'HD'}${sizeStr})`;
                  }
                  return `
                    <button tabindex="0" class="btn tv-focusable detail-version-pill js-detail-play"
                            style="padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid ${isCam ? '#EF4444' : vIdx === 0 ? 'var(--theme-accent)' : '#2D3345'};background:${isCam ? 'rgba(239,68,68,0.15)' : vIdx === 0 ? 'rgba(var(--theme-accent-rgb),0.2)' : 'rgba(255,255,255,0.05)'};color:${isCam ? '#FCA5A5' : vIdx === 0 ? 'var(--theme-pale)' : '#9CA3AF'};"
                            data-dedup-key="${escapeHtml(item.dedupKey)}" data-ver-idx="${vIdx}" data-start-ms="0" onfocus="playNavSound()">
                      ▶ ${escapeHtml(vLabel)}
                    </button>
                  `;
                }).join('')}
              `;
              if (keepIdx >= 0) { const np = vContainer.querySelectorAll('.detail-version-pill')[keepIdx]; if (np) np.focus(); }
            }
          }
        }).catch(() => {});
    }

  } catch (err) {
    ov.innerHTML = `<div style="padding:40px;color:#EF4444;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function startDetailPreviewBuffer(item) {
  previewBufferTimeout = setTimeout(async () => {
    const ver = (item.versions || [])[0] || { streamId: item.primaryStreamId, containerExtension: 'mp4' };
    const typePart = item.mediaType === 'SERIES' ? 'series' : 'movie';
    const directUrl = await resolveStreamUrl(typePart, ver.streamId, ver.containerExtension || 'mp4', false, item.dedupKey);
    if (!directUrl) return;
    const proxyUrl = `/api/stream-proxy?url=${encodeURIComponent(directUrl)}`;

    const pVideo = document.getElementById('detailPreviewVideo');
    const sImg = document.getElementById('detailStaticBackdrop');
    if (pVideo) {
      pVideo.src = proxyUrl;
      pVideo.oncanplay = () => {
        if (sImg) sImg.style.display = 'none';
        pVideo.style.display = 'block';
        pVideo.play().catch(() => {});
      };
    }
  }, 1200);
}

function closeDetailModal() {
  if (previewBufferTimeout) clearTimeout(previewBufferTimeout);
  const pVideo = document.getElementById('detailPreviewVideo');
  if (pVideo) {
    pVideo.pause();
    pVideo.src = '';
  }
  const ov = document.getElementById('detailOverlay');
  if (ov) {
    ov.style.display = 'none';
    ov.innerHTML = '';
  }
  setTimeout(() => {
    if (lastContentFocusTarget && document.contains(lastContentFocusTarget)) {
      lastContentFocusTarget.focus();
    } else {
      const fallback = document.querySelector('.poster-card, .hero-actions .btn-primary, .nav-btn.active');
      if (fallback) fallback.focus();
    }
  }, 50);
}

// Interactive 5-Star Rating: Click to rate, click again to remove rating!
async function toggleUserRating(dedupKey, stars) {
  playNavSound();
  const targetStars = (userStarRating === stars) ? 0 : stars;
  userStarRating = targetStars;

  document.querySelectorAll('.star-btn').forEach((st, idx) => {
    if (idx < targetStars) st.classList.add('gold');
    else st.classList.remove('gold');
  });

  const lbl = document.getElementById('userRatingLabel');
  const starRow = document.getElementById('detailStarRatingRow');
  if (starRow) starRow.style.background = 'transparent';
  if (lbl) {
    if (targetStars > 0) {
      lbl.innerText = `${targetStars}/5 Saved`;
      lbl.style.color = '#F59E0B';
    } else {
      lbl.innerText = 'Rating removed';
      lbl.style.color = 'var(--muted)';
    }
  }

  try {
    await fetch('/api/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKey, rating: targetStars })
    });
    if (typeof ProfileSyncManager !== 'undefined') {
      ProfileSyncManager.recordChange('ratings', dedupKey, { userRating: targetStars });
    }
    // Dynamically re-rank suggestions based on updated rating!
    await refreshMltStrip(dedupKey);
  } catch (_) {}
}

// Coupled Watched Button: Toggles watched state + immediately prompts rating if unrated
async function toggleWatchedCoupled(dedupKey) {
  playNavSound();
  try {
    const res = await fetch('/api/watched/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKey })
    });
    const d = await res.json();
    if (typeof ProfileSyncManager !== 'undefined' && d.ok) {
      ProfileSyncManager.recordChange('progress', dedupKey, { isWatched: d.isWatched });
    }
    if (selectedDetailItem && selectedDetailItem.dedupKey === dedupKey) {
      selectedDetailItem.isWatched = d.isWatched;
      const wBtn = document.getElementById('detailWatchedBtn');
      if (wBtn) {
        wBtn.innerHTML = d.isWatched ? '✓ Watched' : '👁 Mark Watched';
        if (d.isWatched) wBtn.classList.add('btn-watched-active');
        else wBtn.classList.remove('btn-watched-active');
      }

      // Coupled prompt: If marked watched and not yet rated, animate star widget
      if (d.isWatched && userStarRating === 0) {
        const starRow = document.getElementById('detailStarRatingRow');
        const starLbl = document.getElementById('userRatingLabel');
        if (starRow) {
          starRow.style.transition = 'all 0.3s ease';
          starRow.style.background = 'rgba(245, 158, 11, 0.14)';
          starRow.style.borderRadius = '8px';
          starRow.style.padding = '6px 12px';
        }
        if (starLbl) {
          starLbl.innerText = '★ Rate it now to train recommendations!';
          starLbl.style.color = '#FBBF24';
          starLbl.style.fontWeight = '800';
        }
      }

      if (currentMltHideWatched) {
        await refreshMltStrip(dedupKey);
      }
    }
  } catch (_) {}
}

async function toggleWatchlist(dedupKey) {
  playNavSound();
  try {
    const res = await fetch('/api/watchlist/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKey })
    });
    const d = await res.json();
    if (typeof ProfileSyncManager !== 'undefined' && d.ok) {
      ProfileSyncManager.recordChange('watchlist', dedupKey, { inWatchlist: d.inWatchlist });
    }
    if (selectedDetailItem && selectedDetailItem.dedupKey === dedupKey) {
      selectedDetailItem.inWatchlist = d.inWatchlist;
      const wlBtn = document.getElementById('detailWatchlistBtn');
      if (wlBtn) {
        wlBtn.innerHTML = d.inWatchlist ? '✓ In My List' : '+ Add to My List';
      }
    }
  } catch (_) {}
}

async function changeMltMode(dedupKey, mode) {
  playNavSound();
  currentMltMode = mode;
  document.querySelectorAll('.mlt-chip').forEach(c => {
    if (c.getAttribute('data-mode') === mode) c.classList.add('active');
    else if (c.getAttribute('data-mode')) c.classList.remove('active');
  });
  await refreshMltStrip(dedupKey);
}

async function toggleMltHideWatched(dedupKey) {
  playNavSound();
  currentMltHideWatched = !currentMltHideWatched;
  const chip = document.getElementById('mltHideWatchedChip');
  if (chip) {
    if (currentMltHideWatched) chip.classList.add('active');
    else chip.classList.remove('active');
  }
  await refreshMltStrip(dedupKey);
}

async function refreshMltStrip(dedupKey) {
  const strip = document.getElementById('mltPosterStrip');
  if (!strip) return;
  strip.style.transition = 'opacity 0.2s ease';
  strip.style.opacity = '0.4';
  try {
    const res = await fetch(`/api/detail?dedupKey=${encodeURIComponent(dedupKey)}&matchMode=${currentMltMode}&hideWatched=${currentMltHideWatched}`);
    const data = await res.json();
    const related = data.related || [];
    strip.innerHTML = renderRelatedStripHtml(related, selectedDetailItem || { dedupKey });
  } catch (_) {
  } finally {
    strip.style.opacity = '1';
  }
}

// "Show more" on the detail screen: a full page of the next-best matches (24 at a time), best first.
const mltPageState = { key: '', title: '', offset: 0, hasMore: false, busy: false };

async function openFullMltCatalog(dedupKey) {
  playNavSound();
  const item = selectedDetailItem;
  mltPageState.key = dedupKey;
  mltPageState.title = (item && item.cleanTitle) || 'this title';
  mltPageState.offset = 0;
  mltPageState.hasMore = false;
  closeDetailModal();
  const vp = document.getElementById('mainViewport');
  if (!vp) return;
  vp.innerHTML = `
    <div style="padding:0 0 6px 0;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
        <button tabindex="0" id="mltPageBack" class="btn tv-focusable js-open-detail" style="padding:7px 14px;font-size:12px;" data-dedup-key="${escapeHtml(dedupKey)}">← Back</button>
        <div style="font-size:18px;font-weight:900;color:#fff;">More like ${escapeHtml(mltPageState.title)}</div>
      </div>
      <div id="mltPageNote" style="font-size:11px;color:#9CA3AF;margin-bottom:10px;">Closest matches first.</div>
      <div class="results-grid" id="filterResultsGrid"></div>
    </div>`;
  await loadMltPage(true);
}

