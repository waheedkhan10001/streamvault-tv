// Round 6: sidebar opens a tab only after a pause, Left/Right/Back go where the remote expects, themes change the whole look.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'r6-ui-session-token-0123456789abcdef0123456789abcdef';
let bad = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); if (!ok) bad++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN) => {
    window.__calls = [];
    window.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const mk = i => ({ dedupKey: 'm' + i, id: 'm' + i, cleanTitle: 'Title ' + i, mediaType: 'MOVIE', year: 2000 + (i % 20), rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, episodes: [] });
    const items = Array.from({ length: 30 }, (_, i) => mk(i + 1));
    window.AndroidApp = {
      handleApiRequest: (a, b, c) => window.AndroidApp.handleApiRequestWithAuth(a, b, c, null),
      handleApiRequestWithAuth: (method, path) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        window.__calls.push(p);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 30, syncStatus: window.__sync || {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/sync/status') return J({ ok: true, syncStatus: window.__sync || {} });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [{ id: 'pl1', name: 'Main', serverUrl: 'http://x', username: 'u', status: 'ready', isActive: true }] });
        if (p === '/api/home') return J({ hero: items[0], rows: [{ title: 'Featured', items: items.slice(0, 10) }, { title: 'More', items: items.slice(10, 20) }] });
        if (p === '/api/query') return J({ items, totalMatched: 30, hasMore: false });
        if (p === '/api/latest') return J({ ok: true, movies: [], series: [], live: [], days: 14 });
        return J({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => window.navigateToTab('HOME'));
  await sleep(800);
  return page;
}
const tab = page => page.evaluate(() => currentTab);
const focusInfo = page => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset?.tab ? 'tab:' + a.dataset.tab : a.id || a.className.split(' ')[0] || a.tagName) : 'none'; });
const press = async (page, key, n = 1, gap = 90) => { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(gap); } };

