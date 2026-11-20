let checkResultWatcher = false;
// After "Check for new titles": wait for the check to end, then say what it found
async function announceCheckResult() {
  if (checkResultWatcher) return;
  checkResultWatcher = true;
  try {
    let started = false;
    for (let i = 0; i < 900; i++) {   // up to ~30 min
      await new Promise((r) => setTimeout(r, 2000));
      await refreshSyncStatusOnly();
      const sync = (appStatus && appStatus.syncStatus) || {};
      if (sync.isSyncing) { started = true; continue; }
      if (!started && i < 4) continue;   // give it a few seconds to start
      if (sync.error) { showToast("⚠ Check failed: " + String(sync.error), 8000); }
      else showToast('✓ ' + String(sync.note || 'Your catalog is up to date.'), 8000);
      break;
    }
  } catch (_) {} finally { checkResultWatcher = false; }
}

async function triggerFullEnrichmentSync() {
  playNavSound();
  await refreshAppStatus();
  if (!hasActivePlaylist()) {
    showToast('No working IPTV playlist to check. Add one under IPTV Playlists first.');
    return;
  }
  try {
    const res = await fetch('/api/sync-now', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (d && d.ok === false) { showToast(d.error || 'Could not check for new titles'); return; }
    showToast('✓ Checking for new titles. Only new titles are fetched.');
    await refreshAppStatus();
    watchPlaylistStatus();
    announceCheckResult();
  } catch (_) {
    showToast('Could not check for new titles. Please try again.');
  }
}


// TV Remote & Soft Keyboard Auto-Advance and Spatial Navigation for Text Boxes
function advanceToNextInput(currentInput) {
  if (!currentInput) return false;

  // Parental PIN sequence
  if (currentInput.id === 'setCurPin') {
    const next = document.getElementById('setNewPin');
    if (next) { next.removeAttribute('readonly'); next.focus(); playNavSound(); return true; }
  } else if (currentInput.id === 'setNewPin') {
    const next = document.getElementById('setConfirmPin');
    if (next) { next.removeAttribute('readonly'); next.focus(); playNavSound(); return true; }
  } else if (currentInput.id === 'setConfirmPin') {
    const btn = document.getElementById('btnUpdatePin');
    if (btn) { btn.focus(); playNavSound(); return true; }
  }

  // IPTV credentials popup: after Password, OK goes to Save & Connect (never Cancel)
  if (currentInput.id === 'inpPlaylistPass') {
    const btn = document.getElementById('btnSavePlaylist');
    if (btn) { btn.focus(); playNavSound(); return true; }
  }

  // Cloud sign-in popup: after the last field, OK goes to the main button (never Cancel/Back)
  if (currentInput.id === 'cloudAuthPassword') {
    const btn = document.getElementById('cloudAuthSubmitBtn');
    if (btn) { btn.focus(); playNavSound(); return true; }
  } else if (currentInput.id === 'cloudVerifyCodeInput') {
    const btn = document.getElementById('cloudVerifySubmitBtn');
    if (btn) { btn.focus(); playNavSound(); return true; }
  }

  // Fallback: search for next input/button inside container
  const container = currentInput.closest('.settings-card, .modal-card, form, #settings') || document;
  const list = Array.from(container.querySelectorAll('input:not([type="hidden"]), select, textarea, button, .tv-focusable'));
  const idx = list.indexOf(currentInput);
  if (idx !== -1 && idx < list.length - 1) {
    const nextEl = list[idx + 1];
    nextEl.removeAttribute('readonly');
    nextEl.focus();
    playNavSound();
    return true;
  }
  return false;
}

function moveToPreviousInput(currentInput) {
  if (!currentInput) return false;

  // Parental PIN sequence
  if (currentInput.id === 'setConfirmPin') {
    const prev = document.getElementById('setNewPin');
    if (prev) { prev.removeAttribute('readonly'); prev.focus(); playNavSound(); return true; }
  } else if (currentInput.id === 'setNewPin') {
    const prev = document.getElementById('setCurPin');
    if (prev) { prev.removeAttribute('readonly'); prev.focus(); playNavSound(); return true; }
  }
  return false;
}

function onPinInput(el) {
  el.value = el.value.replace(/\D/g, '');
  if (el.value.length >= 4) {
    if (el.id === 'setCurPin') {
      const next = document.getElementById('setNewPin');
      if (next) { next.removeAttribute('readonly'); next.focus(); playNavSound(); }
    } else if (el.id === 'setNewPin') {
      const next = document.getElementById('setConfirmPin');
      if (next) { next.removeAttribute('readonly'); next.focus(); playNavSound(); }
    } else if (el.id === 'setConfirmPin') {
      const next = document.getElementById('btnUpdatePin');
      if (next) { next.focus(); playNavSound(); }
    }
  }
}

function onInputKeyDown(el, event) {
  const isEnter = event.key === 'Enter' || event.keyCode === 13 || event.key === 'Select';
  const isBack = event.key === 'Backspace' || event.keyCode === 8;

  // Up from the display name goes to the active profile box (not the nearest one, which was "Add Profile")
  if ((event.key === 'ArrowUp' || event.keyCode === 38) && el.id === 'profNameInput') {
    const act = document.querySelector('.profile-card-item.is-active-profile');
    if (act) { event.preventDefault(); event.stopPropagation(); act.focus(); return; }
  }

  if (isEnter) {
    event.preventDefault();
    if (el.id === 'setConfirmPin') {
      const btn = document.getElementById('btnUpdatePin');
      if (btn) btn.focus();
    } else {
      advanceToNextInput(el);
    }
  } else if (isBack && el.value.length === 0) {
    if (moveToPreviousInput(el)) event.preventDefault();
  }
}

async function changeParentalPin() {
  playNavSound();
  const cur = document.getElementById('setCurPin').value.trim();
  const n1 = document.getElementById('setNewPin').value.trim();
  const n2 = document.getElementById('setConfirmPin').value.trim();
  const statusLbl = document.getElementById('pinChangeStatus');

  if (cur.length !== 4) {
    if (statusLbl) { statusLbl.innerText = 'Current PIN must be 4 digits'; statusLbl.style.color = '#EF4444'; }
    return;
  }
  if (n1.length !== 4 || isNaN(n1)) {
    if (statusLbl) { statusLbl.innerText = 'New PIN must be 4 numeric digits'; statusLbl.style.color = '#EF4444'; }
    return;
  }
  if (n1 !== n2) {
    if (statusLbl) { statusLbl.innerText = 'New PIN and Confirm PIN do not match'; statusLbl.style.color = '#EF4444'; }
    return;
  }

  try {
    const res = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_pin', pin: cur, newPin: n1 })
    });
    const d = await res.json();
    if (d.success) {
      syncPinToCloud(d, { currentPin: cur }); // changing a PIN: cloud wants proof of the old one
      if (statusLbl) { statusLbl.innerText = 'PIN updated successfully!'; statusLbl.style.color = '#10B981'; }
      document.getElementById('setCurPin').value = '';
      document.getElementById('setNewPin').value = '';
      document.getElementById('setConfirmPin').value = '';
    } else {
      if (statusLbl) { statusLbl.innerText = d.error || 'Failed to update PIN'; statusLbl.style.color = '#EF4444'; }
    }
  } catch (err) {
    if (statusLbl) { statusLbl.innerText = `Error: ${err.message}`; statusLbl.style.color = '#EF4444'; }
  }
}

