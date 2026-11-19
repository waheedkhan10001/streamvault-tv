function closeResetPinModal() {
  const m = document.getElementById('resetPinModal');
  if (m) m.style.display = 'none';
  const lockBtn = document.getElementById('btnToggleParentalLock') || document.getElementById('btnToggleKidsMode');
  if (lockBtn && lockBtn.offsetParent !== null) lockBtn.focus();
}

// Asks the cloud server to email a 6-digit PIN-reset code to the signed-in account's own address.
async function requestPinResetCode() {
  playNavSound();
  const errLbl = document.getElementById('resetPinErrorMessage');
  const token = getStoredAuthToken();
  if (!token) {
    if (errLbl) { errLbl.innerText = 'Please sign in to your StreamVault account first'; errLbl.style.color = '#EF4444'; }
    return;
  }
  if (errLbl) { errLbl.innerText = 'Sending code...'; errLbl.style.color = 'var(--theme-border)'; }
  try {
    const res = await fetch(CLOUD_SYNC_BASE + '/api/account/request-pin-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: '{}'
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.success) {
      if (errLbl) { errLbl.innerText = 'Code sent to ' + (d.sentTo || 'your email') + '. Enter it below.'; errLbl.style.color = '#10B981'; }
      const box = document.getElementById('resetPinCodeInput');
      if (box) { box.removeAttribute('readonly'); box.focus(); playNavSound(); }
    } else if (errLbl) {
      errLbl.innerText = d.error || 'Could not send the code';
      errLbl.style.color = '#EF4444';
    }
  } catch (err) {
    if (errLbl) { errLbl.innerText = 'Network error: ' + err.message; errLbl.style.color = '#EF4444'; }
  }
}

async function submitResetPin() {
  playNavSound();
  const pwd = (document.getElementById('resetPinPasswordInput')?.value || '').trim();
  const code = (document.getElementById('resetPinCodeInput')?.value || '').trim();
  const newPin = (document.getElementById('resetPinNewInput')?.value || '').trim();
  const errLbl = document.getElementById('resetPinErrorMessage');

  if (!pwd && !code) {
    if (errLbl) errLbl.innerText = 'Enter your account password or the 6-digit code from your email';
    return;
  }
  if (!pwd && !/^\d{6}$/.test(code)) {
    if (errLbl) errLbl.innerText = 'The email code is exactly 6 digits';
    return;
  }
  if (!/^\d{4}$/.test(newPin)) {
    if (errLbl) errLbl.innerText = 'New PIN must be exactly 4 numeric digits';
    return;
  }

  if (errLbl) {
    errLbl.innerText = 'Verifying with cloud server...';
    errLbl.style.color = 'var(--theme-border)';
  }

  try {
    const res = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pwd
        ? { action: 'reset_pin', password: pwd, newPin: newPin }
        : { action: 'reset_pin', code: code, newPin: newPin })
    });
    const d = await res.json();
    if (d.success) {
      showToast('✓ Master PIN reset successfully!');
      closeResetPinModal();
      if (currentTab === 'SETTINGS' || currentTab === 'PROFILE') {
        updateParentalStatusInSettings();
      }
    } else {
      if (errLbl) {
        errLbl.innerText = d.error || 'Failed to reset PIN';
        errLbl.style.color = '#EF4444';
      }
    }
  } catch (err) {
    if (errLbl) {
      errLbl.innerText = `Error: ${err.message}`;
      errLbl.style.color = '#EF4444';
    }
  }
}

// 9. GLOBAL BACK KEY HANDLER (Industry Standard Leanback Navigation)
window.handleAppBackKey = function() {
  // 0. The popup on top always closes first
  const topPopupForBack = getTopPopup();
  if (topPopupForBack && closeTopPopup(topPopupForBack)) return true;

  // 1. Modals
  if (document.getElementById('playlistModal') && document.getElementById('playlistModal').style.display === 'flex') {
    closePlaylistModal();
    return true;
  }
  if (document.getElementById('signOutModal') && document.getElementById('signOutModal').style.display === 'flex') {
    closeSignOutModal();
    return true;
  }
  if (document.getElementById('cloudAuthModal') && document.getElementById('cloudAuthModal').style.display === 'flex') {
    const verifyPane = document.getElementById('cloudAuthVerifyPane');
    if (verifyPane && verifyPane.style.display !== 'none' && verifyPane.style.display !== '') {
      switchCloudAuthPane('form');
    } else {
      closeCloudAuthModal();
    }
    return true;
  }
  if (document.getElementById('addProfileModal') && document.getElementById('addProfileModal').style.display === 'flex') {
    closeAddProfileModal();
    return true;
  }
  if (document.getElementById('deleteProfileModal') && document.getElementById('deleteProfileModal').style.display === 'flex') {
    closeDeleteProfileModal();
    return true;
  }
  if (document.getElementById('deleteHistoryModal') && document.getElementById('deleteHistoryModal').style.display === 'flex') {
    closeDeleteHistoryModal();
    return true;
  }
  if (document.getElementById('clearAllHistoryModal') && document.getElementById('clearAllHistoryModal').style.display === 'flex') {
    closeClearAllHistoryModal();
    return true;
  }
  if (document.getElementById('factoryResetModal') && document.getElementById('factoryResetModal').style.display === 'flex') {
    closeFactoryResetModal();
    return true;
  }
  if (document.getElementById('userProfileModal') && document.getElementById('userProfileModal').style.display === 'flex') {
    closeUserProfileModal();
    const userPill = document.querySelector('.user-profile-pill');
    if (userPill) { userPill.focus(); playNavSound(); }
    return true;
  }
  if (document.getElementById('parentalPinModal') && document.getElementById('parentalPinModal').style.display === 'flex') {
    closeParentalPinModal();
    return true;
  }
  if (document.getElementById('resetPinModal') && document.getElementById('resetPinModal').style.display === 'flex') {
    closeResetPinModal();
    return true;
  }
  if (document.getElementById('voiceSearchModal') && document.getElementById('voiceSearchModal').style.display === 'flex') {
    closeVoiceSearchModal();
    return true;
  }
  if (document.getElementById('playerOverlay') && document.getElementById('playerOverlay').style.display === 'flex') {
    exitPlayer();
    return true;
  }
  if (document.getElementById('detailOverlay') && document.getElementById('detailOverlay').style.display !== 'none') {
    closeDetailModal();
    return true;
  }

  // 2. Open dropdowns
  if (activeDropdownId) {
    const parentPill = document.getElementById(activeDropdownId)?.closest('.filter-pill-wrapper')?.querySelector('.filter-pill-btn');
    closeAllDropdowns();
    if (parentPill) {
      parentPill.focus();
      playNavSound();
    }
    return true;
  }

  // 3. If in main viewport (content, search bar, rows) -> move focus to active tab in sidebar
  // (also when focus was lost, e.g. after the page redrew: Back must never jump to Home or Profile by accident)
  const mainVp = document.getElementById('mainViewport');
  const sidebarEl = document.querySelector('.sidebar');
  const focusOnSidebar = !!(document.activeElement && sidebarEl && sidebarEl.contains(document.activeElement));
  if (mainVp && !focusOnSidebar) {
    // Back from far down the posters: first to the top row, then to the search box, then to the sidebar tab
    const ae = document.activeElement;
    const grid = document.getElementById('filterResultsGrid');
    const searchBox = document.getElementById('filterSearchInput');
    if (grid && ae && grid.contains(ae) && ae.classList && ae.classList.contains('poster-card')) {
      const first = grid.querySelector('.poster-card');
      if (first && first !== ae && Math.abs(ae.offsetTop - first.offsetTop) > 20) {
        first.focus(); tvScrollIntoView(first, { block: 'center' }); playNavSound();
        return true;
      }
    }
    if (searchBox && ae !== searchBox && searchBox.offsetParent !== null && mainVp.contains(ae || mainVp)) {
      searchBox.focus(); tvScrollIntoView(searchBox, { block: 'center' }); playNavSound();
      return true;
    }
    const activeSidebar = getActiveSidebarElement();
    if (activeSidebar) {
      activeSidebar.focus();
      playNavSound();
      return true;
    }
  }

  // 4. If focus is on sidebar, but not on HOME tab button: navigate to HOME and focus homeBtn
  const homeBtn = document.querySelector('.nav-btn[data-tab="HOME"]') || document.querySelector('#navList .nav-btn');
  if (currentTab !== 'HOME' || document.activeElement !== homeBtn) {
    if (currentTab !== 'HOME') {
      navigateToTab('HOME');
    }
    if (homeBtn) {
      homeBtn.focus();
      playNavSound();
    }
    return true;
  }

  // 5. Already on HOME sidebar: return false so Android TV can confirm exit
  return false;
};

