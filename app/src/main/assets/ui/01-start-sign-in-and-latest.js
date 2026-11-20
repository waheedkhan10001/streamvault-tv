// Smart Universal Network Routing for Cloud and Native Standalone TV
const CLOUD_SYNC_BASE = 'https://streamvault-sync.streamvault-app.workers.dev';

window.safeUrl = function(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s || /["'<>\s\u0000-\u001F]/.test(s)) return '';
  if (/^https?:\/\//i.test(s) || s.startsWith('/api/')) return s;
  return '';
};
window.safeColor = function(c, fallback) {
  const s = String(c == null ? '' : c).trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s) || s === 'var(--theme-accent)') return s;
  return fallback || '#7C3AED';
};

window.__svApiSeq = 0;
window.__svApiPending = {};
window.__svApiDone = function (id, res) { const f = window.__svApiPending[id]; if (f) { delete window.__svApiPending[id]; f(res); } };
const _rawFetch = window.fetch.bind(window);
window.fetch = function(input, init) {
  const token = localStorage.getItem('sv_auth_token') || '';
  const headers = (init && typeof Headers !== 'undefined' && init.headers instanceof Headers)
    ? Object.fromEntries(init.headers.entries())
    : Object.assign({}, (init && init.headers) || {});
  const isTrustedApi = typeof input === 'string' && (input.startsWith('/api/') || input.startsWith(CLOUD_SYNC_BASE + '/'));
  if (isTrustedApi && token && !headers['Authorization'] && !headers['authorization']) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const newInit = Object.assign({}, init, { headers });

  if (typeof input === 'string' && input.startsWith('/api/')) {
    // 1. Cloud Authentication, TV Code Pairing, Cloud Catalog & Profile Sync
    if ((input.startsWith('/api/auth/') || input.startsWith('/api/sync/') || input.startsWith('/api/account/') || input.startsWith('/api/cloud/') || input.startsWith('/api/playlists') || input.startsWith('/api/catalog/') || input.startsWith('/api/tmdb/')) && input !== '/api/catalog/pull-cloud' && input !== '/api/sync/status') {
      // If offline or no cloud token for playlists, let Android native engine handle it locally
      if (input.startsWith('/api/playlists') && !token && window.AndroidApp && typeof window.AndroidApp.handleApiRequest === 'function') {
        const method = (newInit && newInit.method) ? newInit.method.toUpperCase() : 'GET';
        const body = (newInit && newInit.body) ? (typeof newInit.body === 'string' ? newInit.body : JSON.stringify(newInit.body)) : '';
        try {
          const resStr = (typeof window.AndroidApp.handleApiRequestWithAuth === 'function')
            ? window.AndroidApp.handleApiRequestWithAuth(method, input, body, token)
            : window.AndroidApp.handleApiRequest(method, input, body);
          let status = 200;
          try {
            const parsed = JSON.parse(resStr);
            if (parsed && (parsed.status === 401 || (parsed.error && parsed.error.includes('Unauthorized')))) {
              status = 401;
            }
          } catch (_) {}
          return Promise.resolve(new Response(resStr, {
            status: status,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          }));
        } catch (err) {
          return Promise.resolve(new Response(JSON.stringify({ error: err.message, ok: false }), { status: 500 }));
        }
      }

      const target = input.replace('/api/cloud/request-code', '/api/auth/request-code')
                          .replace('/api/cloud/status', '/api/auth/poll-code');
      return _rawFetch(CLOUD_SYNC_BASE + target, newInit).catch(err => {
        // Fallback to local Android router if network fails
        if (window.AndroidApp && typeof window.AndroidApp.handleApiRequest === 'function') {
          const method = (newInit && newInit.method) ? newInit.method.toUpperCase() : 'GET';
          const body = (newInit && newInit.body) ? (typeof newInit.body === 'string' ? newInit.body : JSON.stringify(newInit.body)) : '';
          const resStr = (typeof window.AndroidApp.handleApiRequestWithAuth === 'function')
            ? window.AndroidApp.handleApiRequestWithAuth(method, input, body, token)
            : window.AndroidApp.handleApiRequest(method, input, body);
          let status = 200;
          try {
            const parsed = JSON.parse(resStr);
            if (parsed && (parsed.status === 401 || (parsed.error && parsed.error.includes('Unauthorized')))) {
              status = 401;
            }
          } catch (_) {}
          return new Response(resStr, { status: status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        }
        throw err;
      });
    }

    // 2. Native Standalone TV Engine (Direct In-Memory / SQLite via Kotlin bridge)
    // The answer arrives later, so the screen keeps responding to the remote while the database works.
    if (window.AndroidApp && typeof window.AndroidApp.handleApiRequestAsync === 'function') {
      const method = (newInit && newInit.method) ? newInit.method.toUpperCase() : 'GET';
      const body = (newInit && newInit.body) ? (typeof newInit.body === 'string' ? newInit.body : JSON.stringify(newInit.body)) : '';
      return new Promise((resolve) => {
        const id = 'c' + (++window.__svApiSeq);
        const timer = setTimeout(() => {
          if (window.__svApiPending[id]) { delete window.__svApiPending[id]; resolve(new Response(JSON.stringify({ error: 'timeout', ok: false }), { status: 504 })); }
        }, 180000);
        window.__svApiPending[id] = (resStr) => {
          clearTimeout(timer);
          let status = 200;
          try {
            const parsed = JSON.parse(resStr);
            if (parsed && (parsed.status === 401 || (parsed.error && String(parsed.error).includes('Unauthorized')))) status = 401;
          } catch (_) {}
          resolve(new Response(resStr, { status: status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
        };
        try {
          window.AndroidApp.handleApiRequestAsync(id, method, input, body, token || '');
        } catch (err) {
          clearTimeout(timer); delete window.__svApiPending[id];
          resolve(new Response(JSON.stringify({ error: err.message, ok: false }), { status: 500 }));
        }
      });
    }
    if (window.AndroidApp && typeof window.AndroidApp.handleApiRequest === 'function') {
      const method = (newInit && newInit.method) ? newInit.method.toUpperCase() : 'GET';
      const body = (newInit && newInit.body) ? (typeof newInit.body === 'string' ? newInit.body : JSON.stringify(newInit.body)) : '';
      try {
        const resStr = (typeof window.AndroidApp.handleApiRequestWithAuth === 'function')
          ? window.AndroidApp.handleApiRequestWithAuth(method, input, body, token)
          : window.AndroidApp.handleApiRequest(method, input, body);
        let status = 200;
        try {
          const parsed = JSON.parse(resStr);
          if (parsed && (parsed.status === 401 || (parsed.error && parsed.error.includes('Unauthorized')))) {
            status = 401;
          }
        } catch (_) {}
        return Promise.resolve(new Response(resStr, {
          status: status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }));
      } catch (err) {
        return Promise.resolve(new Response(JSON.stringify({ error: err.message, ok: false }), { status: 500 }));
      }
    }

    // 3. Fallback to Browser Origin (PC Runner or Local Webview)
    let base = localStorage.getItem('sv_server_base_url') || '';
    if (!base && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
      base = window.location.origin;
    }
    const fullUrl = (base ? base.replace(/\/$/, '') : '') + input;
    return _rawFetch(fullUrl, newInit);
  }
  return _rawFetch(input, newInit);
};

let appStatus = null;
let homeData = null;
let currentTab = 'HOME';
try {
  Object.defineProperty(window, 'currentTab', { get: () => currentTab, set: (v) => { currentTab = v; }, configurable: true });
  window.getCurrentTab = () => currentTab;
} catch (_) {}
let selectedDetailItem = null;
let enteredPin = '';
let currentSubOffsetSec = 0.0;
let queryDebounceTimer = null;
let activeDropdownId = null;
let osdHideTimeout = null;
let previewBufferTimeout = null;
let userStarRating = 0;

let filterState = {
  searchQuery: '',
  mediaTypeFilter: null,
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

const NAV_ITEMS = [
  {
    id: 'HOME',
    label: 'Home',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`
  },
  {
    id: 'LATEST',
    label: 'New',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
  },
  {
    id: 'SEARCH',
    label: 'Search',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`
  },
  {
    id: 'MOVIES',
    label: 'Movies',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect width="20" height="20" x="2" y="2" rx="2.18" ry="2.18"/><line x1="7" x2="7" y1="2" y2="22"/><line x1="17" x2="17" y1="2" y2="22"/><line x1="2" x2="22" y1="12" y2="12"/><line x1="2" x2="7" y1="7" y2="7"/><line x1="2" x2="7" y1="17" y2="17"/><line x1="17" x2="22" y1="17" y2="17"/><line x1="17" x2="22" y1="7" y2="7"/></svg>`
  },
  {
    id: 'SERIES',
    label: 'Series',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>`
  },
  {
    id: 'LIVE_TV',
    label: 'Live TV',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>`
  },
  {
    id: 'WATCHLIST',
    label: 'My List',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
  }
];

const ADULT_CATEGORIES = [
  'XXX VIP', 'XXX Team Skeet', 'XXX Best Full Movies', 'XXX Hindi', 'XXX Hindi Full',
  'XXX Redhat', 'XXX Strom', 'XXX Adult Ultimate', 'XXX Korean', 'XXX Japanese', 'Philippines 18+'
];

const ALL_GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime',
  'Documentary', 'Drama', 'Family', 'Fantasy', 'History',
  'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War'
];

const ALL_LANGS = ['English', 'Hindi', 'Urdu', 'Punjabi', 'Multi-Audio', 'Tamil', 'Telugu', 'Arabic', 'Turkish'];

// Shared AudioContext Singleton with Browser Autoplay Unlock
let sharedAudioCtx = null;
let lastNavSoundMs = 0;

function getAudioContext() {
  if (!sharedAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

// Unlock audio on first user touch, click, or key press
['click', 'keydown', 'pointerdown', 'mousedown', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, () => {
    getAudioContext();
  }, { passive: true });
});

function playClickSoundTone(ctx) {
  try {
    const t = ctx.currentTime;
    // Luxury acoustic damped wood/tap sound (Apple TV / Netflix style)
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(65, t + 0.018);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(360, t);
    filter.Q.setValueAtTime(1.2, t);

    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.020);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + 0.022);
  } catch (_) {}
}

function playNavSound() {
  const now = performance.now();
  if (now - lastNavSoundMs < 50) return;
  lastNavSoundMs = now;

  if (window.AndroidApp && typeof window.AndroidApp.playNavTick === 'function') {
    try {
      window.AndroidApp.playNavTick();
      return;
    } catch (_) {}
  }

  // Premium Apple TV / Netflix subtle acoustic tap for PC Simulator
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, ctx.currentTime);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.022);

    gain.gain.setValueAtTime(0.045, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.022);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.025);
  } catch (_) {}
}

function getStoredAuthToken() {
  return localStorage.getItem('sv_auth_token') || localStorage.getItem('streamvault_session_token') || '';
}

function getAccountDisplayName() {
  try {
    const acc = JSON.parse(localStorage.getItem('streamvault_account') || '{}');
    if (acc.displayName) return acc.displayName;
    if (acc.email && acc.email.includes('@')) return acc.email.split('@')[0];
  } catch (_) {}
  if (appStatus?.credentials?.displayName) return appStatus.credentials.displayName;
  return 'User';
}

function getDefaultProfile() {
  return {
    id: 'prof_primary',
    name: getAccountDisplayName(),
    avatarColor: '#7C3AED',
    isKids: false,
    theme: localStorage.getItem('streamvault_active_theme') || 'purple',
    isPrimary: true
  };
}

function hasActivePlaylist() {
  const creds = appStatus?.credentials;
  return !!(creds && creds.serverUrl && creds.username);
}

function isAppLockedForPlaylist() {
  return !hasActivePlaylist() && !!getStoredAuthToken();
}

async function syncSessionToNative(token) {
  if (!token) return;
  try {
    const acc = JSON.parse(localStorage.getItem('streamvault_account') || '{}');
    await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token,
        email: acc.email || '',
        displayName: acc.displayName || getAccountDisplayName()
      })
    });
  } catch (_) {}
}

async function validateSessionInBackground(token) {
  if (!token) return;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 401) {
      console.warn('[Auth] Session invalidated by server (401)');
      await confirmSignOutAccount(true);
    } else if (res.ok) {
      const data = await res.json();
      if (data && data.account) {
        localStorage.setItem('streamvault_account', JSON.stringify(data.account));
        updateUserProfileUI();
      }
    }
  } catch (err) {
    console.log('[Auth] Background validation offline, allowing cached session');
  }
}

let tvPairingPollInterval = null;

let welcomeCodeRetryTimer = null;
let welcomeCodeLoading = false;
let welcomePollSecret = '';

async function loadWelcomePairingCode() {
  if (welcomeCodeLoading) return;
  welcomeCodeLoading = true;
  const codeDisplay = document.getElementById('welcomeCodeDisplay');
  const qrImg = document.getElementById('welcomeQrImg');
  let loaded = false;
  try {
    const res = await fetch('/api/auth/request-code', { method: 'POST' });
    const data = res && res.ok ? await res.json() : null;
    const code = data && data.success !== false && data.code ? String(data.code) : '';
    const pollSecret = data && data.pollSecret ? String(data.pollSecret) : '';
    if (code) {
      welcomePollSecret = pollSecret;
      if (codeDisplay) codeDisplay.innerText = code;
      if (qrImg) {
        qrImg.src = svQrDataUrl('https://streamvault-sync.streamvault-app.workers.dev/link?code=' + code);
        qrImg.style.visibility = 'visible';
      }
      startTvPairingPolling(code, pollSecret);
      loaded = true;
    }
  } catch (err) {
    console.warn('[Welcome] Could not load pairing code:', err);
  }
  welcomeCodeLoading = false;
  if (!loaded) {
    if (codeDisplay) codeDisplay.innerText = 'No connection';
    if (qrImg) qrImg.style.visibility = 'hidden';
    // Keep trying quietly while the welcome screen is open (Wi-Fi may still be starting up)
    if (welcomeCodeRetryTimer) clearTimeout(welcomeCodeRetryTimer);
    welcomeCodeRetryTimer = setTimeout(() => {
      welcomeCodeRetryTimer = null;
      const ov = document.getElementById('welcomeScreenOverlay');
      if (ov && ov.style.display === 'flex') loadWelcomePairingCode();
    }, 8000);
  }
}

async function showWelcomeScreen() {
  const overlay = document.getElementById('welcomeScreenOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  const sb = document.getElementById('sidebar');
  if (sb) sb.style.display = 'none';

  // Focus first so the remote works immediately, then fetch the code
  setTimeout(() => {
    const m = document.getElementById('cloudAuthModal');
    if (!m || m.style.display !== 'flex') document.getElementById('welcomeBtnSignIn')?.focus();
  }, 100);

  loadWelcomePairingCode();
}

function hideWelcomeScreen() {
  const overlay = document.getElementById('welcomeScreenOverlay');
  if (overlay) overlay.style.display = 'none';
  if (welcomeCodeRetryTimer) { clearTimeout(welcomeCodeRetryTimer); welcomeCodeRetryTimer = null; }
  if (tvPairingPollInterval) {
    clearInterval(tvPairingPollInterval);
    tvPairingPollInterval = null;
  }
  const sb = document.getElementById('sidebar');
  if (sb) sb.style.display = 'flex';
}

function stopTvPairingPolling() {
  if (tvPairingPollInterval) { clearInterval(tvPairingPollInterval); tvPairingPollInterval = null; }
}

// The code on screen is dead (expired, or the phone link could not be finished): show a fresh one.
function refreshWelcomePairingCode() {
  stopTvPairingPolling();
  const ov = document.getElementById('welcomeScreenOverlay');
  if (ov && ov.style.display === 'flex') loadWelcomePairingCode();
}

function startTvPairingPolling(code, pollSecret) {
  stopTvPairingPolling();
  const secret = pollSecret || welcomePollSecret || '';
  let busy = false;
  tvPairingPollInterval = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const pollHeaders = secret ? { 'X-Poll-Secret': secret } : {};
      const res = await fetch('/api/auth/poll-code?code=' + encodeURIComponent(code), { headers: pollHeaders }).catch(() => null);
      if (!res || !res.ok) return;
      const data = await res.json();
      if (data.status === 'expired') { refreshWelcomePairingCode(); return; }
      if (data.status === 'paired' && data.exchangeToken) {
        stopTvPairingPolling();
        let exData = null;
        try {
          const exHeaders = { 'Content-Type': 'application/json' };
          if (secret) exHeaders['X-Poll-Secret'] = secret;
          const exRes = await fetch('/api/auth/pair-exchange', {
            method: 'POST',
            headers: exHeaders,
            body: JSON.stringify({ code, exchangeToken: data.exchangeToken })
          });
          exData = exRes && exRes.ok ? await exRes.json() : null;
        } catch (_) {}
        if (exData && exData.token) await handleSuccessfulAuth(exData);
        else { showToast('Could not finish linking. Showing a new code.'); refreshWelcomePairingCode(); }
      }
    } catch (_) {
    } finally { busy = false; }
  }, 3000);
}

// Pushes the Master PIN (salted hash + its salt) to the cloud copy so a second TV can restore it.
// The PIN itself never leaves the TV. When CHANGING an existing PIN the cloud demands proof,
// so pass { currentPin } for a change; leave it empty for the very first PIN.
function syncPinToCloud(nativeResult, proof) {
  const token = getStoredAuthToken();
  if (!token || !nativeResult || !nativeResult.pinHash || !nativeResult.pinSalt) return;
  fetch(CLOUD_SYNC_BASE + '/api/account/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ pinHash: nativeResult.pinHash, pinSalt: nativeResult.pinSalt }, proof || {}))
  }).catch(() => {});
}

async function handleSuccessfulAuth(data) {
  localStorage.setItem('sv_auth_token', data.token);
  localStorage.setItem('streamvault_session_token', data.token);
  const accountObj = {
    accountId: data.accountId,
    email: data.email,
    displayName: data.displayName || (data.email ? data.email.split('@')[0] : 'User')
  };
  localStorage.setItem('streamvault_account', JSON.stringify(accountObj));

  await syncSessionToNative(data.token);

  if (data.pinHash) {
    try {
      await fetch('/api/parental-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', pinHash: data.pinHash, pinSalt: data.pinSalt || '' })
      }).catch(() => {});
    } catch (_) {}
  }
  closeCloudAuthModal();
  hideWelcomeScreen();
  showToast('✓ Welcome back! Cloud sync active.');

  await checkAuthAndRoute();
}

function showProfilePicker(profiles, onSelect) {
  const overlay = document.getElementById('profilePickerOverlay');
  const cardsContainer = document.getElementById('profilePickerCards');
  if (!overlay || !cardsContainer) {
    if (onSelect && profiles[0]) onSelect(profiles[0]);
    return;
  }

  const lastId = localStorage.getItem('sv_last_profile_id');
  cardsContainer.innerHTML = profiles.map((p, idx) => {
    const isSelected = p.id === lastId || (!lastId && idx === 0);
    const initial = (p.name || 'U').charAt(0).toUpperCase();
    const color = p.avatarColor || '#7C3AED';
    return `
      <div tabindex="0" class="profile-picker-card tv-focusable" data-profile-id="${escapeHtml(p.id)}" style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px 20px;border-radius:14px;background:#151028;border:2px solid ${isSelected ? 'var(--theme-border)' : '#281F48'};cursor:pointer;min-width:130px;transition:transform 0.2s, border-color 0.2s;">
        <div style="width:72px;height:72px;border-radius:50%;background:${safeColor(color, '#7C3AED')};display:flex;align-items:center;justify-content:center;color:#FFFFFF;font-size:32px;font-weight:900;box-shadow:0 6px 18px rgba(0,0,0,0.6);">
          ${escapeHtml(initial)}
        </div>
        <div style="font-size:15px;font-weight:800;color:#FFFFFF;text-align:center;">
          ${escapeHtml(p.name)}
          ${p.isKids ? '<div style="font-size:10px;color:#F59E0B;font-weight:700;margin-top:2px;">KIDS</div>' : ''}
        </div>
      </div>
    `;
  }).join('');

  overlay.style.display = 'flex';

  const cards = cardsContainer.querySelectorAll('.profile-picker-card');
  cards.forEach(card => {
    card.onclick = () => {
      const pid = card.getAttribute('data-profile-id');
      const chosen = profiles.find(p => p.id === pid) || profiles[0];
      overlay.style.display = 'none';
      if (onSelect) onSelect(chosen);
    };
  });

  setTimeout(() => {
    const target = cardsContainer.querySelector('.profile-picker-card[style*="var(--theme-border"]') || cards[0];
    if (target) target.focus();
  }, 60);
}

async function activateProfileAndEnterApp(profile) {
  currentActiveProfile = { ...profile };
  window.currentActiveProfile = currentActiveProfile;
  try {
    await fetch('/api/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profile.id })
    });
  } catch (_) {}
  sessionStorage.setItem('sv_session_profile_active', 'true');
  localStorage.setItem('sv_last_profile_id', profile.id);
  if (profile.theme) applyProfileTheme(profile.theme);
  updateUserProfileUI();
  renderSidebar();
  if (appStatus && appStatus.totalCatalogCount) {
    const catCount = document.getElementById('sidebarCatalogCount');
    if (catCount) catCount.innerText = `${appStatus.totalCatalogCount.toLocaleString()} Titles`;
  }
  await navigateToTab('HOME');
  const activeNav = document.querySelector('.nav-btn.active');
  if (activeNav) activeNav.focus();
  setupMouseHoverFocus();
  setupKeyboardNavigation();
}

async function checkAuthAndRoute() {
  const token = getStoredAuthToken();
  if (!token) {
    showWelcomeScreen();
    return false;
  }

  // Session exists: revalidate in background, sync to native router
  validateSessionInBackground(token);
  await syncSessionToNative(token);

  // Asked together instead of one after the other (the app state, the profiles and the pack check are independent)
  const stateReq = fetch('/api/state').then((r) => (r && r.ok ? r.json() : null)).catch(() => null);
  const profilesReq = fetch('/api/profiles').then((r) => (r && r.ok ? r.json() : null)).catch(() => null);
  // The content pack (posters, plots, ratings) must be on the TV before the app opens
  await ensurePackReady();
  const stateData = await stateReq;
  if (stateData) appStatus = stateData;

  // Check if IPTV playlist configured (a playlist saved in the cloud is copied to this TV first)
  if (!hasActivePlaylist()) { try { await loadPlaylistsData(); } catch (_) {} }
  const hasIptv = hasActivePlaylist();
  if (!hasIptv) {
    renderSidebar(true);
    showToast('⚙ Cloud account active! Please enter your IPTV provider in Settings.');
    await navigateToTab('SETTINGS');
    const activeNav = document.getElementById('sidebarSettingsBtn') || document.querySelector('.nav-btn.active');
    if (activeNav) activeNav.focus();
    setupMouseHoverFocus();
    setupKeyboardNavigation();
    return true;
  }

  // Playlist is active -> profiles (already requested above)
  let profilesList = [];
  try {
    const pData = await profilesReq;
    profilesList = (pData && pData.profiles) || [];
  } catch (_) {}

  renderSidebar(false);

  // If > 1 profile and not yet picked this session, show profile picker
  const isProfileActiveThisSession = sessionStorage.getItem('sv_session_profile_active') === 'true';
  if (profilesList.length > 1 && !isProfileActiveThisSession) {
    setupKeyboardNavigation();   // the picker must answer the remote too (it used to appear before this was registered)
    showProfilePicker(profilesList, async (selectedProfile) => {
      await activateProfileAndEnterApp(selectedProfile);
    });
    return true;
  }

  const lastProfileId = localStorage.getItem('sv_last_profile_id');
  const targetProf = profilesList.find(p => p.id === lastProfileId) || profilesList[0] || getDefaultProfile();
  await activateProfileAndEnterApp(targetProf);
  return true;
}

async function init() {
  applyProfileTheme(localStorage.getItem('streamvault_active_theme') || 'purple');
  renderSidebar();
  // Something is on screen from the first moment while the app gets ready
  const startVp = document.getElementById('mainViewport');
  if (startVp && !startVp.innerHTML.trim()) startVp.innerHTML = '<div style="padding:60px 40px;color:var(--muted);font-size:16px;">Starting StreamVault…</div>';

  const isAuthedAndRouted = await checkAuthAndRoute();
  if (!isAuthedAndRouted) {
    setupMouseHoverFocus();
    setupKeyboardNavigation();
    return;
  }
}


// ===== LATEST ADDED: what the provider added in the last 14 days (Movies / Series / Live TV) =====
let latestData = null;
let latestPanel = 'MOVIES';

async function loadLatest(vp, focusFirst = false) {
  vp.innerHTML = '<div style="padding:40px;color:var(--muted);">Loading...</div>';
  try {
    const res = await fetch('/api/latest');
    latestData = await res.json();
  } catch (err) {
    vp.innerHTML = `<div style="padding:40px;color:#EF4444;">Could not load the latest titles: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const kids = Boolean(currentActiveProfile && currentActiveProfile.isKids);
  if (kids && latestPanel === 'LIVE') latestPanel = 'MOVIES';
  renderLatest(vp, focusFirst);
}

function latestLiveCards(items) {
  liveZapList = items;
  return `<div class="live-grid" id="latestLiveGrid">${items.map((ch) => `
      <div class="live-channel-card">
        <div class="channel-left">
          ${renderChannelBadge(ch)}
          <div class="channel-info">
            <div class="channel-name" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
              <span class="badge-genre" style="font-size:10px;padding:1px 6px;">${escapeHtml(ch.categoryName || 'General')}</span>
              <span class="badge-quality" style="font-size:9px;padding:1px 4px;">NEW</span>
            </div>
          </div>
        </div>
        <button tabindex="0" class="btn btn-primary tv-focusable js-live-play" style="padding:7px 14px;font-size:12px;" data-stream-id="${escapeHtml(ch.streamId)}" data-ch-name="${escapeHtml(ch.name)}">Watch</button>
      </div>`).join('')}</div>`;
}

function renderLatest(vp, focusFirst = false) {
  const kids = Boolean(currentActiveProfile && currentActiveProfile.isKids);
  const d = latestData || {};
  const lists = { MOVIES: d.movies || [], SERIES: d.series || [], LIVE: kids ? [] : (d.live || []) };
  // Adult / Extras panels exist only while that area is unlocked (the engine leaves them out otherwise)
  const groups = {};
  const pcs = (appStatus && appStatus.parentalControl) || {};
  if (!kids && d.adult && pcs.showAdult) groups.ADULT = d.adult;      // also checked here so a lock hides it at once
  if (!kids && d.extras && pcs.showExtras) groups.EXTRAS = d.extras;
  const groupLabel = { ADULT: '18+', EXTRAS: 'Extras' };
  const groupCount = (g) => (g.movies || []).length + (g.series || []).length + (g.live || []).length;
  if ((latestPanel === 'ADULT' || latestPanel === 'EXTRAS') && !groups[latestPanel]) latestPanel = 'MOVIES';
  const mk = (id, label, n) => {
    const on = latestPanel === id;
    return `<button tabindex="0" id="latestPanel${id}" class="filter-pill-btn tv-focusable ${on ? 'active' : ''}" style="flex-shrink:0;${on ? 'background:rgba(var(--theme-accent-rgb),0.35);border-color:var(--theme-accent);color:#fff;' : ''}" onclick="selectLatestPanel('${id}')">${label} (${n})</button>`;
  };
  const empty = '<div style="padding:40px;color:var(--muted);text-align:center;">Nothing new yet. New titles appear here for 14 days.</div>';
  const cards = (arr) => `<div class="results-grid" id="filterResultsGrid">${arr.map((m) => renderPosterCard(m)).join('')}</div>`;
  let body;
  if (groups[latestPanel]) {
    const g = groups[latestPanel];
    const parts = [];
    if ((g.movies || []).length) parts.push(`<div style="font-size:12px;font-weight:800;color:#9CA3AF;margin:4px 0 8px;">Movies</div>${cards(g.movies)}`);
    if ((g.series || []).length) parts.push(`<div style="font-size:12px;font-weight:800;color:#9CA3AF;margin:12px 0 8px;">Series</div><div class="results-grid">${g.series.map((m) => renderPosterCard(m)).join('')}</div>`);
    if ((g.live || []).length) parts.push(`<div style="font-size:12px;font-weight:800;color:#9CA3AF;margin:12px 0 8px;">Live TV</div>${latestLiveCards(g.live)}`);
    body = parts.length ? parts.join('') : empty;
  } else if (lists[latestPanel].length === 0) {
    body = empty;
  } else if (latestPanel === 'LIVE') {
    body = latestLiveCards(lists.LIVE);
  } else {
    body = cards(lists[latestPanel]);
  }
  const extraBtns = Object.keys(groups).map((id) => mk(id, groupLabel[id], groupCount(groups[id]))).join('');
  vp.innerHTML = `
    <div style="padding:0 0 6px 0;">
      <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:4px;">Latest added</div>
      <div style="font-size:11px;color:#9CA3AF;margin-bottom:10px;">Added by your provider in the last 14 days, newest first.</div>
      <div id="latestPanelBar" class="filter-pill-row" style="margin:0 0 12px 0;gap:8px;">${mk('MOVIES', 'Movies', lists.MOVIES.length)}${mk('SERIES', 'Series', lists.SERIES.length)}${kids ? '' : mk('LIVE', 'Live TV', lists.LIVE.length)}${extraBtns}</div>
      ${body}
    </div>`;
  if (focusFirst) {
    setTimeout(() => { const c = document.querySelector('#filterResultsGrid .poster-card'); if (c) { c.focus(); playNavSound(); } }, 300);
  }
}

function selectLatestPanel(panel) {
  playNavSound();
  latestPanel = panel;
  renderLatest(document.getElementById('mainViewport'));
  setTimeout(() => { const b = document.getElementById('latestPanel' + panel); if (b) b.focus(); }, 60);
}

// ===== 18+ ADULT and EXTRAS: separate locked areas, each with Movies / Series / Live TV panels =====
const VAULT_IDLE_MS = 30 * 60 * 1000;      // auto-lock after 30 minutes without a button press
let vaultIdleTimer = null;
const vaultPanelState = { VAULT_18: 'MOVIES', EXTRAS: 'MOVIES' };

function isVaultTab(tab) { return tab === 'VAULT_18' || tab === 'EXTRAS'; }
function vaultMediaType(tab) {
  if (!isVaultTab(tab)) return null;
  const p = vaultPanelState[tab];
  return p === 'MOVIES' ? 'MOVIE' : p === 'SERIES' ? 'SERIES' : null;
}

function resetVaultIdleTimer() {
  if (vaultIdleTimer) { clearTimeout(vaultIdleTimer); vaultIdleTimer = null; }
  const pc = appStatus && appStatus.parentalControl;
  if (pc && (pc.showAdult || pc.showExtras)) {
    vaultIdleTimer = setTimeout(() => { window.lockParentalControls(); }, VAULT_IDLE_MS);
  }
}
['keydown', 'click', 'mousemove'].forEach((ev) => document.addEventListener(ev, () => {
  if (vaultIdleTimer) resetVaultIdleTimer();
}, true));

// Lock just one area ('adult' or 'extras'). quiet = do not navigate (used when the user is already leaving).
async function lockVault(target, quiet = false) {
  // Update the page state first so any redraw that follows is already correct
  if (appStatus && appStatus.parentalControl) {
    if (target === 'adult') { appStatus.parentalControl.showAdult = false; }
    if (target === 'extras') { appStatus.parentalControl.showExtras = false; }
    appStatus.parentalControl.isLocked = !appStatus.parentalControl.showAdult;
  }
  try {
    await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lock', target })
    });
  } catch (_) {}
  if (!quiet) {
    renderSidebar();
    if ((target === 'adult' && currentTab === 'VAULT_18') || (target === 'extras' && currentTab === 'EXTRAS')) {
      navigateToTab('HOME');
    }
  }
  resetVaultIdleTimer();
  updateParentalStatusInSettings();
}

function vaultPanelBarHtml(tab) {
  const cur = vaultPanelState[tab];
  const mk = (id, label) => `<button tabindex="0" id="vaultPanel${id}" class="filter-pill-btn tv-focusable ${cur === id ? 'active' : ''}" style="flex-shrink:0;${cur === id ? 'background:rgba(var(--theme-accent-rgb),0.35);border-color:var(--theme-accent);color:#fff;' : ''}" onclick="selectVaultPanel('${id}')">${label}</button>`;
  return `<div id="vaultPanelBar" class="filter-pill-row" style="margin:0 0 10px 0;gap:8px;">${mk('MOVIES', 'Movies')}${mk('SERIES', 'Series')}${mk('LIVE', 'Live TV')}</div>`;
}

function injectVaultPanelBar(vp) {
  if (!vp || !isVaultTab(currentTab)) return;
  const old = document.getElementById('vaultPanelBar');
  if (old) old.remove();
  vp.insertAdjacentHTML('afterbegin', vaultPanelBarHtml(currentTab));
}

function openVaultPanel(vp, tab, focusFirstCard) {
  if (vaultPanelState[tab] === 'LIVE') {
    currentLiveTab = 'ALL';
    currentLiveSearch = '';
    loadLiveTv(vp);
  } else {
    loadSuperFilter(vp, tab === 'VAULT_18' ? '18+ Vault' : 'Extras');
    if (focusFirstCard) {
      setTimeout(() => {
        const firstCard = document.querySelector('#filterResultsGrid .poster-card');
        if (firstCard) { firstCard.focus(); playNavSound(); }
      }, 400);
    }
  }
}

function selectVaultPanel(panel) {
  playNavSound();
  if (!isVaultTab(currentTab)) return;
  vaultPanelState[currentTab] = panel;
  resetFilterState();
  const vp = document.getElementById('mainViewport');
  openVaultPanel(vp, currentTab, false);
  setTimeout(() => { const b = document.getElementById('vaultPanel' + panel); if (b) b.focus(); }, 60);
}

let previousTab = 'HOME';

let sidebarSignature = '';
// Squeezes the tab rows until every tab is visible (no scrolling): Profile and Settings stay pinned at the bottom.
function fitSidebar() {
  const sb = document.querySelector('.sidebar');
  const nav = document.getElementById('navList');
  if (!sb || !nav || !nav.children.length) return;
  if (nav.clientHeight === 0) { sb.dataset.fitted = ''; return; }   // sidebar hidden right now: measure when it shows
  const levels = [[13, 14, 18], [11, 13.5, 17], [9, 13, 16], [7, 12.5, 15], [5, 12, 14], [3, 11.5, 13], [2, 11, 12], [1, 10, 11], [0, 9, 10]];
  sb.classList.add('fitting');   // measure without the slide animation, or the sizes read stale
  for (const [pad, font, icon] of levels) {
    sb.style.setProperty('--nav-pad', pad + 'px');
    sb.style.setProperty('--nav-font', font + 'px');
    sb.style.setProperty('--nav-icon', icon + 'px');
    if (nav.scrollHeight <= nav.clientHeight + 1) break;
  }
  void nav.offsetHeight;
  sb.classList.remove('fitting');
  sb.dataset.fitted = '1';
}
window.addEventListener('resize', () => { try { fitSidebar(); } catch (_) {} });
// the list's available height can change after it is built (profile pill appears, fonts load): refit then
try { new ResizeObserver(() => { try { fitSidebar(); } catch (_) {} }).observe(document.getElementById('navList')); } catch (_) {}

function renderSidebar(lockedToPlaylist = false) {
  const container = document.getElementById('navList');
  if (!container) return;
  const isLocked = lockedToPlaylist || isAppLockedForPlaylist();
  const isKids = Boolean(currentActiveProfile && currentActiveProfile.isKids);
  // Kids mode: Live TV is hidden completely
  const items = NAV_ITEMS.filter((it) => !(isKids && it.id === 'LIVE_TV'));
  const isAdultUnlocked = !isKids && appStatus?.parentalControl && !appStatus.parentalControl.isLocked && appStatus.parentalControl.showAdult;
  if (isAdultUnlocked) {
    items.push({
      id: 'VAULT_18',
      label: '18+ Vault',
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1.5" fill="#F59E0B"/></svg>`
    });
  }
  const isExtrasUnlocked = !isKids && Boolean(appStatus?.parentalControl && appStatus.parentalControl.showExtras);
  if (isExtrasUnlocked) {
    items.push({
      id: 'EXTRAS',
      label: 'Extras',
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="#38BDF8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`
    });
  }
  resetVaultIdleTimer();
  // Same tabs as last time: only move the highlight (rebuilding the list on every tab switch made it flicker)
  const sig = items.map((it) => it.id).join(',') + '|' + (isLocked ? 'L' : 'U');
  if (sig === sidebarSignature && container.children.length) {
    container.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    const sbEl = document.querySelector('.sidebar');
    if (sbEl && sbEl.dataset.fitted !== '1') fitSidebar();
  } else {
    sidebarSignature = sig;
    container.innerHTML = items.map((item) => {
      const disabledAttr = isLocked ? 'style="opacity:0.35;pointer-events:none;"' : '';
      return `
      <div tabindex="${isLocked ? '-1' : '0'}" class="nav-btn tv-focusable ${currentTab === item.id ? 'active' : ''}"
           data-tab="${escapeHtml(item.id)}"
           ${disabledAttr}
           onfocus="playNavSound()"
           title="${escapeHtml(item.label)}">
        <div class="nav-icon">${item.svg}</div>
        <span class="nav-label">${item.label}</span>
      </div>
    `;
    }).join('');
    fitSidebar();
  }

  const userPill = document.getElementById('sidebarUserProfilePill') || document.querySelector('.user-profile-pill');
  if (userPill) {
    if (isLocked) {
      userPill.style.opacity = '0.35';
      userPill.style.pointerEvents = 'none';
      userPill.tabIndex = -1;
    } else {
      userPill.style.opacity = '1';
      userPill.style.pointerEvents = 'auto';
      userPill.tabIndex = 0;
    }
    if (currentTab === 'PROFILE') userPill.classList.add('active');
    else userPill.classList.remove('active');
  }

  const settingsBtn = document.getElementById('sidebarSettingsBtn') || document.querySelector('.settings-icon-btn');
  if (settingsBtn) {
    if (currentTab === 'SETTINGS') settingsBtn.classList.add('active');
    else settingsBtn.classList.remove('active');
  }
}


// Sidebar Up/Down: the highlight moves at once (instant); the tab itself opens only after a short pause, so a fast
// run through the tabs never queues up page loads. Enter / OK opens it immediately.
let sidebarOpenTimer = null;
const SIDEBAR_OPEN_DELAY_MS = 250;
function sidebarFocusThenOpen(btn) {
  btn.focus();
  playNavSound();
  const tabId = btn.getAttribute('data-tab');
  if (sidebarOpenTimer) { clearTimeout(sidebarOpenTimer); sidebarOpenTimer = null; }
  if (!tabId || tabId === currentTab) return;
  sidebarOpenTimer = setTimeout(() => {
    sidebarOpenTimer = null;
    if (document.activeElement === btn && btn.getAttribute('data-tab') !== currentTab) navigateToTab(tabId);
  }, SIDEBAR_OPEN_DELAY_MS);
}



// ===== CONTENT PACK DOWNLOAD SCREEN: one big download (resumes if interrupted), then "Ready" =====
function packMb(n) { return (n / 1048576).toFixed(n > 1073741824 ? 0 : 1); }

async function ensurePackReady() {
  let st = null;
  try { const r = await fetch('/api/pack/status'); if (r.ok) st = await r.json(); } catch (_) {}
  if (!st || typeof st.ready !== 'boolean' || st.ready) return;   // already installed, or status unavailable (older app / test server)
  let box = document.getElementById('packOverlay');
  if (!box) {
    box = document.createElement('div');
    box.id = 'packOverlay';
    box.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#0B0B14;display:flex;align-items:center;justify-content:center;flex-direction:column;color:#fff;font-family:inherit;text-align:center;padding:40px;';
    document.body.appendChild(box);
  }
  const render = (s, extra) => {
    const total = s.bytesTotal || 0, done = s.bytesDone || 0;
    const pct = total > 0 ? Math.min(100, Math.floor(done * 100 / total)) : 0;
    const title = s.phase === 'READY' ? 'Ready' : s.phase === 'ERROR' ? 'Download paused' : 'Setting up StreamVault';
    const line = s.phase === 'DOWNLOADING' ? `Downloading content: ${packMb(done)} of ${packMb(total)} MB (${pct}%)`
      : s.phase === 'VERIFYING' ? 'Checking the download...'
      : s.phase === 'UNPACKING' ? 'Preparing the content...'
      : s.phase === 'READY' ? 'Everything is ready'
      : (s.message || 'Starting...');
    box.innerHTML = `<div style="font-size:34px;font-weight:800;margin-bottom:14px;">${title}</div>
      <div style="font-size:18px;color:#9CA3AF;margin-bottom:22px;max-width:760px;">${escapeHtml(line)}</div>
      <div style="width:560px;max-width:80%;height:14px;border-radius:7px;background:#23233A;overflow:hidden;"><div style="height:100%;width:${s.phase === 'READY' ? 100 : pct}%;background:var(--theme-accent,#8B5CF6);transition:width .4s;"></div></div>
      <div style="font-size:14px;color:#6B7280;margin-top:18px;">This one-time download keeps going if the connection drops. Keep the TV on and connected.</div>
      ${extra || ''}`;
  };
  const start = async () => { try { await fetch('/api/pack/start', { method: 'POST', body: '{}' }); } catch (_) {} };
  render(st);
  await start();
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    try { const r = await fetch('/api/pack/status'); if (r.ok) st = await r.json(); } catch (_) { continue; }
    if (st.ready) { render({ phase: 'READY' }); await new Promise((r) => setTimeout(r, 900)); break; }
    if (st.phase === 'ERROR' && !st.running) {
      // Stopped: offer Try again (OK) - never leave the person stuck on a blank screen
      render(st, '<button id="packRetry" tabindex="0" class="btn btn-primary tv-focusable" style="margin-top:26px;padding:12px 28px;font-size:16px;">Try again</button>');
      const btn = document.getElementById('packRetry');
      if (btn) { btn.focus(); await new Promise((res) => { btn.onclick = res; btn.onkeydown = (e) => { if (e.key === 'Enter') res(); }; }); }
      await start();
      continue;
    }
    render(st);
  }
  box.remove();
}


// Centralized delegated event handlers (eliminates interpolated inline JS strings on dynamic UI cards/buttons)
if (typeof document !== 'undefined' && !window.__svDelegatedUiBound) {
  window.__svDelegatedUiBound = true;
  document.addEventListener('error', function(e) {
    const t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    if (t.dataset.fallbackNext === '1') {
      t.style.display = 'none';
      if (t.nextElementSibling) t.nextElementSibling.style.display = 'flex';
    } else if (t.dataset.fallbackHide === '1') {
      t.style.display = 'none';
    }
  }, true);

  document.addEventListener('click', function(e) {
    const target = e.target && e.target.closest ? e.target : null;
    if (!target) return;

    const navBtn = target.closest('.nav-btn[data-tab]');
    if (navBtn) { navigateToTab(navBtn.getAttribute('data-tab')); return; }

    const scrollBtn = target.closest('.js-scroll-row');
    if (scrollBtn) { scrollRow(scrollBtn.dataset.scrollTarget, Number(scrollBtn.dataset.scrollDelta || 0)); return; }

    const heroPlay = target.closest('.js-hero-play');
    if (heroPlay) { playHeroMovie(heroPlay.dataset.dedupKey); return; }

    const openDetailBtn = target.closest('.js-open-detail');
    if (openDetailBtn) { openDetailModal(openDetailBtn.dataset.dedupKey); return; }

    const posterCard = target.closest('.poster-card[data-dedup-key]');
    if (posterCard) {
      const dk = posterCard.dataset.dedupKey;
      if (posterCard.classList.contains('show-more-card')) openFullMltCatalog(dk);
      else openDetailModal(dk);
      return;
    }

    const filterOpt = target.closest('.js-filter-opt');
    if (filterOpt) {
      const kind = filterOpt.dataset.filterKind;
      const val = filterOpt.dataset.filterVal || '';
      if (kind === 'adultCat') selectFilterAdultCategory(val);
      else if (kind === 'genre') selectFilterGenre(val);
      else if (kind === 'lang') selectFilterLang(val);
      return;
    }

    const liveTab = target.closest('.js-live-tab');
    if (liveTab) { selectLiveTab(liveTab.dataset.tabId); return; }

    const livePlay = target.closest('.js-live-play');
    if (livePlay) { startLivePlayback(livePlay.dataset.streamId, livePlay.dataset.chName || ''); return; }

    const profSwitch = target.closest('.js-profile-switch');
    if (profSwitch) { switchUserProfile(profSwitch.dataset.profileId); return; }

    const plEdit = target.closest('.js-playlist-edit');
    if (plEdit) { openEditPlaylistModal(plEdit.dataset.playlistId); return; }

    const plDel = target.closest('.js-playlist-del');
    if (plDel) { deletePlaylist(plDel.dataset.playlistId); return; }

    const detPlay = target.closest('.js-detail-play');
    if (detPlay) {
      startMoviePlayback(
        detPlay.dataset.dedupKey,
        Number(detPlay.dataset.verIdx || 0),
        Number(detPlay.dataset.startMs || 0),
        detPlay.dataset.epId || null
      );
      return;
    }

    const epCard = target.closest('.episode-card[data-ep-id]');
    if (epCard) { startMoviePlayback(epCard.dataset.dedupKey, 0, 0, epCard.dataset.epId); return; }

    const wlBtn = target.closest('.js-detail-watchlist');
    if (wlBtn) { toggleWatchlist(wlBtn.dataset.dedupKey); return; }

    const watchedBtn = target.closest('.js-detail-watched');
    if (watchedBtn) { toggleWatchedCoupled(watchedBtn.dataset.dedupKey); return; }

    const starBtn = target.closest('.js-detail-star');
    if (starBtn) { toggleUserRating(starBtn.dataset.dedupKey, Number(starBtn.dataset.star || 1)); return; }

    const detTab = target.closest('.js-detail-tab');
    if (detTab) { switchDetailLowerTab(detTab.dataset.detailTab); return; }

    const sPill = target.closest('.season-pill[data-season]');
    if (sPill) { selectSeriesSeason(Number(sPill.dataset.season || 1)); return; }

    const mltChip = target.closest('.js-mlt-chip');
    if (mltChip) { changeMltMode(mltChip.dataset.dedupKey, mltChip.dataset.mode); return; }

    const mltHide = target.closest('.js-mlt-hide-watched');
    if (mltHide) { toggleMltHideWatched(mltHide.dataset.dedupKey); return; }

    const sugg = target.closest('.search-suggestion-item');
    if (sugg) {
      if (sugg.classList.contains('is-history') && typeof historyLongPressTriggered !== 'undefined' && historyLongPressTriggered) return;
      applySearchSuggestion(sugg.dataset.query || '');
      return;
    }
  });
}