function openFactoryResetModal() {
  playNavSound();
  const m = document.getElementById('factoryResetModal');
  if (m) {
    m.style.display = 'flex';
    // Land on the SAFE button: before, focus stayed on a button behind the popup, so pressing OK would have used that one
    setTimeout(() => document.getElementById('btnCancelReset')?.focus(), 40);
  }
}

function updateUserProfileUI() {
  const creds = (appStatus && appStatus.credentials) || {};
  const name = currentActiveProfile?.name || getAccountDisplayName();
  const pillName = document.querySelector('.user-profile-name');
  if (pillName) pillName.innerText = name;
  const initial = (name[0] || 'U').toUpperCase();
  const avatarInit = document.getElementById('userProfileAvatarInitial');
  if (avatarInit) avatarInit.innerText = initial;
  const modalName = document.getElementById('userProfileModalName');
  if (modalName) modalName.innerText = name;
  const modalUser = document.getElementById('userProfileModalIptvUser');
  if (modalUser) modalUser.innerText = creds.username || '—';
  const modalServer = document.getElementById('userProfileModalIptvServer');
  if (modalServer) {
    if (creds.serverUrl) {
      try {
        modalServer.innerText = new URL(creds.serverUrl).host;
      } catch (_) {
        modalServer.innerText = creds.serverUrl;
      }
    } else {
      modalServer.innerText = 'No server configured';
    }
  }
}