// 10. FAST O(1) DIRECT SIBLING & ROW NAVIGATION (Zero Reflow Remote Response)

// Scrolling to the focused card. One press glides; presses in quick succession (a held or fast-tapped arrow) jump straight
// there, because restarting a glide on every press is what made fast scrolling feel stuck.
let lastTvScrollAt = 0;
function tvScrollIntoView(el, opts) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  const now = performance.now();
  const rapid = now - lastTvScrollAt < 260;
  lastTvScrollAt = now;
  el.scrollIntoView(Object.assign({}, opts, { behavior: rapid ? 'auto' : 'smooth' }));
}

let lastContentFocusTarget = null;
// Remember where the person was in each tab, so coming back to a tab lands on the same title (not the first one)
const tabFocusMemory = {};
let navKeyCounter = 0;
function focusKeyOf(el) {
  if (!el) return null;
  if (el.id) return '#' + el.id;
  const dk = el.getAttribute && el.getAttribute('data-dedup-key');
  if (dk) return 'dk:' + dk;
  const oc = el.getAttribute && el.getAttribute('onclick');
  return oc ? 'o:' + oc : null;
}
function rememberTabFocus(el) {
  if (!el || !currentTab) return;
  const k = focusKeyOf(el);
  if (k) tabFocusMemory[currentTab] = k;
}
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('#mainViewport') && t.classList && t.classList.contains('tv-focusable')) rememberTabFocus(t);
});
function findRememberedFocus(keyOverride) {
  const k = keyOverride || tabFocusMemory[currentTab];
  const vp = document.getElementById('mainViewport');
  if (!k || !vp) return null;
  for (const c of vp.querySelectorAll('.tv-focusable')) {
    if (c.offsetParent !== null && focusKeyOf(c) === k) return c;
  }
  return null;
}
let lastMltFocusedCard = null;

function getActiveSidebarElement() {
  if (currentTab === 'PROFILE') {
    return document.getElementById('sidebarUserProfilePill') || document.querySelector('.user-profile-pill');
  }
  if (currentTab === 'SETTINGS') {
    return document.getElementById('sidebarSettingsBtn') || document.querySelector('.settings-icon-btn');
  }
  return document.querySelector(`.nav-btn[data-tab="${currentTab}"]`) ||
         document.querySelector('.nav-btn.active') ||
         document.querySelector('#navList .nav-btn') ||
         document.getElementById('sidebarUserProfilePill');
}

// Every popup that can open over the app. The one on top (highest layer, then latest in the page,
// exactly what is painted in front) owns the remote control: arrows stay inside it and Back closes it.
const POPUP_IDS = ['diagModal', 'playlistModal', 'cloudAuthModal', 'resetPinModal', 'parentalPinModal', 'signOutModal', 'factoryResetModal',
  'userProfileModal', 'addProfileModal', 'deleteProfileModal', 'deleteHistoryModal', 'clearAllHistoryModal', 'voiceSearchModal'];

function getTopPopup() {
  let best = null, bestZ = -Infinity;
  for (const id of POPUP_IDS) {
    const el = document.getElementById(id);
    if (!el || el.style.display !== 'flex') continue;
    const z = parseInt(getComputedStyle(el).zIndex, 10) || 0;
    const later = best && (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (z > bestZ || (z === bestZ && later)) { best = el; bestZ = z; }
  }
  return best;
}

// Back key for the popup on top. Returns true when it handled the key.
function closeTopPopup(el) {
  switch (el.id) {
    case 'cloudAuthModal': {
      const vp = document.getElementById('cloudAuthVerifyPane');
      if (vp && vp.style.display !== 'none' && vp.style.display !== '') switchCloudAuthPane('form'); else closeCloudAuthModal();
      return true;
    }
    case 'diagModal': closeDiagModal(); return true;
    case 'playlistModal': closePlaylistModal(); return true;
    case 'resetPinModal': closeResetPinModal(); return true;
    case 'parentalPinModal': closeParentalPinModal(); return true;
    case 'signOutModal': closeSignOutModal(); return true;
    case 'factoryResetModal': closeFactoryResetModal(); return true;
    case 'userProfileModal': {
      closeUserProfileModal();
      const pill = document.querySelector('.user-profile-pill');
      if (pill) { pill.focus(); playNavSound(); }
      return true;
    }
    case 'addProfileModal': closeAddProfileModal(); return true;
    case 'deleteProfileModal': closeDeleteProfileModal(); return true;
    case 'deleteHistoryModal': closeDeleteHistoryModal(); return true;
    case 'clearAllHistoryModal': closeClearAllHistoryModal(); return true;
    case 'voiceSearchModal': closeVoiceSearchModal(); return true;
  }
  return false;
}

// Sign-in / sign-up popup. Rows are listed in the order they appear on screen; Up/Down change row,
// Left/Right move inside a row. Focus can never leave the popup (it sits above the welcome screen).
// Simple one-field-per-row popups: Up/Down walk the rows in order, Left/Right move inside a button row.
function rowsNavigate(current, key, rows) {
  const go = (id) => { const el = document.getElementById(id); if (el) { el.focus(); playNavSound(); } };
  let r = -1, c = -1;
  const id = current && current.id;
  rows.forEach((row, i) => { const j = row.indexOf(id); if (j !== -1) { r = i; c = j; } });
  if (r === -1) { go(rows[0][0]); return true; }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const nc = c + (key === 'ArrowRight' ? 1 : -1);
    if (nc >= 0 && nc < rows[r].length) go(rows[r][nc]);
    return true;
  }
  const nr = r + (key === 'ArrowDown' ? 1 : -1);
  if (nr >= 0 && nr < rows.length) { const t = rows[nr]; go(t[t.length - 1]); }
  return true;
}

function playlistModalNavigate(current, key) {
  const modal = document.getElementById('playlistModal');
  if (!modal || modal.style.display !== 'flex' || getTopPopup() !== modal) return false;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
  return rowsNavigate(current, key, [['inpPlaylistName'], ['inpPlaylistServer'], ['inpPlaylistUser'], ['inpPlaylistPass'], ['btnCancelPlaylist', 'btnSavePlaylist']]);
}

