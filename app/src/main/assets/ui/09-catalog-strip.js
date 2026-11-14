function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.onload = init;

// Keep the Movies / Series / Live TV panel bar on top of every re-render inside the 18+ and Extras tabs
(function () {
  const origSuper = loadSuperFilter;
  loadSuperFilter = function (vp, ...rest) {
    const r = origSuper.call(this, vp, ...rest);
    injectVaultPanelBar(vp);
    return r;
  };
  const origLive = loadLiveTv;
  loadLiveTv = function (vp, ...rest) {
    const r = origLive.call(this, vp, ...rest);
    injectVaultPanelBar(vp);
    return r;
  };
})();

// ---- Catalog loading strip: "Loading your catalog: Movies 12,400 of about 69,800 · you can browse now" ----
let catalogStripTimer = null;
let catalogStripWasSyncing = false;
function formatCount(n) { return Number(n || 0).toLocaleString('en-US'); }
function catalogStripState() {
  const sync = (appStatus && appStatus.syncStatus) || {};
  const total = Number((appStatus && appStatus.totalCatalogCount) || 0);
  if (sync.isSyncing) {
    const firstLoad = !sync.lastSyncTimestamp || total === 0;
    if (!firstLoad) return { text: 'Checking for new titles…', quiet: true };
    const stage = sync.stage || '';
    const n = Number(sync.processedItems || 0);
    const est = Number(sync.estimatedTotal || 0);
    let head;
    if (stage === 'Movies' || stage === 'Series') {
      head = n > 0 ? `${stage} ${formatCount(n)}${est > n ? ' of about ' + formatCount(est) : ' loaded'}` : `${stage}…`;
    } else if (stage === 'Live TV') {
      head = 'Live TV channels…';
    } else if (stage === 'Connecting') {
      head = 'connecting to your IPTV provider…';
    } else {
      head = 'finishing up…';
    }
    const more = ['SEARCH', 'MOVIES', 'SERIES'].includes(currentTab) ? ' · some titles may not show yet' : '';
    return { text: `Loading your catalog: ${head} · you can browse now${more}`, quiet: false };
  }
  const enr = Number(sync.enrichedCount || 0), tot = Number(sync.totalToEnrich || 0);
  if (tot > 0 && enr < tot && /Enriching|Loading details|Starting Background/i.test(String(sync.phase || ''))) {
    return { text: `Adding details and ratings: ${formatCount(enr)} of ${formatCount(tot)} titles`, quiet: true };
  }
  return null;
}
function renderCatalogStrip() {
  let el = document.getElementById('catalogStrip');
  const welcome = document.getElementById('welcomeScreenOverlay');
  const hidden = !getStoredAuthToken() || (welcome && welcome.style.display !== 'none' && welcome.style.display !== '')
    || currentTab === 'SETTINGS' || currentTab === 'PROFILE';
  const st = hidden ? null : catalogStripState();
  if (!st) {
    if (el) el.style.display = 'none';
    document.body.classList.remove('strip-on');
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'catalogStrip';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  const html = `<span class="dot"></span><span>${escapeHtml(st.text)}</span>`;
  if (el.getAttribute('data-html') !== html) { el.innerHTML = html; el.setAttribute('data-html', html); }
  el.className = st.quiet ? 'quiet' : '';
  el.style.display = 'flex';
  document.body.classList.add('strip-on');
}

// "Is the one-time details & ratings lookup finished?"  (titles the lookup could not find right now are listed in the phase text)
let enrichWasRunning = false;
function enrichmentIsComplete(sync) {
  if (!sync || sync.isSyncing) return false;
  return /Catalog Enriched|Details loaded/i.test(String(sync.phase || ''));
}
function enrichStatusText(sync) {
  const enr = Number((sync && sync.enrichedCount) || 0), tot = Number((sync && sync.totalToEnrich) || 0);
  if (sync && sync.isSyncing) return { text: 'Starts after the provider list is checked', color: '#9CA3AF' };
  if (enrichmentIsComplete(sync)) {
    const missing = Math.max(0, tot - enr);
    return { text: '✓ Complete — ' + formatCount(enr) + ' titles ready', color: '#10B981' };
  }
  if (tot > 0 && enr < tot) return { text: 'Loading — ' + formatCount(enr) + ' of ' + formatCount(tot), color: '#FBBF24' };
  return { text: tot > 0 ? '✓ Complete' : 'Nothing to load yet', color: tot > 0 ? '#10B981' : '#9CA3AF' };
}
function updateEnrichStatusRow(sync) {
  const el = document.getElementById('settingsEnrichStatus');
  if (!el) return;
  const st = enrichStatusText(sync);
  el.textContent = st.text; el.style.color = st.color;
}
async function pollCatalogStrip() {
  let delay = 12000;
  try {
    if (getStoredAuthToken()) {
      await refreshSyncStatusOnly();
      const sync = (appStatus && appStatus.syncStatus) || {};
      if (catalogStripWasSyncing && !sync.isSyncing && sync.note) showToast(escapeHtml(sync.note));
      catalogStripWasSyncing = !!sync.isSyncing;
      // When the details lookup finishes while the app is open: say so once ("everything is ready")
      const doneNow = enrichmentIsComplete(sync);
      if (enrichWasRunning && doneNow) showToast('✓ All set: details and ratings are ready for ' + formatCount(sync.enrichedCount) + ' titles. The app is at full speed.');
      enrichWasRunning = !doneNow && Number(sync.totalToEnrich || 0) > 0 && !sync.isSyncing;
      updateEnrichStatusRow(sync);
      renderCatalogStrip();
      if (sync.isSyncing || catalogStripState()) delay = 2500;
    } else {
      renderCatalogStrip();
    }
  } catch (_) {}
  catalogStripTimer = setTimeout(pollCatalogStrip, delay);
}
window.addEventListener('load', () => { setTimeout(pollCatalogStrip, 1500); });


// Rating as shown on screen: a coloured star + the number. Yellow star = IMDb rating, bronze star = TMDB rating
// (the detail screen also shows the vote count).
function ratingStar(m) {
  const color = m && m.ratingSource === 'T' ? '#CD7F32' : '#FFC83D';
  return `<span style="color:${color}">★</span>`;
}
function ratingText(m, withVotes) {
  const r = Number(m.rating) || 0;
  const v = Number(m.voteCount) || 0;
  const votes = withVotes && v > 0 ? ` (${v.toLocaleString('en-US')} votes)` : '';
  return `${r.toFixed(1)}${votes}`;
}


// ---- Problem-report helpers: the screen reports freezes, errors and tab opening times to the report screen ----
(function () {
  const q = [];
  function note(t) { if (q.length < 60) q.push(t); }
  window.svDiagNote = note;
  // freeze detector: a 100 ms timer that fires much later means the screen was stuck
  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), gap = now - last - 100;
    last = now;
    if (gap > 200) note('screen froze ' + Math.round(gap) + ' ms (tab ' + currentTab + ')');
  }, 100);
  window.addEventListener('error', (e) => note('script error: ' + String(e.message).slice(0, 120) + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => note('unhandled: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 120)));
  // how long each tab takes from open to drawn
  try {
    const orig = window.navigateToTab;
    window.navigateToTab = async function () {
      const t0 = performance.now(), tab = arguments[0];
      const r = await orig.apply(this, arguments);
      note('tab ' + tab + ' opened in ' + Math.round(performance.now() - t0) + ' ms');
      return r;
    };
  } catch (_) {}
  setInterval(() => {
    if (!q.length) return;
    const events = q.splice(0, q.length);
    fetch('/api/diag/js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) }).catch(() => {});
  }, 8000);
})();