function openUserProfileModal() {
  playNavSound();
  updateUserProfileUI();
  const m = document.getElementById('userProfileModal');
  if (m) {
    m.style.display = 'flex';
    setTimeout(() => {
      const firstBtn = m.querySelector('button.tv-focusable');
      if (firstBtn) {
        firstBtn.focus();
        playNavSound();
      }
    }, 40);
  }
}

function closeUserProfileModal() {
  playNavSound();
  const m = document.getElementById('userProfileModal');
  if (m) m.style.display = 'none';
  const pill = document.querySelector('.user-profile-pill');
  if (pill) pill.focus();
}

function switchProfileFlow() {
  playNavSound();
  closeUserProfileModal();
  navigateToTab('SETTINGS');
}

function showToast(msg, durationMs = 3200) {
  let toast = document.getElementById('tvToastNotification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tvToastNotification';
    toast.style.cssText = 'position:fixed;bottom:36px;left:50%;transform:translateX(-50%);background:#1A1333;border:1.5px solid var(--theme-border);border-radius:30px;padding:11px 26px;font-size:13.5px;font-weight:800;color:#FFFFFF;box-shadow:0 12px 36px rgba(0,0,0,0.85);z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.25s ease,transform 0.25s ease;display:flex;align-items:center;gap:10px;';
    document.body.appendChild(toast);
  }
  toast.textContent = String(msg == null ? '' : msg);
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  if (window._toastTimer) clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(12px)';
  }, durationMs);
}

function closeFactoryResetModal() {
  playNavSound();
  const m = document.getElementById('factoryResetModal');
  if (m) m.style.display = 'none';
  const confirmView = document.getElementById('factoryResetConfirmView');
  const progressView = document.getElementById('factoryResetProgressView');
  if (confirmView && progressView) {
    confirmView.style.display = 'block';
    progressView.style.display = 'none';
  }
}

async function confirmFactoryReset() {
  playNavSound();
  const confirmView = document.getElementById('factoryResetConfirmView');
  const progressView = document.getElementById('factoryResetProgressView');
  if (confirmView && progressView) {
    confirmView.style.display = 'none';
    progressView.style.display = 'block';
  }
  try {
    localStorage.clear();
    const res = await fetch('/api/factory-reset', { method: 'POST' });
    const d = await res.json();
    setTimeout(async () => {
      closeFactoryResetModal();
      showToast('✓ Factory Reset Complete — TV restored to default state');
      const sRes = await fetch('/api/state');
      appStatus = await sRes.json();
      showWelcomeScreen();
    }, 700);
  } catch (err) {
    closeFactoryResetModal();
    showToast(`Error: ${err.message}`);
  }
}


let isCloudAuthSignUp = false;
let cloudAuthOpenerId = null;

// First field on the form: Display Name when creating an account, otherwise Email
function focusCloudAuthFirstField() {
  const id = isCloudAuthSignUp ? 'cloudAuthName' : 'cloudAuthEmail';
  document.getElementById(id)?.focus();
}
let currentPendingVerifyEmail = '';

function openCloudAuthModal(mode = 'login') {
  playNavSound();
  isCloudAuthSignUp = (mode === 'signup');
  cloudAuthOpenerId = document.activeElement && document.activeElement.id ? document.activeElement.id : null;
  const m = document.getElementById('cloudAuthModal');
  if (!m) return;
  m.style.display = 'flex';
  switchCloudAuthPane('form');
  updateCloudAuthUi();
}

function closeCloudAuthModal() {
  playNavSound();
  const m = document.getElementById('cloudAuthModal');
  if (m) m.style.display = 'none';
  const welcome = document.getElementById('welcomeScreenOverlay');
  const welcomeOpen = welcome && welcome.style.display === 'flex';
  const opener = cloudAuthOpenerId ? document.getElementById(cloudAuthOpenerId) : null;
  const triggerBtn = (opener && opener.offsetParent !== null && opener)
    || (welcomeOpen ? document.getElementById(isCloudAuthSignUp ? 'welcomeBtnSignUp' : 'welcomeBtnSignIn') : document.getElementById('btnOpenCloudSignIn'));
  if (triggerBtn) triggerBtn.focus();
}