async function run() {
  console.log('=== StreamVault TV — round 6 ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await newApp(browser);

  console.log('Sidebar: fast Up/Down');
  await page.evaluate(() => document.querySelector('.nav-btn[data-tab="HOME"]').focus());
  await page.evaluate(() => { window.__calls.length = 0; });
  await press(page, 'ArrowDown', 3, 60);
  const during = await page.evaluate(() => ({ focus: document.activeElement.dataset.tab, open: currentTab, calls: window.__calls.filter(c => c === '/api/home' || c === '/api/query').length }));
  check('the highlight moved three tabs at once', !!during.focus && during.focus !== 'HOME', JSON.stringify(during));
  check('no tab was opened while the keys were still being pressed', during.open === 'HOME' && during.calls === 0, JSON.stringify(during));
  await sleep(700);
  const after = await page.evaluate(() => ({ focus: document.activeElement.dataset.tab, open: currentTab, loads: window.__calls.filter(c => c === '/api/home' || c === '/api/query' || c === '/api/latest').length }));
  check('after the pause only the tab you stopped on opened', after.open === after.focus && after.loads <= 2, JSON.stringify(after));
  check('focus stays on that tab in the sidebar', (await focusInfo(page)).startsWith('tab:'));

  console.log('\nLeft / Back return to the open tab, not to Profile or Settings');
  await page.evaluate(() => window.navigateToTab('MOVIES')); await sleep(900);
  await page.evaluate(() => { const c = document.querySelector('#filterResultsGrid .poster-card'); c && c.focus(); });
  check('focus is on a movie card', (await focusInfo(page)).length > 0 && await page.evaluate(() => !!document.activeElement.closest('#filterResultsGrid')));
  await press(page, 'ArrowLeft');
  check('Left from the first card goes to the Movies tab', (await focusInfo(page)) === 'tab:MOVIES', await focusInfo(page));
  await press(page, 'ArrowRight', 1, 200);
  await press(page, 'Escape');
  check('Back from the first row goes to the search box first', (await focusInfo(page)) === 'filterSearchInput' || await page.evaluate(() => document.activeElement && document.activeElement.id === 'filterSearchInput'), await focusInfo(page));
  await press(page, 'Escape');
  check('Back from the search box goes to the Movies tab', (await focusInfo(page)) === 'tab:MOVIES', await focusInfo(page));
  await page.evaluate(() => { const c = document.querySelector('#filterResultsGrid .poster-card'); c && c.focus(); document.body.focus && 0; });
  await page.evaluate(() => { document.activeElement.blur(); });
  await press(page, 'Escape');
  check('Back with lost focus still goes to the Movies tab (not Home/Profile)', (await focusInfo(page)) === 'tab:MOVIES' && (await tab(page)) === 'MOVIES', `${await focusInfo(page)} / ${await tab(page)}`);

  console.log('\nTwo-column page: Right goes to the other column, Left to the sidebar');
  await page.evaluate(() => {
    const vp = document.getElementById('mainViewport');
    vp.innerHTML = `<div style="display:flex;gap:40px;padding:20px">
      <div id="colL" style="width:340px"><button id="l1" class="tv-focusable" style="display:block;width:340px;height:40px;margin-bottom:12px">L1</button><button id="l2" class="tv-focusable" style="display:block;width:330px;height:40px;margin-bottom:12px;margin-left:10px">L2</button><button id="l3" class="tv-focusable" style="display:block;width:340px;height:40px;margin-bottom:12px">L3</button></div>
      <div id="colR" style="width:340px"><button id="r1" class="tv-focusable" style="display:block;width:340px;height:40px;margin-bottom:12px">R1</button><button id="r2" class="tv-focusable" style="display:block;width:340px;height:40px;margin-bottom:12px">R2</button></div></div>`;
    document.getElementById('l2').focus();
  });
  await press(page, 'ArrowRight');
  check('Right from the middle of the left column goes to the right column', (await focusInfo(page)) === 'r2' || (await focusInfo(page)) === 'r1', await focusInfo(page));
  await press(page, 'ArrowLeft');
  check('Left from the right column comes back to the left column', ['l1', 'l2', 'l3'].includes(await focusInfo(page)), await focusInfo(page));
  await page.evaluate(() => document.getElementById('l1').focus());
  await press(page, 'ArrowLeft');
  check('Left from the left column goes to the open tab in the sidebar', (await focusInfo(page)) === 'tab:MOVIES', await focusInfo(page));
  await page.evaluate(() => document.getElementById('l1').focus());
  await press(page, 'ArrowDown', 2);
  check('Down walks down the same column', (await focusInfo(page)) === 'l3', await focusInfo(page));

  console.log('\nDetails & ratings completion indicator');
  await page.evaluate(() => { window.__sync = { isSyncing: false, phase: 'TMDB Enriching: 3200 / 69800 Titles', enrichedCount: 3200, totalToEnrich: 69800, lastSyncTimestamp: 1 }; });
  await page.evaluate(async () => { await refreshAppStatus(); updateEnrichStatusRow(appStatus.syncStatus); });
  await page.evaluate(() => window.navigateToTab('SETTINGS')); await sleep(1300);
  let st = await page.evaluate(() => document.getElementById('settingsEnrichStatus')?.innerText || '');
  check('Settings shows the progress while loading', /Loading — 3,200 of 69,800/.test(st), st);
  await page.evaluate(() => { window.__sync = { isSyncing: false, phase: '100% Catalog Enriched (69800 Titles Ready)', enrichedCount: 69800, totalToEnrich: 69800, lastSyncTimestamp: 1 }; });
  await page.evaluate(async () => { enrichWasRunning = true; await pollCatalogStrip(); });
  await sleep(250);
  st = await page.evaluate(() => document.getElementById('settingsEnrichStatus')?.innerText || '');
  const toast = await page.evaluate(() => { const e = document.getElementById('tvToastNotification'); return e ? e.innerText : ''; });
  check('Settings shows "Complete" when everything is loaded', /Complete — 69,800 titles ready/.test(st), st);
  check('a one-time "All set" message appears when the lookup finishes', /All set/.test(toast), toast);

  console.log('\nThemes change the whole look');
  const look = async t => { await page.evaluate(k => applyProfileTheme(k), t); await sleep(80); return page.evaluate(() => { const cs = getComputedStyle(document.body); const sb = getComputedStyle(document.querySelector('.sidebar')); return { bg: cs.backgroundColor, panel: sb.backgroundColor }; }); };
  const purple = await look('purple'), red = await look('netflix'), blue = await look('disney'), cyan = await look('prime');
  const rgb = s => s.match(/\d+/g).map(Number);
  check('the red theme has a warm dark background (not purple)', rgb(red.bg)[0] >= rgb(red.bg)[2] && rgb(red.panel)[0] >= rgb(red.panel)[2], JSON.stringify(red));
  check('the blue theme has a blue dark background', rgb(blue.bg)[2] > rgb(blue.bg)[0] + 8, JSON.stringify(blue));
  check('the cyan theme has a teal dark background', rgb(cyan.bg)[1] >= rgb(cyan.bg)[0], JSON.stringify(cyan));
  check('every theme has its own background', new Set([purple.bg, red.bg, blue.bg, cyan.bg]).size === 4, JSON.stringify([purple.bg, red.bg, blue.bg, cyan.bg]));
  check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));
  await browser.close();
  console.log(`\n${bad ? bad + ' FAILED' : 'all round 6 checks passed'}`);
  process.exit(bad ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
