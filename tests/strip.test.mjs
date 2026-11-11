// Catalog loading strip + "Check for new titles" result message.
// The mock answers /api/state like the real TV (syncStatus with stage / processedItems / estimatedTotal / note).
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'strip-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN) => {
    window.fetch = async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const mk = i => ({ dedupKey: 'm' + i, id: 'm' + i, cleanTitle: 'Title ' + i, mediaType: 'MOVIE', year: 2000, rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, episodes: [] });
    const catalog = Array.from({ length: 12 }, (_, i) => mk(i));
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    window.__sync = { isSyncing: false, phase: '', lastSyncTimestamp: 0 };
    window.__total = 0;
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: window.__total, syncStatus: window.__sync, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return window.__total === 0 ? J({ hero: null, rows: [] }) : J({ hero: catalog[0], rows: [{ title: 'Featured', items: catalog }] });
        if (p === '/api/query') return J({ items: catalog, totalMatched: 12, hasMore: false });
        return J({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await sleep(500);
  return page;
}
const strip = page => page.evaluate(() => { const e = document.getElementById('catalogStrip'); return e && e.style.display !== 'none' ? e.innerText.trim() : ''; });
const poll = async page => { await page.evaluate(async () => { await refreshAppStatus(); renderCatalogStrip(); }); await sleep(100); };
const go = async (page, tab) => { await page.evaluate(t => window.navigateToTab(t), tab); await sleep(600); };

async function run() {
  console.log('=== StreamVault TV — loading strip ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await newApp(browser);

  console.log('First load');
  await page.evaluate(() => { window.__sync = { isSyncing: true, phase: 'Parsed 12400 Movies', stage: 'Movies', processedItems: 12400, estimatedTotal: 69800, lastSyncTimestamp: 0 }; });
  await go(page, 'HOME'); await poll(page);
  let t = await strip(page);
  check('strip shows the stage, the count and "about" total', /Loading your catalog: Movies 12,400 of about 69,800/.test(t), t);
  check('strip says you can browse now', /you can browse now/.test(t), t);
  await go(page, 'MOVIES'); await poll(page);
  t = await strip(page);
  check('on Movies it also warns that some titles may not show yet', /some titles may not show yet/.test(t), t);
  check('the strip never takes focus (no tabindex, pointer-events none)', await page.evaluate(() => { const e = document.getElementById('catalogStrip'); return e.getAttribute('tabindex') === null && getComputedStyle(e).pointerEvents === 'none'; }));
  check('the page is pushed down by the strip, not covered', await page.evaluate(() => { const v = document.getElementById('mainViewport').getBoundingClientRect(); return v.top >= 22 && v.bottom <= innerHeight + 1; }));
  await page.evaluate(() => { window.__sync = { isSyncing: true, stage: 'Adult & Extras', processedItems: 0, estimatedTotal: 0, lastSyncTimestamp: 0 }; });
  await poll(page); t = await strip(page);
  check('the last stage says "finishing up" and never names Adult or Extras', /finishing up/.test(t) && !/adult|extras|18/i.test(t), t);
  await go(page, 'SETTINGS'); await poll(page);
  check('hidden on Settings (that screen has its own status)', (await strip(page)) === '');
  await go(page, 'HOME');

  console.log('\nCheck for new titles (catalog already there)');
  await page.evaluate(() => { window.__total = 12; window.__sync = { isSyncing: true, stage: 'Movies', processedItems: 500, estimatedTotal: 69800, lastSyncTimestamp: 1700000000000 }; });
  await poll(page); t = await strip(page);
  check('a refresh shows only a quiet "Checking for new titles…"', /^Checking for new titles/.test(t) && !/Loading your catalog/.test(t), t);
  check('the quiet style is used', await page.evaluate(() => document.getElementById('catalogStrip').classList.contains('quiet')));
  await page.evaluate(() => { window.__sync = { isSyncing: false, stage: '', note: '12 new titles added, 5 removed.', lastSyncTimestamp: 1700000009999 }; window.catalogStripWasSyncing = true; });
  await page.evaluate(async () => { catalogStripWasSyncing = true; await refreshAppStatus(); const s = appStatus.syncStatus; if (catalogStripWasSyncing && !s.isSyncing && s.note) showToast(escapeHtml(s.note)); renderCatalogStrip(); });
  await sleep(200);
  const toast = await page.evaluate(() => { const e = document.getElementById('tvToastNotification'); return e ? e.innerText : ''; });
  check('the result message is shown when the check ends', /12 new titles added, 5 removed/.test(toast), toast);
  check('strip disappears when nothing is running', (await strip(page)) === '');

  console.log('\nDetails lookup');
  await page.evaluate(() => { window.__sync = { isSyncing: false, phase: 'TMDB Enriching: 3200 / 69800 Titles', enrichedCount: 3200, totalToEnrich: 69800, lastSyncTimestamp: 1700000009999 }; });
  await poll(page); t = await strip(page);
  check('quiet strip shows "Adding details and ratings: 3,200 of 69,800 titles"', /Adding details and ratings: 3,200 of 69,800 titles/.test(t), t);
  await page.evaluate(() => { window.__sync = { isSyncing: false, phase: 'Details loaded (69000 of 69800). 800 titles could not be looked up right now', enrichedCount: 69000, totalToEnrich: 69800, lastSyncTimestamp: 1700000009999 }; });
  await poll(page);
  check('a paused lookup does not leave a stuck strip', (await strip(page)) === '');
  check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