function toggleCloudAuthMode(e) {
  if (e) e.preventDefault();
  playNavSound();
  isCloudAuthSignUp = !isCloudAuthSignUp;
  updateCloudAuthUi();
}

function switchCloudAuthPane(pane) {
  playNavSound();
  const formPane = document.getElementById('cloudAuthFormPane');
  const verifyPane = document.getElementById('cloudAuthVerifyPane');
  const statusMsg = document.getElementById('cloudAuthStatusMsg');
  const verifyStatus = document.getElementById('cloudVerifyStatusMsg');
  if (statusMsg) statusMsg.innerText = '';
  if (verifyStatus) verifyStatus.innerText = '';

  if (pane === 'verify') {
    if (formPane) formPane.style.display = 'none';
    if (verifyPane) verifyPane.style.display = 'block';
    const codeInp = document.getElementById('cloudVerifyCodeInput');
    if (codeInp) codeInp.value = '';
    setTimeout(() => {
      document.getElementById('cloudVerifyCodeInput')?.focus();
    }, 60);
  } else {
    if (verifyPane) verifyPane.style.display = 'none';
    if (formPane) formPane.style.display = 'block';
    setTimeout(focusCloudAuthFirstField, 60);
  }
}

function updateCloudAuthUi() {
  const title = document.getElementById('cloudAuthTitle');
  const desc = document.getElementById('cloudAuthDesc');
  const submitBtn = document.getElementById('cloudAuthSubmitBtn');
  const toggleLink = document.getElementById('cloudAuthToggleLink');
  const nameRow = document.getElementById('cloudAuthNameRow');
  const statusMsg = document.getElementById('cloudAuthStatusMsg');
  if (statusMsg) statusMsg.innerText = '';

  if (isCloudAuthSignUp) {
    if (title) title.innerText = 'Create StreamVault Account';
    if (desc) desc.innerText = 'Create your account to sync your IPTV, continue watching, and profiles across all your TVs and phones.';
    if (submitBtn) submitBtn.innerText = 'Create Account';
    if (toggleLink) toggleLink.innerText = 'Already have an account? Sign In';
    if (nameRow) nameRow.style.display = 'block';
  } else {
    if (title) title.innerText = 'Sign In to Account';
    if (desc) desc.innerText = 'Sign in to see your profiles, watchlist, ratings and IPTV playlist on every TV and phone.';
    if (submitBtn) submitBtn.innerText = 'Sign In';
    if (toggleLink) toggleLink.innerText = "Don't have an account? Sign Up";
    if (nameRow) nameRow.style.display = 'none';
  }
  setTimeout(focusCloudAuthFirstField, 40);
}