function cloudAuthNavigate(current, key) {
  const modal = document.getElementById('cloudAuthModal');
  if (!modal || modal.style.display !== 'flex') return false;
  const verifyPane = document.getElementById('cloudAuthVerifyPane');
  const verifyActive = !!verifyPane && verifyPane.style.display !== 'none' && verifyPane.style.display !== '';
  const rows = verifyActive
    ? [['cloudVerifyCodeInput'], ['cloudVerifyBackBtn', 'cloudVerifySubmitBtn'], ['cloudVerifyResendLink']]
    : [].concat(isCloudAuthSignUp ? [['cloudAuthName']] : [], [['cloudAuthEmail'], ['cloudAuthPassword'], ['cloudAuthCancelBtn', 'cloudAuthSubmitBtn'], ['cloudAuthToggleLink']]);
  const go = (id) => { const el = document.getElementById(id); if (el) { el.focus(); playNavSound(); } };

  let r = -1, c = -1;
  const id = current && current.id;
  rows.forEach((row, i) => { const j = row.indexOf(id); if (j !== -1) { r = i; c = j; } });
  if (r === -1) { go(rows[0][0]); return true; }   // focus was lost/outside: bring it back to the first field

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const nc = c + (key === 'ArrowRight' ? 1 : -1);
    if (nc >= 0 && nc < rows[r].length) go(rows[r][nc]);
    return true;
  }
  const nr = r + (key === 'ArrowDown' ? 1 : -1);
  if (nr >= 0 && nr < rows.length) {
    const target = rows[nr];
    go(target[target.length - 1]);   // a button pair is entered on its main button (Create Account / Verify)
  }
  return true;
}

// Profile screen grid. Left box = Profile Customization, right box = Parental Controls & PIN.
function profileScreenNavigate(current, key) {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
  const byId = (ids) => ids.map(id => document.getElementById(id)).filter(e => e && e.offsetParent !== null);
  const chips = Array.from(document.querySelectorAll('.profile-theme-chip')).filter(e => e.offsetParent !== null);
  const left = [byId(['profNameInput']), chips, byId(['btnToggleKidsMode']), byId(['btnDeleteProfile', 'btnSaveProfile'])].filter(r => r.length);
  const right = [byId(['setCurPin', 'setNewPin', 'setConfirmPin', 'btnUpdatePin']), byId(['btnToggleParentalLock']), byId(['btnToggleExtrasLock']), byId(['btnClearHistory'])].filter(r => r.length);
  const cols = [left, right];
  let ci = -1, ri = -1, ki = -1;
  cols.forEach((rows, c) => rows.forEach((row, r) => { const k = row.indexOf(current); if (k !== -1) { ci = c; ri = r; ki = k; } }));
  if (ci === -1) return false;   // profile cards row, sidebar, etc.: normal navigation
  const editing = current.tagName === 'INPUT' && !current.hasAttribute('readonly');
  if (editing && (key === 'ArrowLeft' || key === 'ArrowRight')) return false;   // caret movement while typing
  const go = (el) => { if (el) { el.focus(); tvScrollIntoView(el, { block: 'nearest' }); playNavSound(); } return true; };
  const rows = cols[ci];
  const row = rows[ri];
  if (key === 'ArrowDown') {
    if (ri + 1 < rows.length) return go(rows[ri + 1][0]);   // always the first item of the next row
    return true;   // last row: stay in the box
  }
  if (key === 'ArrowUp') {
    if (ri > 0) return go(rows[ri - 1][0]);
    return false;  // first row: up to the profile cards
  }
  if (key === 'ArrowRight') {
    if (ki + 1 < row.length) return go(row[ki + 1]);
    if (ci === 0 && right.length) return go(right[Math.min(ri, right.length - 1)][0]);
    return true;
  }
  // ArrowLeft
  if (ki > 0) return go(row[ki - 1]);
  if (ci === 1 && left.length) { const lr = left[Math.min(ri, left.length - 1)]; return go(lr[lr.length - 1]); }
  return false;    // left box, first item: on to the sidebar
}