async function handleCloudAuthSubmit(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('cloudAuthSubmitBtn');
  const statusMsg = document.getElementById('cloudAuthStatusMsg');
  const email = document.getElementById('cloudAuthEmail')?.value?.trim();
  const password = document.getElementById('cloudAuthPassword')?.value;
  const displayName = document.getElementById('cloudAuthName')?.value?.trim() || 'Account Owner';

  if (!email || !password) return;
  if (btn) btn.disabled = true;
  if (statusMsg) {
    statusMsg.style.color = '#C4B5FD';
    statusMsg.innerText = isCloudAuthSignUp ? 'Sending verification code...' : 'Signing in...';
  }

  const endpoint = isCloudAuthSignUp ? '/api/auth/signup' : '/api/auth/login';
  const payload = { email, password };
  if (isCloudAuthSignUp) {
    payload.displayName = displayName;
  }

  try {
    const res = await fetch(CLOUD_SYNC_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.requireVerification) {
      if (endpoint === '/api/auth/login') {
        await fetch(CLOUD_SYNC_BASE + '/api/auth/resend-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        }).catch(() => null);
      }
      currentPendingVerifyEmail = email;
      const lbl = document.getElementById('cloudVerifyEmailLabel');
      if (lbl) lbl.innerText = email;
      switchCloudAuthPane('verify');
      showToast('✓ 6-Digit code sent to ' + email);
      if (data.devCode) {
        console.log('[StreamVault Cloud] Dev verification code:', data.devCode);
      }
    } else if (data.success && data.token) {
      await handleSuccessfulAuth(data);
    } else {
      if (statusMsg) {
        statusMsg.style.color = '#EF4444';
        statusMsg.innerText = data.error || 'Authentication failed. Please verify credentials.';
      }
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.style.color = '#EF4444';
      statusMsg.innerText = err.message || 'Connection error';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleVerifyCodeSubmit(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('cloudVerifySubmitBtn');
  const statusMsg = document.getElementById('cloudVerifyStatusMsg');
  const code = document.getElementById('cloudVerifyCodeInput')?.value?.trim();

  if (!code || !currentPendingVerifyEmail) return;
  if (btn) btn.disabled = true;
  if (statusMsg) {
    statusMsg.style.color = '#C4B5FD';
    statusMsg.innerText = 'Verifying code...';
  }

  try {
    const res = await fetch(CLOUD_SYNC_BASE + '/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentPendingVerifyEmail, code })
    });
    const data = await res.json();
    if (data.success && data.token) {
      await handleSuccessfulAuth(data);
    } else {
      if (statusMsg) {
        statusMsg.style.color = '#EF4444';
        statusMsg.innerText = data.error || 'Invalid or expired code. Please try again.';
      }
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.style.color = '#EF4444';
      statusMsg.innerText = err.message || 'Connection error';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resendVerificationCode(e) {
  if (e) e.preventDefault();
  if (!currentPendingVerifyEmail) return;
  const statusMsg = document.getElementById('cloudVerifyStatusMsg');
  if (statusMsg) {
    statusMsg.style.color = '#C4B5FD';
    statusMsg.innerText = 'Sending new code...';
  }
  try {
    const res = await fetch(CLOUD_SYNC_BASE + '/api/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentPendingVerifyEmail })
    });
    const data = await res.json();
    if (!res.ok) {
      if (statusMsg) {
        statusMsg.style.color = '#EF4444';
        statusMsg.innerText = data.error || 'Failed to resend code';
      }
      return;
    }
    if (statusMsg) {
      statusMsg.style.color = '#10B981';
      statusMsg.innerText = '✓ New 6-digit code sent to your email!';
    }
    if (data.devCode) {
      console.log('[StreamVault Cloud] Resent dev verification code:', data.devCode);
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.style.color = '#EF4444';
      statusMsg.innerText = 'Failed to resend code';
    }
  }
}

function openSignOutModal() {
  playNavSound();
  const m = document.getElementById('signOutModal');
  if (m) {
    m.style.display = 'flex';
    setTimeout(() => {
      document.getElementById('btnCancelSignOut')?.focus();
    }, 60);
  }
}

function closeSignOutModal() {
  playNavSound();
  const m = document.getElementById('signOutModal');
  if (m) m.style.display = 'none';
  signOutUnsyncedAcknowledged = false;
  const w = document.getElementById('signOutUnsyncedWarning'); if (w) w.style.display = 'none';
  const cb = document.getElementById('btnConfirmSignOut'); if (cb) { cb.textContent = 'Sign Out & Unlink'; cb.disabled = false; }
  const btn = document.getElementById('btnSignOutAccount') || document.getElementById('btnOpenCloudSignIn');
  if (btn) btn.focus();
}

let signOutUnsyncedAcknowledged = false;

async function confirmSignOutAccount(force = false) {
  playNavSound();
  const token = getStoredAuthToken();
  // Push any unsynced profile changes BEFORE the token and local data are wiped (skip if forced by 401 expiry).
  if (!force && token && !signOutUnsyncedAcknowledged && ProfileSyncManager.getPendingCount() > 0) {
    const btn = document.getElementById('btnConfirmSignOut');
    const warn = document.getElementById('signOutUnsyncedWarning');
    if (btn) btn.disabled = true;
    if (warn) { warn.style.display = 'block'; warn.textContent = 'Saving your latest changes to the cloud...'; }
    let allSynced = false;
    try { allSynced = await ProfileSyncManager.flush(); } catch (_) {}
    if (btn) btn.disabled = false;
    if (!allSynced) {
      const n = ProfileSyncManager.getPendingCount();
      if (warn) warn.textContent = n + ' recent change' + (n === 1 ? '' : 's') + " could not be saved to the cloud (check the internet). If you sign out now they will be lost. Press 'Sign Out Anyway' to continue, or Cancel and try again later.";
      if (btn) { btn.textContent = 'Sign Out Anyway'; btn.focus(); }
      signOutUnsyncedAcknowledged = true;
      return;
    }
    if (warn) warn.style.display = 'none';
  }
  signOutUnsyncedAcknowledged = false;
  if (token) {
    try {
      await fetch(CLOUD_SYNC_BASE + '/api/auth/signout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(() => {});
    } catch (_) {}
  }
  try {
    localStorage.removeItem(ProfileSyncManager.queueKey);
    localStorage.removeItem(ProfileSyncManager.lastSyncKey);
    localStorage.removeItem('sv_vault_before_kids');
  } catch (_) {}
  localStorage.removeItem('sv_auth_token');
  localStorage.removeItem('streamvault_session_token');
  localStorage.removeItem('streamvault_account');
  localStorage.removeItem('sv_last_profile_id');
  localStorage.removeItem('streamvault_active_theme');
  sessionStorage.clear();
  window.vaultBeforeKids = null;
  if (typeof lastVerifiedPin !== 'undefined') lastVerifiedPin = '';
  if (typeof cachedPlaylists !== 'undefined') cachedPlaylists = [];
  if (typeof latestData !== 'undefined') latestData = null;

  try {
    await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
  } catch (_) {}
  try {
    await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'signout' })
    }).catch(() => {});
  } catch (_) {}
  try {
    await fetch('/api/factory-reset', { method: 'POST' }).catch(() => {});
  } catch (_) {}

  if (typeof profilesData !== 'undefined') profilesData.activeProfileId = '';
  appStatus = null;
  homeData = null;
  currentActiveProfile = null;
  closeSignOutModal();
  closeUserProfileModal();
  showToast('✓ Signed out. TV restored to clean state.');
  showWelcomeScreen();
}

const ProfileSyncManager = {
  queueKey: 'sv_pending_profile_sync',
  lastSyncKey: 'sv_last_profile_sync_ts',
  timer: null,
  lastError: '',

  getQueue() {
    try {
      return JSON.parse(localStorage.getItem(this.queueKey) || '[]');
    } catch (_) { return []; }
  },

  setQueue(q) {
    try {
      localStorage.setItem(this.queueKey, JSON.stringify(q));
    } catch (_) {}
  },

  getPendingCount() {
    return this.getQueue().length;
  },

  getLastSyncTimestamp() {
    return parseInt(localStorage.getItem(this.lastSyncKey) || '0', 10);
  },

  setLastSyncTimestamp(ts) {
    localStorage.setItem(this.lastSyncKey, String(ts));
  },

  recordChange(dataType, itemKey, payload) {
    if (payload && payload.isAdult) return;
    const profileId = (window.currentActiveProfile && window.currentActiveProfile.id) || 'prof_primary';
    const queue = this.getQueue();
    const now = Date.now();
    payload.updatedAt = now;

    const existingIdx = queue.findIndex(x => x.profileId === profileId && x.dataType === dataType && x.itemKey === itemKey);
    const entry = { profileId, dataType, itemKey, data: payload, updatedAt: now };
    if (existingIdx >= 0) {
      queue[existingIdx] = entry;
    } else {
      queue.push(entry);
    }
    this.setQueue(queue);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush();
    }, 10000);
    renderSyncStatus();
  },

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const token = getStoredAuthToken();
    if (!token) return this.getQueue().length === 0;

    const queue = this.getQueue();
    if (queue.length === 0) return true;

    const groups = {};
    for (const item of queue) {
      const k = `${item.profileId}:::${item.dataType}`;
      if (!groups[k]) groups[k] = { profileId: item.profileId, dataType: item.dataType, items: [] };
      groups[k].items.push({ itemKey: item.itemKey, data: item.data, updatedAt: item.updatedAt });
    }

    const successfullySentKeys = [];
    for (const k of Object.keys(groups)) {
      const g = groups[k];
      try {
        const res = await fetch('/api/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: g.profileId,
            dataType: g.dataType,
            items: g.items
          })
        });
        if (!res.ok) { this.lastError = 'cloud answered ' + res.status; }
        if (res.ok) {
          for (const it of g.items) {
            successfullySentKeys.push(`${g.profileId}:::${g.dataType}:::${it.itemKey}`);
          }
        }
      } catch (err) {
        this.lastError = err.message || 'no connection';
        console.warn('[ProfileSync] Push failed:', err.message);
      }
    }

    if (successfullySentKeys.length > 0) {
      const currentQueue = this.getQueue();
      const remaining = currentQueue.filter(x => !successfullySentKeys.includes(`${x.profileId}:::${x.dataType}:::${x.itemKey}`));
      this.setQueue(remaining);
      this.setLastSyncTimestamp(Date.now());
      renderSyncStatus();
    }
    return this.getQueue().length === 0;
  },

  async pull(profileId) {
    const token = getStoredAuthToken();
    if (!token || !profileId) return;

    const lastSync = this.getLastSyncTimestamp();
    try {
      const res = await fetch(`/api/sync/pull?profile_id=${encodeURIComponent(profileId)}&updated_since=${lastSync}`);
      if (!res.ok) return;
      const data = await res.json();
      const items = data.items || [];
      if (items.length === 0) return;

      let cwChanged = false;
      let wlChanged = false;

      for (const it of items) {
        const itemData = it.data || {};
        if (it.dataType === 'progress') {
          if (it.itemKey && itemData.resumePositionMs !== undefined) {
            await fetch('/api/progress', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dedupKey: it.itemKey,
                positionMs: itemData.resumePositionMs || 0,
                durationMs: itemData.durationMs || 0,
                isWatched: itemData.isWatched || false
              })
            }).catch(() => {});
            cwChanged = true;
          }
        } else if (it.dataType === 'watchlist') {
          if (it.itemKey) {
            await fetch('/api/watchlist/toggle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dedupKey: it.itemKey,
                inWatchlist: itemData.inWatchlist
              })
            }).catch(() => {});
            wlChanged = true;
          }
        } else if (it.dataType === 'ratings') {
          if (it.itemKey && itemData.userRating) {
            await fetch('/api/rate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dedupKey: it.itemKey,
                rating: itemData.userRating
              })
            }).catch(() => {});
          }
        } else if (it.dataType === 'searches') {
          if (Array.isArray(itemData.searches)) {
            for (const s of itemData.searches) {
              await fetch('/api/search-history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: s })
              }).catch(() => {});
            }
          }
        } else if (it.dataType === 'settings') {
          if (itemData.theme) {
            applyProfileTheme(itemData.theme);
          }
        }
      }

      this.setLastSyncTimestamp(Date.now());
      if (cwChanged || wlChanged) {
        if (currentTab === 'HOME') loadHome();
      }
      renderSyncStatus();
    } catch (err) {
      console.warn('[ProfileSync] Pull failed:', err.message);
    }
  }
};
window.ProfileSyncManager = ProfileSyncManager;
window.flushProfileSyncImmediate = () => ProfileSyncManager.flush();
window.addEventListener('beforeunload', () => { ProfileSyncManager.flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    ProfileSyncManager.flush();
  }
});

function renderSyncStatus() {
  const syncLabel = document.getElementById('syncStatusLabel');
  const pendingLabel = document.getElementById('syncPendingLabel');
  if (!syncLabel && !pendingLabel) return;

  const lastSync = ProfileSyncManager.getLastSyncTimestamp();
  const pendingCount = ProfileSyncManager.getPendingCount();

  if (syncLabel) {
    if (!lastSync) {
      syncLabel.innerText = 'Never synced';
    } else {
      const elapsedSec = Math.floor((Date.now() - lastSync) / 1000);
      if (elapsedSec < 60) syncLabel.innerText = 'Just now';
      else if (elapsedSec < 3600) syncLabel.innerText = `${Math.floor(elapsedSec / 60)}m ago`;
      else syncLabel.innerText = `${Math.floor(elapsedSec / 3600)}h ago`;
    }
  }

  if (pendingLabel) {
    pendingLabel.innerText = pendingCount > 0 ? `${pendingCount} pending` : 'All synced';
    pendingLabel.style.color = pendingCount > 0 ? '#FBBF24' : '#10B981';
  }
}

async function triggerCloudSync() {
  const token = getStoredAuthToken();
  if (!token) {
    openCloudAuthModal('login');
    return;
  }
  showToast('⚡ Syncing with Cloudflare D1...');
  const syncBtn = document.getElementById('btnSyncNow');
  if (syncBtn) {
    syncBtn.innerText = 'Syncing...';
    syncBtn.disabled = true;
  }

  try {
    await ProfileSyncManager.flush();
    if (currentActiveProfile && currentActiveProfile.id) {
      await ProfileSyncManager.pull(currentActiveProfile.id);
    }
    await loadPlaylistsData();
    const left = ProfileSyncManager.getPendingCount();
    if (left > 0) {
      showToast('⚠ ' + left + ' change' + (left > 1 ? 's' : '') + ' could not be sent yet' + (ProfileSyncManager.lastError ? ' (' + ProfileSyncManager.lastError + ')' : '') + '. They stay saved here and will retry.', 7000);
    } else {
      ProfileSyncManager.setLastSyncTimestamp(Date.now());
      showToast('✓ Cloud Synchronized');
    }
    renderSyncStatus();
  } catch (err) {
    showToast('⚠ Sync error: ' + err.message);
  } finally {
    if (syncBtn) {
      syncBtn.innerText = 'Sync Cloud';
      syncBtn.disabled = false;
    }
  }
}