function fastNavigate(current, key) {
  if (!current) return false;
  if (current.closest && current.closest('#mainViewport')) {
    lastContentFocusTarget = current;
  }
  navKeyCounter++;

  // 0.0. Sign-in / sign-up popup (checked first: it is on top of everything else)
  if (cloudAuthNavigate(current, key)) return true;
  if (playlistModalNavigate(current, key)) return true;

  // Settings: Left from Sign Out / Sign In (account box) goes to the IPTV playlist box
  if (key === 'ArrowLeft' && currentTab === 'SETTINGS' && (current.id === 'btnSignOutAccount' || current.id === 'btnOpenCloudSignIn') && !getTopPopup()) {
    const t = document.getElementById('btnAddPlaylistBtn') || document.getElementById('btnFirstRunAddPlaylist');
    if (t) { t.focus(); playNavSound(); return true; }
  }

  // Any other popup on top: it owns the remote. If focus slipped outside it, navigateSpatial pulls it back in,
  // and the overlays underneath (welcome, profile picker, detail "focus trap") must not grab focus back.
  const topPopup = getTopPopup();
  if (topPopup && topPopup.id !== 'playlistModal' && !topPopup.contains(current)) return false;

  // Profile page: both boxes follow a fixed grid, so every arrow goes where the screen shows it on any TV size.
  if (!topPopup && currentTab === 'PROFILE' && profileScreenNavigate(current, key)) return true;

  // 0.1. Welcome Screen Overlay Navigation Flow
  const welcomeOverlay = document.getElementById('welcomeScreenOverlay');
  if (!topPopup && welcomeOverlay && welcomeOverlay.style.display === 'flex') {
    if (!welcomeOverlay.contains(current)) {
      const firstBtn = document.getElementById('welcomeBtnSignIn');
      if (firstBtn) { firstBtn.focus(); playNavSound(); return true; }
    }
    if (current.id === 'welcomeBtnSignIn') {
      if (key === 'ArrowDown') { document.getElementById('welcomeBtnSignUp')?.focus(); playNavSound(); return true; }
      return true;
    }
    if (current.id === 'welcomeBtnSignUp') {
      if (key === 'ArrowUp') { document.getElementById('welcomeBtnSignIn')?.focus(); playNavSound(); return true; }
      return true;
    }
    return true;
  }

  // 0.15. Profile Picker Overlay Navigation Flow
  const pickerOverlay = document.getElementById('profilePickerOverlay');
  if (!topPopup && pickerOverlay && pickerOverlay.style.display === 'flex') {
    const cards = Array.from(pickerOverlay.querySelectorAll('.profile-picker-card'));
    const idx = cards.indexOf(current);
    if (idx === -1) {
      if (cards[0]) { cards[0].focus(); playNavSound(); return true; }
      return true;
    }
    if (key === 'ArrowRight' && idx < cards.length - 1) {
      cards[idx + 1].focus(); playNavSound(); return true;
    }
    if (key === 'ArrowLeft' && idx > 0) {
      cards[idx - 1].focus(); playNavSound(); return true;
    }
    return true;
  }

  // 0.1 Playlist Modal Navigation Flow
  const plModal = document.getElementById('playlistModal');
  if (plModal && plModal.style.display === 'flex') {
    if (!plModal.contains(current)) {
      document.getElementById('inpPlaylistServer')?.focus();
      playNavSound();
      return true;
    }
    if (current.id === 'inpPlaylistName') {
      if (key === 'ArrowDown') { document.getElementById('inpPlaylistServer')?.focus(); playNavSound(); return true; }
      return true;
    }
    if (current.id === 'inpPlaylistServer') {
      if (key === 'ArrowUp') { document.getElementById('inpPlaylistName')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowDown') { document.getElementById('inpPlaylistUser')?.focus(); playNavSound(); return true; }
      return true;
    }
    if (current.id === 'inpPlaylistUser') {
      if (key === 'ArrowUp') { document.getElementById('inpPlaylistServer')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowRight') { document.getElementById('inpPlaylistPass')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowDown') { document.getElementById('btnSavePlaylist')?.focus(); playNavSound(); return true; }
      return true;
    }
    if (current.id === 'inpPlaylistPass') {
      if (key === 'ArrowUp') { document.getElementById('inpPlaylistServer')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowLeft') { document.getElementById('inpPlaylistUser')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowDown') { document.getElementById('btnSavePlaylist')?.focus(); playNavSound(); return true; }
      return true;
    }
    if (current.id === 'btnSavePlaylist') {
      if (key === 'ArrowUp') { document.getElementById('inpPlaylistPass')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowLeft') { (document.getElementById('btnCancelPlaylist') || plModal.querySelector('button[type="button"]'))?.focus(); playNavSound(); return true; }
      return true;
    }
    if (current.id === 'btnCancelPlaylist' || current.closest('button[type="button"]')) {
      if (key === 'ArrowUp') { document.getElementById('inpPlaylistUser')?.focus(); playNavSound(); return true; }
      if (key === 'ArrowRight') { document.getElementById('btnSavePlaylist')?.focus(); playNavSound(); return true; }
      return true;
    }
    return true;
  }

  // 0.5. Detail Modal Navigation Flow
  const detailOverlay = document.getElementById('detailOverlay');
  const isDetailActive = !topPopup && detailOverlay && detailOverlay.style.display !== 'none';
  if (isDetailActive) {
    // Focus Trap: If somehow activeElement is NOT inside detailOverlay, snap it right back!
    if (!detailOverlay.contains(current)) {
      const primaryBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button') ||
                         detailOverlay.querySelector('#detailCloseBtn');
      if (primaryBtn) {
        primaryBtn.focus();
        playNavSound();
        return true;
      }
    }

    // 1. Close Button (X in top right)
    if (current.id === 'detailCloseBtn') {
      if (key === 'ArrowDown') {
        const star = detailOverlay.querySelector('#detailStarRatingRow .star-btn.gold') ||
                     detailOverlay.querySelector('#detailStarRatingRow .star-btn');
        if (star) { star.focus(); playNavSound(); return true; }
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      }
      return true; // Trap Left/Right/Up
    }

    // 2. Star Rating Row
    if (current.classList.contains('star-btn')) {
      const stars = Array.from(detailOverlay.querySelectorAll('#detailStarRatingRow .star-btn'));
      const idx = stars.indexOf(current);
      if (key === 'ArrowUp') {
        const closeBtn = document.getElementById('detailCloseBtn');
        if (closeBtn) { closeBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowDown') {
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowRight' && idx >= 0 && idx < stars.length - 1) {
        stars[idx + 1].focus(); playNavSound(); return true;
      } else if (key === 'ArrowLeft' && idx > 0) {
        stars[idx - 1].focus(); playNavSound(); return true;
      }
      return true;
    }

    // 3. Action Buttons Container (Play / Resume, Restart, Add to List, Mark Watched)
    // (version pills sit inside this container too, but have their own handler below: without this, Down from a pill jumped back to the first pill)
    if (current.closest('#detailActionButtonsContainer') && !current.classList.contains('detail-version-pill')) {
      const btns = Array.from(detailOverlay.querySelectorAll('#detailActionButtonsContainer button.tv-focusable:not(.detail-version-pill)'));
      const idx = btns.indexOf(current);
      if (key === 'ArrowUp') {
        const star = detailOverlay.querySelector('#detailStarRatingRow .star-btn.gold') ||
                     detailOverlay.querySelector('#detailStarRatingRow .star-btn');
        if (star) { star.focus(); playNavSound(); return true; }
        const closeBtn = document.getElementById('detailCloseBtn');
        if (closeBtn) { closeBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowDown') {
        const firstVersionPill = detailOverlay.querySelector('#detailVersionsContainer .detail-version-pill');
        if (firstVersionPill && firstVersionPill.offsetParent !== null) {
          firstVersionPill.focus(); playNavSound(); return true;
        }
        // Lower Tab or Season Pills or Episode Cards or MLT chips
        const epTab = detailOverlay.querySelector('.detail-lower-tab.active') || detailOverlay.querySelector('.detail-lower-tab');
        if (epTab && epTab.offsetParent !== null) {
          epTab.focus(); playNavSound(); return true;
        }
        const seasonPill = detailOverlay.querySelector('.season-pill.active') || detailOverlay.querySelector('.season-pill');
        if (seasonPill && seasonPill.offsetParent !== null) {
          seasonPill.focus(); playNavSound(); return true;
        }
        const firstEp = detailOverlay.querySelector('#seriesEpisodesStrip .episode-card');
        if (firstEp && firstEp.offsetParent !== null) {
          firstEp.focus(); playNavSound(); return true;
        }
        const firstChip = detailOverlay.querySelector('.mlt-filter-chips .mlt-chip');
        if (firstChip && firstChip.offsetParent !== null) {
          firstChip.focus(); playNavSound(); return true;
        }
        const firstMltPoster = detailOverlay.querySelector('#mltPosterStrip .poster-card');
        if (firstMltPoster && firstMltPoster.offsetParent !== null) {
          firstMltPoster.focus(); playNavSound(); return true;
        }
      } else if (key === 'ArrowRight' && idx >= 0 && idx < btns.length - 1) {
        btns[idx + 1].focus(); playNavSound(); return true;
      } else if (key === 'ArrowLeft' && idx > 0) {
        btns[idx - 1].focus(); playNavSound(); return true;
      }
      return true;
    }

    // 3.5. Detail Version Selection Pills
    if (current.classList.contains('detail-version-pill')) {
      const pills = Array.from(detailOverlay.querySelectorAll('#detailVersionsContainer .detail-version-pill'));
      const idx = pills.indexOf(current);
      if (key === 'ArrowUp') {
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button:not(.detail-version-pill)');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowDown') {
        const epTab = detailOverlay.querySelector('.detail-lower-tab.active') || detailOverlay.querySelector('.detail-lower-tab');
        if (epTab && epTab.offsetParent !== null) {
          epTab.focus(); playNavSound(); return true;
        }
        const seasonPill = detailOverlay.querySelector('.season-pill.active') || detailOverlay.querySelector('.season-pill');
        if (seasonPill && seasonPill.offsetParent !== null) {
          seasonPill.focus(); playNavSound(); return true;
        }
        const firstEp = detailOverlay.querySelector('#seriesEpisodesStrip .episode-card');
        if (firstEp && firstEp.offsetParent !== null) {
          firstEp.focus(); playNavSound(); return true;
        }
        const firstChip = detailOverlay.querySelector('.mlt-filter-chips .mlt-chip');
        if (firstChip && firstChip.offsetParent !== null) {
          firstChip.focus(); playNavSound(); return true;
        }
        const firstMltPoster = detailOverlay.querySelector('#mltPosterStrip .poster-card');
        if (firstMltPoster && firstMltPoster.offsetParent !== null) {
          firstMltPoster.focus(); playNavSound(); return true;
        }
      } else if (key === 'ArrowRight' && idx >= 0 && idx < pills.length - 1) {
        pills[idx + 1].focus(); playNavSound(); return true;
      } else if (key === 'ArrowLeft' && idx > 0) {
        pills[idx - 1].focus(); playNavSound(); return true;
      }
      return true;
    }

    // 4. Detail Lower Tabs (Episodes / More Like This)
    if (current.classList.contains('detail-lower-tab')) {
      const tabs = Array.from(detailOverlay.querySelectorAll('.detail-lower-tab'));
      const idx = tabs.indexOf(current);
      if (key === 'ArrowUp') {
        const firstVersionPill = detailOverlay.querySelector('#detailVersionsContainer .detail-version-pill');
        if (firstVersionPill && firstVersionPill.offsetParent !== null) {
          firstVersionPill.focus(); playNavSound(); return true;
        }
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowDown') {
        if (current.id === 'tabBtnEpisodes') {
          const firstEp = detailOverlay.querySelector('#seriesEpisodesStrip .episode-card');
          if (firstEp) { firstEp.focus(); playNavSound(); return true; }
        } else {
          const firstPoster = detailOverlay.querySelector('#mltPosterStrip .poster-card');
          if (firstPoster) { firstPoster.focus(); playNavSound(); return true; }
        }
      } else if (key === 'ArrowRight') {
        if (idx >= 0 && idx < tabs.length - 1) {
          tabs[idx + 1].focus(); playNavSound(); return true;
        } else {
          // Move right to season pills
          const activeSeason = detailOverlay.querySelector('.season-pill.active') || detailOverlay.querySelector('.season-pill');
          if (activeSeason && activeSeason.offsetParent !== null) {
            activeSeason.focus(); playNavSound(); return true;
          }
        }
      } else if (key === 'ArrowLeft' && idx > 0) {
        tabs[idx - 1].focus(); playNavSound(); return true;
      }
      return true;
    }

    // 5. Season Pills (Season 1, Season 2...)
    if (current.classList.contains('season-pill')) {
      const pills = Array.from(detailOverlay.querySelectorAll('.season-pill'));
      const idx = pills.indexOf(current);
      if (key === 'ArrowUp') {
        const firstVersionPill = detailOverlay.querySelector('#detailVersionsContainer .detail-version-pill');
        if (firstVersionPill && firstVersionPill.offsetParent !== null) {
          firstVersionPill.focus(); playNavSound(); return true;
        }
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowDown') {
        const firstEp = detailOverlay.querySelector('#seriesEpisodesStrip .episode-card');
        if (firstEp) { firstEp.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowRight' && idx >= 0 && idx < pills.length - 1) {
        pills[idx + 1].focus(); playNavSound(); return true;
      } else if (key === 'ArrowLeft') {
        if (idx > 0) {
          pills[idx - 1].focus(); playNavSound(); return true;
        } else {
          const activeTab = detailOverlay.querySelector('.detail-lower-tab.active') || detailOverlay.querySelector('.detail-lower-tab');
          if (activeTab) { activeTab.focus(); playNavSound(); return true; }
        }
      }
      return true;
    }

    // 6. Episode Cards in Series Strip
    if (current.classList.contains('episode-card') || current.closest('#seriesEpisodesStrip')) {
      const card = current.classList.contains('episode-card') ? current : current.closest('.episode-card');
      const strip = document.getElementById('seriesEpisodesStrip');
      if (card && strip) {
        const cards = Array.from(strip.querySelectorAll('.episode-card'));
        const idx = cards.indexOf(card);
        if (key === 'ArrowUp') {
          const activeSeason = detailOverlay.querySelector('.season-pill.active') || detailOverlay.querySelector('.season-pill');
          if (activeSeason && activeSeason.offsetParent !== null) {
            activeSeason.focus(); playNavSound(); return true;
          }
          const activeTab = detailOverlay.querySelector('.detail-lower-tab.active') || detailOverlay.querySelector('.detail-lower-tab');
          if (activeTab) { activeTab.focus(); playNavSound(); return true; }
        } else if (key === 'ArrowRight' && idx >= 0 && idx < cards.length - 1) {
          cards[idx + 1].focus(); playNavSound(); scrollStripToCard(strip, cards[idx + 1]); return true;
        } else if (key === 'ArrowLeft' && idx > 0) {
          cards[idx - 1].focus(); playNavSound(); scrollStripToCard(strip, cards[idx - 1]); return true;
        }
      }
      return true;
    }

    // 7. MLT Criteria Chips (Everything, Story & Tone, Setting...)
    if (current.classList.contains('mlt-chip')) {
      const chips = Array.from(detailOverlay.querySelectorAll('.mlt-filter-chips .mlt-chip'));
      const idx = chips.indexOf(current);
      if (key === 'ArrowUp') {
        const firstVersionPill = detailOverlay.querySelector('#detailVersionsContainer .detail-version-pill');
        if (firstVersionPill && firstVersionPill.offsetParent !== null) {
          firstVersionPill.focus(); playNavSound(); return true;
        }
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowDown') {
        const targetPoster = (lastMltFocusedCard && detailOverlay.contains(lastMltFocusedCard) && lastMltFocusedCard.offsetParent !== null)
          ? lastMltFocusedCard
          : detailOverlay.querySelector('#mltPosterStrip .poster-card');
        if (targetPoster) {
          targetPoster.focus();
          playNavSound();
          const strip = document.getElementById('mltPosterStrip');
          if (strip) scrollStripToCard(strip, targetPoster);
          return true;
        }
      } else if (key === 'ArrowRight' && idx >= 0 && idx < chips.length - 1) {
        chips[idx + 1].focus(); playNavSound(); return true;
      } else if (key === 'ArrowLeft' && idx > 0) {
        chips[idx - 1].focus(); playNavSound(); return true;
      }
      return true;
    }

    // 8. MLT Poster Cards Strip
    if (current.closest('#mltPosterStrip')) {
      lastMltFocusedCard = current;
      const strip = document.getElementById('mltPosterStrip');
      const cards = Array.from(strip.querySelectorAll('.poster-card'));
      const idx = cards.indexOf(current);
      if (key === 'ArrowUp') {
        const activeChip = detailOverlay.querySelector('.mlt-filter-chips .mlt-chip.active') ||
                           detailOverlay.querySelector('.mlt-filter-chips .mlt-chip');
        if (activeChip && activeChip.offsetParent !== null) {
          activeChip.focus(); playNavSound(); return true;
        }
        const relTab = document.getElementById('tabBtnRelated');
        if (relTab && relTab.offsetParent !== null) {
          relTab.focus(); playNavSound(); return true;
        }
        const watchBtn = detailOverlay.querySelector('#detailActionButtonsContainer .btn-primary') ||
                         detailOverlay.querySelector('#detailActionButtonsContainer button');
        if (watchBtn) { watchBtn.focus(); playNavSound(); return true; }
      } else if (key === 'ArrowRight' && idx >= 0 && idx < cards.length - 1) {
        cards[idx + 1].focus(); playNavSound(); scrollStripToCard(strip, cards[idx + 1]); return true;
      } else if (key === 'ArrowLeft' && idx > 0) {
        cards[idx - 1].focus(); playNavSound(); scrollStripToCard(strip, cards[idx - 1]); return true;
      }
      return true;
    }

    // Any other focusable within detail modal should not escape
    return true;
  }


  // 1. Dropdown options navigation: keep strictly trapped within active dropdown!
  if (current.classList.contains('dropdown-option') || current.closest('.filter-floating-dropdown')) {
    const dropdown = current.closest('.filter-floating-dropdown');
    if (dropdown) {
      const options = Array.from(dropdown.querySelectorAll('.dropdown-option.tv-focusable, .dropdown-option'));
      const idx = options.indexOf(current);
      if (key === 'ArrowDown') {
        if (idx >= 0 && idx < options.length - 1) {
          options[idx + 1].focus();
tvScrollIntoView(options[idx + 1], { block: 'nearest' });
          playNavSound();
          return true;
        }
        return true; // Trap at bottom
      } else if (key === 'ArrowUp') {
        if (idx > 0) {
          options[idx - 1].focus();
tvScrollIntoView(options[idx - 1], { block: 'nearest' });
          playNavSound();
          return true;
        }
        return true; // Trap at top
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        // Exit dropdown and return focus to parent filter pill button
        const parentPill = dropdown.closest('.filter-pill-wrapper')?.querySelector('.filter-pill-btn');
        closeAllDropdowns();
        if (parentPill) {
          parentPill.focus();
          playNavSound();
        }
        return true;
      }
    }
  }

  // 1.5. Search Bar & Suggestions Navigation (YouTube TV Style)
  if (current.id === 'filterSearchInput') {
    if (key === 'ArrowRight') {
      const searchBtn = document.getElementById('filterSearchBtn');
      if (searchBtn) { searchBtn.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowDown') {
      const firstSug = document.querySelector('.search-suggestion-item');
      if (firstSug && firstSug.offsetParent !== null) { firstSug.focus(); playNavSound(); return true; }
      const firstPill = document.querySelector('.filter-pill-btn');
      if (firstPill && firstPill.offsetParent !== null) { firstPill.focus(); playNavSound(); return true; }
      const firstCard = document.querySelector('#filterResultsGrid .poster-card');
      if (firstCard) { firstCard.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowLeft') {
      const activeNav = getActiveSidebarElement();
      if (activeNav) { activeNav.focus(); playNavSound(); return true; }
    }
  }

  if (current.id === 'filterSearchBtn') {
    if (key === 'ArrowLeft') {
      const inp = document.getElementById('filterSearchInput');
      if (inp) { inp.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowRight') {
      const voiceBtn = document.getElementById('btnVoiceSearch') || current.nextElementSibling;
      if (voiceBtn) { voiceBtn.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowDown') {
      const firstSug = document.querySelector('.search-suggestion-item');
      if (firstSug && firstSug.offsetParent !== null) { firstSug.focus(); playNavSound(); return true; }
      const firstPill = document.querySelector('.filter-pill-btn');
      if (firstPill && firstPill.offsetParent !== null) { firstPill.focus(); playNavSound(); return true; }
      const firstCard = document.querySelector('#filterResultsGrid .poster-card');
      if (firstCard) { firstCard.focus(); playNavSound(); return true; }
    }
  }

  // Live TV Fast Navigation
  if (current.id === 'liveSearchInput') {
    if (key === 'ArrowLeft') {
      const activeNav = getActiveSidebarElement();
      if (activeNav) { activeNav.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowDown') {
      const firstTab = document.querySelector('.live-tab-btn');
      if (firstTab) { firstTab.focus(); playNavSound(); return true; }
    }
  }

  if (current.classList && current.classList.contains('live-tab-btn')) {
    const tabs = Array.from(document.querySelectorAll('.live-tab-btn'));
    const idx = tabs.indexOf(current);
    if (key === 'ArrowLeft') {
      if (idx > 0) {
        tabs[idx - 1].focus(); playNavSound(); return true;
      } else {
        const activeNav = getActiveSidebarElement();
        if (activeNav) { activeNav.focus(); playNavSound(); return true; }
      }
    } else if (key === 'ArrowRight') {
      if (idx >= 0 && idx < tabs.length - 1) {
        tabs[idx + 1].focus(); playNavSound(); return true;
      }
    } else if (key === 'ArrowUp') {
      const inp = document.getElementById('liveSearchInput');
      if (inp) { inp.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowDown') {
      const firstWatchBtn = document.querySelector('#liveGrid .live-channel-card button.tv-focusable');
      if (firstWatchBtn) { firstWatchBtn.focus(); playNavSound(); return true; }
    }
    return true;
  }

  if (current.closest && current.closest('.live-channel-card')) {
    const cards = Array.from(document.querySelectorAll('#liveGrid .live-channel-card'));
    const currentCard = current.closest('.live-channel-card');
    const idx = cards.indexOf(currentCard);
    if (idx >= 0) {
      if (key === 'ArrowLeft') {
        if (idx % 2 === 0) {
          const activeNav = getActiveSidebarElement();
          if (activeNav) { activeNav.focus(); playNavSound(); return true; }
        } else {
          const prevBtn = cards[idx - 1]?.querySelector('button.tv-focusable');
          if (prevBtn) { prevBtn.focus(); playNavSound(); return true; }
        }
      } else if (key === 'ArrowRight') {
        if (idx % 2 === 0 && idx + 1 < cards.length) {
          const nextBtn = cards[idx + 1]?.querySelector('button.tv-focusable');
          if (nextBtn) { nextBtn.focus(); playNavSound(); return true; }
        }
        return true;
      } else if (key === 'ArrowUp') {
        if (idx >= 2) {
          const upBtn = cards[idx - 2]?.querySelector('button.tv-focusable');
          if (upBtn) { upBtn.focus(); playNavSound();tvScrollIntoView(upBtn, { block: 'nearest' }); return true; }
        } else {
          const activeTab = document.querySelector('.live-tab-btn.active') || document.querySelector('.live-tab-btn');
          if (activeTab) { activeTab.focus(); playNavSound(); return true; }
        }
      } else if (key === 'ArrowDown') {
        if (idx + 2 < cards.length) {
          const downBtn = cards[idx + 2]?.querySelector('button.tv-focusable');
          if (downBtn) { downBtn.focus(); playNavSound();tvScrollIntoView(downBtn, { block: 'nearest' }); return true; }
        }
        return true;
      }
    }
    return true;
  }

  if (current.id === 'btnVoiceSearch') {
    if (key === 'ArrowLeft') {
      const searchBtn = document.getElementById('filterSearchBtn');
      if (searchBtn) { searchBtn.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowDown') {
      const firstSug = document.querySelector('.search-suggestion-item');
      if (firstSug && firstSug.offsetParent !== null) { firstSug.focus(); playNavSound(); return true; }
      const firstPill = document.querySelector('.filter-pill-btn');
      if (firstPill && firstPill.offsetParent !== null) { firstPill.focus(); playNavSound(); return true; }
      const firstCard = document.querySelector('#filterResultsGrid .poster-card');
      if (firstCard) { firstCard.focus(); playNavSound(); return true; }
    }
  }

  if (current.classList.contains('search-suggestion-item')) {
    const list = Array.from(document.querySelectorAll('.search-suggestion-item'));
    const idx = list.indexOf(current);
    if (key === 'ArrowDown') {
      if (idx >= 0 && idx < list.length - 1) {
        list[idx + 1].focus(); playNavSound(); return true;
      } else {
        dismissSuggestions();
        const firstPill = document.querySelector('.filter-pill-btn');
        if (firstPill && firstPill.offsetParent !== null) { firstPill.focus(); playNavSound(); return true; }
        const firstCard = document.querySelector('#filterResultsGrid .poster-card');
        if (firstCard) { firstCard.focus(); playNavSound(); return true; }
      }
    } else if (key === 'ArrowUp') {
      if (idx > 0) {
        list[idx - 1].focus(); playNavSound(); return true;
      } else {
        const inp = document.getElementById('filterSearchInput');
        if (inp) { inp.focus(); playNavSound(); return true; }
      }
    } else if (key === 'ArrowLeft') {
      const activeNav = getActiveSidebarElement();
      if (activeNav) { activeNav.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowRight') {
      const btn = document.getElementById('filterSearchBtn');
      if (btn) { btn.focus(); playNavSound(); return true; }
    }
    return true;
  }

  // Modals D-Pad Button Trapping
  if (current.closest('#deleteHistoryModal')) {
    const cancelBtn = document.getElementById('btnCancelDeleteHistory');
    const confirmBtn = document.getElementById('btnConfirmDeleteHistory');
    if (key === 'ArrowRight' && current === cancelBtn) {
      if (confirmBtn) { confirmBtn.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowLeft' && current === confirmBtn) {
      if (cancelBtn) { cancelBtn.focus(); playNavSound(); return true; }
    }
    return true;
  }

  if (current.closest('#clearAllHistoryModal')) {
    const cancelBtn = document.getElementById('btnCancelClearAllHistory');
    const confirmBtn = document.getElementById('btnConfirmClearAllHistory');
    if (key === 'ArrowRight' && current === cancelBtn) {
      if (confirmBtn) { confirmBtn.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowLeft' && current === confirmBtn) {
      if (cancelBtn) { cancelBtn.focus(); playNavSound(); return true; }
    }
    return true;
  }

  if (current.closest('#deleteProfileModal')) {
    const cancelBtn = document.getElementById('btnCancelDeleteProfile');
    const confirmBtn = document.getElementById('btnConfirmDeleteProfile');
    const pinInput = document.getElementById('deleteProfilePinInput');
    if (current === pinInput) {
      if (key === 'ArrowDown') { cancelBtn?.focus(); playNavSound(); return true; }
    } else if (current === cancelBtn) {
      if (key === 'ArrowRight') { confirmBtn?.focus(); playNavSound(); return true; }
      if (key === 'ArrowUp') { pinInput?.focus(); playNavSound(); return true; }
    } else if (current === confirmBtn) {
      if (key === 'ArrowLeft') { cancelBtn?.focus(); playNavSound(); return true; }
      if (key === 'ArrowUp') { pinInput?.focus(); playNavSound(); return true; }
    }
    return true;
  }

if (current.classList.contains('filter-pill-btn')) {
    if (key === 'ArrowRight') {
      const allPills = Array.from(document.querySelectorAll('.filter-pill-row .filter-pill-btn'));
      const idx = allPills.indexOf(current);
      if (idx >= 0 && idx < allPills.length - 1) {
        allPills[idx + 1].focus();
        playNavSound();
        return true;
      }
      return true;
    } else if (key === 'ArrowLeft') {
      const allPills = Array.from(document.querySelectorAll('.filter-pill-row .filter-pill-btn'));
      const idx = allPills.indexOf(current);
      if (idx > 0) {
        allPills[idx - 1].focus();
        playNavSound();
        return true;
      } else {
        const activeNav = getActiveSidebarElement();
        if (activeNav) { activeNav.focus(); playNavSound(); return true; }
      }
      return true;
    } else if (key === 'ArrowUp') {
      const inp = document.getElementById('filterSearchInput');
      if (inp) { inp.focus(); playNavSound(); return true; }
    } else if (key === 'ArrowDown') {
      const firstCard = document.querySelector('#filterResultsGrid .poster-card');
      if (firstCard) { firstCard.focus(); playNavSound();tvScrollIntoView(firstCard, { block: 'nearest' }); return true; }
    }
  }

  // 1.8. Hero Billboard Action Buttons (Home Screen)
  if (current.closest && current.closest('.hero-actions')) {
    const heroActions = current.closest('.hero-actions');
    const heroButtons = Array.from(heroActions.querySelectorAll('.btn'));
    const idx = heroButtons.indexOf(current);

    if (key === 'ArrowRight' && idx >= 0 && idx < heroButtons.length - 1) {
      heroButtons[idx + 1].focus();
      playNavSound();
      return true;
    } else if (key === 'ArrowLeft') {
      if (idx > 0) {
        heroButtons[idx - 1].focus();
        playNavSound();
        return true;
      } else {
        const activeNav = getActiveSidebarElement();
        if (activeNav) {
          activeNav.focus();
          playNavSound();
          return true;
        }
      }
      return true;
    } else if (key === 'ArrowDown') {
      const firstCard = document.querySelector('.row-section .poster-card');
      if (firstCard) {
        firstCard.focus();
        playNavSound();
tvScrollIntoView(firstCard, { block: 'nearest' });
        return true;
      }
      return true;
    } else if (key === 'ArrowUp') {
      const vp = document.getElementById('mainViewport');
      if (vp) vp.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    }
  }

  // 2. Poster strip (horizontal movie row): instant O(1) Left/Right sibling navigation
  if (current.classList.contains('poster-card')) {
    const strip = current.closest('.poster-strip');
    if (strip) {
      if (key === 'ArrowRight') {
        const next = current.nextElementSibling;
        if (next && next.classList.contains('poster-card')) {
          next.focus();
          playNavSound();
          scrollStripToCard(strip, next);
          return true;
        }
        return true;
      } else if (key === 'ArrowLeft') {
        const prev = current.previousElementSibling;
        if (prev && prev.classList.contains('poster-card')) {
          prev.focus();
          playNavSound();
          scrollStripToCard(strip, prev);
          return true;
        } else {
          // At beginning of row, Left jumps back to active sidebar tab
          const activeNav = getActiveSidebarElement();
          if (activeNav) {
            activeNav.focus();
            playNavSound();
            return true;
          }
        }
        return true;
      } else if (key === 'ArrowDown') {
        // Move to next row
        const currentRow = current.closest('.row-section') || current.closest('.content-row') || strip.parentElement;
        let nextRow = currentRow ? currentRow.nextElementSibling : null;
        while (nextRow && !nextRow.querySelector('.poster-card')) {
          nextRow = nextRow.nextElementSibling;
        }
        if (nextRow) {
          const targetCard = nextRow.querySelector('.poster-card');
          if (targetCard) {
            targetCard.focus();
            playNavSound();
tvScrollIntoView(targetCard, { block: 'nearest' });
            return true;
          }
        }
        return true;
      } else if (key === 'ArrowUp') {
        // Move to previous row
        const currentRow = current.closest('.row-section') || current.closest('.content-row') || strip.parentElement;
        let prevRow = currentRow ? currentRow.previousElementSibling : null;
        while (prevRow && !prevRow.querySelector('.poster-card')) {
          prevRow = prevRow.previousElementSibling;
        }
        if (prevRow) {
          const targetCard = prevRow.querySelector('.poster-card');
          if (targetCard) {
            targetCard.focus();
            playNavSound();
tvScrollIntoView(targetCard, { block: 'nearest' });
            return true;
          }
        } else {
          // At top row: jump to hero action button or search bar if present
          const heroBtn = document.querySelector('.hero-actions .btn-primary, .hero-btn, #filterSearchInput');
          if (heroBtn) {
            heroBtn.focus({ preventScroll: false });
            playNavSound();
            const heroEl = document.querySelector('.hero');
            if (heroEl) tvScrollIntoView(heroEl, { block: 'start' });
            const vp = document.getElementById('mainViewport');
            if (vp) vp.scrollTo({ top: 0, behavior: 'smooth' });
            return true;
          }
        }
        return true;
      }
    }
  }



  // 3. Sidebar Nav Buttons: instant O(1) Up/Down sibling navigation with auto-activation
  if (current.classList.contains('nav-btn')) {
    if (key === 'ArrowDown') {
      const next = current.nextElementSibling;
      if (next && next.classList.contains('nav-btn')) {
        sidebarFocusThenOpen(next);
        return true;
      } else {
        // At end of nav list: move to bottom user profile pill
        const userPill = document.querySelector('.user-profile-pill');
        if (userPill) {
          userPill.focus();
          playNavSound();
          return true;
        }
      }
    } else if (key === 'ArrowUp') {
      const prev = current.previousElementSibling;
      if (prev && prev.classList.contains('nav-btn')) {
        sidebarFocusThenOpen(prev);
        return true;
      }
      return true; // Strictly stop at top of sidebar (Home). Do not bubble or scroll right!
    } else if (key === 'ArrowRight') {
      if (sidebarOpenTimer) {   // the tab was still waiting for the pause: open it now and land on its first title
        const pendingTab = current.getAttribute('data-tab');
        clearTimeout(sidebarOpenTimer); sidebarOpenTimer = null;
        if (pendingTab && pendingTab !== currentTab) { navigateToTab(pendingTab, null, true); return true; }
      }
      // Jump into content area, restoring last focused element if valid
      if (lastContentFocusTarget && document.body.contains(lastContentFocusTarget) && lastContentFocusTarget.offsetParent !== null) {
        lastContentFocusTarget.focus();
tvScrollIntoView(lastContentFocusTarget, { block: 'nearest' });
        playNavSound();
        return true;
      }
      const remembered = findRememberedFocus();
      if (remembered) { remembered.focus(); tvScrollIntoView(remembered, { block: 'nearest' }); playNavSound(); return true; }
      const firstTarget = document.querySelector('#mainViewport .hero-actions .btn-primary, #mainViewport .filter-pill-btn, #mainViewport .poster-card, #mainViewport button.tv-focusable, #mainViewport input');
      if (firstTarget) {
        firstTarget.focus();
        playNavSound();
        return true;
      }
    }
  }



  // 4. Sidebar Bottom Controls (User Profile Pill & Settings Icon)
  if (current.classList.contains('user-profile-pill') || current.id === 'sidebarUserProfilePill') {
    if (key === 'ArrowDown') {
      const settingsBtn = document.getElementById('sidebarSettingsBtn') || document.querySelector('.settings-icon-btn');
      if (settingsBtn) {
        settingsBtn.focus();
        playNavSound();
        return true;
      }
      return true;
    } else if (key === 'ArrowRight') {
      if (currentTab === 'PROFILE') {
        if (lastContentFocusTarget && document.body.contains(lastContentFocusTarget) && lastContentFocusTarget.offsetParent !== null && document.getElementById('mainViewport')?.contains(lastContentFocusTarget)) {
          lastContentFocusTarget.focus();
tvScrollIntoView(lastContentFocusTarget, { block: 'nearest' });
          playNavSound();
          return true;
        }
        const target = document.querySelector('#mainViewport .profile-card-item, #mainViewport .tv-focusable, #mainViewport input, #mainViewport button');
        if (target) {
          target.focus();
          playNavSound();
          return true;
        }
      }
      const settingsBtn = document.getElementById('sidebarSettingsBtn') || document.querySelector('.settings-icon-btn');
      if (settingsBtn) {
        settingsBtn.focus();
        playNavSound();
        return true;
      }
    } else if (key === 'ArrowUp') {
      const navButtons = document.querySelectorAll('#navList .nav-btn');
      if (navButtons.length > 0) {
        navButtons[navButtons.length - 1].focus();
        playNavSound();
        return true;
      }
    }
    return true;
  }

  if (current.classList.contains('settings-icon-btn') || current.id === 'sidebarSettingsBtn') {
    if (key === 'ArrowDown') {
      return true; // Strictly stop at bottom of sidebar
    } else if (key === 'ArrowLeft') {
      const userPill = document.getElementById('sidebarUserProfilePill') || document.querySelector('.user-profile-pill');
      if (userPill) {
        userPill.focus();
        playNavSound();
        return true;
      }
    } else if (key === 'ArrowRight') {
      if (lastContentFocusTarget && document.body.contains(lastContentFocusTarget) && lastContentFocusTarget.offsetParent !== null && document.getElementById('mainViewport')?.contains(lastContentFocusTarget)) {
        lastContentFocusTarget.focus();
tvScrollIntoView(lastContentFocusTarget, { block: 'nearest' });
        playNavSound();
        return true;
      }
      const target = document.querySelector('#mainViewport .tv-focusable, #mainViewport button, #mainViewport input');
      if (target) {
        target.focus();
        playNavSound();
        return true;
      }
    } else if (key === 'ArrowUp') {
      const userPill = document.getElementById('sidebarUserProfilePill') || document.querySelector('.user-profile-pill');
      if (userPill) {
        userPill.focus();
        playNavSound();
        return true;
      }
      const navButtons = document.querySelectorAll('#navList .nav-btn');
      if (navButtons.length > 0) {
        navButtons[navButtons.length - 1].focus();
        playNavSound();
        return true;
      }
    }
    return true;
  }

  // 5. Results Grid in Search / Movies:
  if (current.closest('.results-grid')) {
    const grid = current.closest('.results-grid');
    const cards = Array.from(grid.querySelectorAll('.poster-card'));
    const idx = cards.indexOf(current);
    if (idx >= 0) {
      const cols = getGridColumns(grid);

      if (key === 'ArrowRight') {
        if (idx < cards.length - 1) {
          cards[idx + 1].focus();
          playNavSound();
tvScrollIntoView(cards[idx + 1], { block: 'nearest' });
          return true;
        }
      } else if (key === 'ArrowLeft') {
        if (idx % cols === 0) {
          const activeNav = getActiveSidebarElement();
          if (activeNav) {
            activeNav.focus();
            playNavSound();
            return true;
          }
        } else if (idx > 0) {
          cards[idx - 1].focus();
          playNavSound();
tvScrollIntoView(cards[idx - 1], { block: 'nearest' });
          return true;
        }
      } else if (key === 'ArrowDown') {
        // start loading well before the bottom (8 rows ahead) so fast scrolling does not catch up with the loaded titles
        if (idx >= cards.length - (cols * 8) && hasMoreFilterResults && !isLoadingMoreFilter) {
          executeFilterQuery(true);
        }
        if (idx + cols >= cards.length && hasMoreFilterResults) {
          // the next titles are still arriving: remember this press and move down as soon as they are here
          pendingFilterDownFrom = current; pendingFilterDownCount++;
          playNavSound();
          return true;
        }
        if (idx + cols < cards.length) {
          cards[idx + cols].focus();
          playNavSound();
tvScrollIntoView(cards[idx + cols], { block: 'nearest' });
          return true;
        } else if (idx < cards.length - 1) {
          cards[cards.length - 1].focus();
          playNavSound();
tvScrollIntoView(cards[cards.length - 1], { block: 'nearest' });
          return true;
        } else {
          // Strictly clamp focus at the bottom of the grid. Prevent falling through to sidebar settings!
          playNavSound();
          return true;
        }
      } else if (key === 'ArrowUp') {
        if (idx - cols >= 0) {
          cards[idx - cols].focus();
          playNavSound();
tvScrollIntoView(cards[idx - cols], { block: 'nearest' });
          return true;
        } else {
          // On top visible row: if windowStartIdx > 0, restore previous window batch!
          if (windowStartIdx > 0) {
            const restored = restorePreviousGridWindow();
            if (restored) {
              const freshCards = Array.from(grid.querySelectorAll('.poster-card'));
              const targetIdx = Math.max(0, Math.min(freshCards.length - 1, (BATCH_SIZE - cols) + (idx % cols)));
              if (freshCards[targetIdx]) {
                freshCards[targetIdx].focus();
                playNavSound();
tvScrollIntoView(freshCards[targetIdx], { block: 'nearest' });
                return true;
              }
            }
          }
          const pill = document.querySelector('.filter-pill-btn') || document.getElementById('filterSearchInput');
          if (pill) {
            pill.focus();
            playNavSound();
            return true;
          }
        }
      }
    }
  }

  return false;
}