// Hardware & Audio Settings Toggles
function toggleAudioPriority() {
  playNavSound();
  const current = localStorage.getItem('streamvault_audio_priority') || '5.1';
  const modes = [
    { key: '5.1', label: 'English (5.1ch Surround)' },
    { key: 'orig', label: 'Original Audio (Direct Passthrough)' },
    { key: 'night', label: 'Stereo Downmix (Night Mode)' }
  ];
  const idx = modes.findIndex(m => m.key === current);
  const next = modes[(idx + 1) % modes.length];
  localStorage.setItem('streamvault_audio_priority', next.key);
  const btn = document.getElementById('btnAudioPriority');
  if (btn) btn.innerText = next.label;
  showToast('Audio Priority: ' + next.label);
}

function toggleDedupQuality() {
  playNavSound();
  const current = localStorage.getItem('streamvault_dedup_quality') || '4k';
  const modes = [
    { key: '4k', label: '4K UHD > Clean HQ* > 1080p' },
    { key: '1080p', label: '1080p FHD Preferred' },
    { key: 'direct', label: 'Direct Stream (Fastest Buffer)' }
  ];
  const idx = modes.findIndex(m => m.key === current);
  const next = modes[(idx + 1) % modes.length];
  localStorage.setItem('streamvault_dedup_quality', next.key);
  const btn = document.getElementById('btnDedupQuality');
  if (btn) btn.innerText = next.label;
  showToast('Dedup Quality: ' + next.label);
}

// Parental & Profile Customization Helpers
function updateParentalStatusInSettings() {
  const btn = document.getElementById('btnToggleParentalLock');
  if (!btn) return;
  btn.innerText = isAdultVaultUnlocked ? 'Lock Session' : 'Unlock Session';
  btn.style.color = isAdultVaultUnlocked ? '#10B981' : '#F59E0B';
}

let lastVerifiedPin = '';

function updateKidsModeToggleBtn(enabled) {
  const btn = document.getElementById('btnToggleKidsMode');
  if (btn) {
    btn.innerText = enabled ? 'Enabled' : 'Disabled';
    btn.style.background = enabled ? '#059669' : '#262A38';
    btn.style.borderColor = enabled ? '#10B981' : '#374151';
    btn.style.color = enabled ? '#FFFFFF' : '#9CA3AF';
  }
}

// The toggle only marks a PENDING choice; the real profile (and every tab) changes when Save Profile is pressed
function toggleProfileKidsMode() {
  playNavSound();
  const pending = (window.pendingKids === true || window.pendingKids === false) ? window.pendingKids : Boolean(currentActiveProfile.isKids);
  if (pending) {
    // Currently ON -> Turning OFF requires Master PIN!
    openParentalPinModal({
      action: 'disable_kids',
      onComplete: (pin) => {
        window.pendingKids = false;
        lastVerifiedPin = pin;
        updateKidsModeToggleBtn(false);
        showToast('Kids Mode will be turned off. Click Save Profile to apply.');
      }
    });
  } else {
    // Currently OFF -> Turning ON does NOT require PIN!
    window.pendingKids = true;
    updateKidsModeToggleBtn(true);
    showToast('Kids Mode will be turned on. Click Save Profile to apply.');
  }
}

