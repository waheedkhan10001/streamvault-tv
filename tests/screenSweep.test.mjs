// Whole-app remote-control sweep (Puppeteer, REAL key presses).
// For every screen: walk it with 150 pseudo-random arrow presses and check focus is never lost (stuck on <body>,
// hidden, or off the screen), every control is reachable with the arrows, and Back never strands focus.
// Also covers the Detail screen (movie + series) and the "Who's watching?" picker.
// The native Kotlin layer is a JS mock; this proves the page's own remote-control logic only.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'sweep-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser, { twoProfiles = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN, twoProfiles) => {
    const mk = (i, series) => ({
      dedupKey: (series ? 'ser_' : 'mov_') + i, id: (series ? 'ser_' : 'mov_') + i, cleanTitle: (series ? 'Series Title ' : 'Movie Title ') + i,
      mediaType: series ? 'SERIES' : 'MOVIE', year: 2000 + i, rating: 5 + (i % 5), posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English',
      genres: ['Drama', 'Action'], plot: 'A sample plot for title ' + i + '.', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0,
      episodes: series ? [1, 2].flatMap(s => [1, 2, 3].map(e => ({ season: s, episode: e, title: 'Episode ' + e, id: `e_${i}_${s}_${e}` }))) : []
    });
    const catalog = [...Array.from({ length: 18 }, (_, i) => mk(i, false)), ...Array.from({ length: 8 }, (_, i) => mk(i, true))];
    window.fetch = async (url) => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'acc_1', email: 'owner@streamvault.tv', displayName: 'Account Owner' };
    const profiles = [{ id: 'prof_primary', name: 'Account Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    if (twoProfiles) profiles.push({ id: 'prof_kids', name: 'Kids', avatarColor: '#10B981', isKids: true, theme: 'purple', isPrimary: false, updatedAt: 1 });
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const p = path.split('?')[0];
        if (p === '/api/state') return JSON.stringify({ ok: true, totalCatalogCount: catalog.length, credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'u' }, parentalControl: { isLocked: true, showAdult: false, hasPin: true, hasCustomPin: true } });
        if (p === '/api/status') return JSON.stringify({ ok: true, credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'u', password: 'p' }, catalogCount: catalog.length });
        if (p === '/api/session') return JSON.stringify({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return JSON.stringify({ ok: true, account, token: TOKEN });
        if (p === '/api/playlists') return JSON.stringify({ ok: true, playlists: [{ playlist_id: 'pl_1', name: 'Primary IPTV', server_url: 'http://iptv.example.com:8080', username: 'u', password: 'p', is_enabled: 1, status: 'working' }] });
        if (p === '/api/profiles') return JSON.stringify({ ok: true, profiles, activeProfileId: 'prof_primary' });
        if (p === '/api/home') return JSON.stringify({ hero: catalog[0], rows: [{ title: 'Featured', items: catalog.slice(0, 14) }, { title: 'Series', items: catalog.slice(18) }, { title: 'Trending', items: catalog.slice(4, 16) }] });
        if (p === '/api/query') return JSON.stringify({ items: catalog, totalMatched: catalog.length, total: catalog.length, hasMore: false });
        if (p === '/api/watchlist') return JSON.stringify({ ok: true, items: catalog.slice(0, 5) });
        if (p === '/api/detail') { const k = new URLSearchParams(path.split('?')[1] || '').get('dedupKey'); return JSON.stringify({ item: catalog.find(c => c.dedupKey === k) || catalog[0], related: catalog.slice(2, 8) }); }
        if (p === '/api/search-history') return JSON.stringify({ ok: true, history: ['matrix', 'dune'], items: ['matrix', 'dune'] });
        if (p === '/api/continue-watching') return JSON.stringify({ ok: true, items: [] });
        if (p === '/api/probe-versions') return JSON.stringify({ ok: true, results: [] });
        if (p === '/api/parental-pin') return JSON.stringify({ success: true, ok: true, hasCustomPin: true, hasPin: true });
        return JSON.stringify({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN);
    localStorage.setItem('streamvault_session_token', TOKEN);
    localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN, twoProfiles);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  return { page, pageErrors };
}

// Where is focus? ok = a visible element that is on the screen
const focusInfo = page => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { ok: false, name: 'nothing (page body)' };
  const r = a.getBoundingClientRect();
  const visible = a.offsetParent !== null || getComputedStyle(a).position === 'fixed';
  const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  return { ok: visible && onScreen, name: (a.id || a.className || a.tagName).toString().slice(0, 40) + (visible ? '' : ' [hidden]') + (onScreen ? '' : ' [off screen]') };
});

async function walk(page, label, startSel, steps = 150, seed = 7) {
  await page.evaluate(sel => { const el = sel && document.querySelector(sel); if (el) el.focus(); }, startSel);
  await sleep(100);
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const keys = ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
  let lost = null, last = '';
  for (let i = 0; i < steps; i++) {
    const k = keys[Math.floor(rnd() * keys.length)];
    await page.keyboard.press(k); await sleep(35);
    const f = await focusInfo(page);
    if (!f.ok && !lost) { await sleep(250); const f2 = await focusInfo(page); if (!f2.ok) lost = `after ${k} (step ${i + 1}, was on "${last}") focus is on ${f2.name}`; }
    last = f.name;
  }
  check(`${label}: ${steps} random remote presses never lose focus`, !lost, lost || '');
}

const reachability = (page, scopeSel) => page.evaluate((scopeSel) => {
  const scope = document.querySelector(scopeSel) || document.body;
  const vis = el => !el.disabled && el.getAttribute('tabindex') !== '-1' && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
  const els = Array.from(scope.querySelectorAll('.tv-focusable, input:not([type=hidden])')).filter(e => vis(e) && !e.classList.contains('chevron-btn'));
  const name = el => el.id || ((el.innerText || el.placeholder || el.className || el.tagName) + '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const keys = [['ArrowUp', 38], ['ArrowDown', 40], ['ArrowLeft', 37], ['ArrowRight', 39]];
  const edges = new Map(els.map(e => [e, new Set()]));
  for (const el of els) for (const [k, c] of keys) {
    if (typeof closeAllDropdowns === 'function') closeAllDropdowns();
    el.focus(); window.handleTvKeyEvent(k, c);
    const to = document.activeElement;
    if (to && to !== el && edges.has(to)) edges.get(el).add(to);
  }
  const start = els[0];
  const seen = new Set([start]); const q = [start];
  while (q.length) { const n = q.shift(); for (const m of edges.get(n) || []) if (!seen.has(m)) { seen.add(m); q.push(m); } }
  return { total: els.length, missing: els.filter(e => !seen.has(e)).map(name) };
}, scopeSel);

async function run() {
  console.log('=== StreamVault TV — Whole-app remote-control sweep ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });

  // ---- Who's watching picker ----
  console.log('1. "Who\'s watching?" picker');
  {
    const { page, pageErrors } = await newApp(browser, { twoProfiles: true });
    await sleep(600);
    const shown = await page.evaluate(() => document.getElementById('profilePickerOverlay')?.style.display === 'flex');
    check('picker is shown when there are 2 profiles', shown);
    if (shown) {
      const f0 = await focusInfo(page);
      check('focus is on a profile card when it opens', f0.ok && /profile-picker-card/.test(f0.name), f0.name);
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowLeft']) {
        await page.keyboard.press(k); await sleep(120);
        const f = await focusInfo(page);
        if (!f.ok || !(await page.evaluate(() => !!document.activeElement.closest('#profilePickerOverlay')))) { check(`picker: ${k} keeps focus on the cards`, false, f.name); break; }
      }
      await page.keyboard.press('Enter'); await sleep(900);
      const left = await page.evaluate(() => document.getElementById('profilePickerOverlay')?.style.display !== 'flex');
      check('OK on a card closes the picker', left);
      const f1 = await focusInfo(page);
      check('after picking, focus is on a visible control', f1.ok, f1.name);
      const one = await page.evaluate(async () => {
        const navs = Array.from(document.querySelectorAll('.nav-btn')).map(n => n.dataset.tab);
        const cur = document.querySelector('.nav-btn.active') || document.querySelector('.nav-btn'); cur.focus();
        return { navs, from: cur.dataset.tab };
      });
      await page.keyboard.press('ArrowDown'); await sleep(300);
      const after = await page.evaluate(() => document.activeElement?.dataset?.tab);
      check('one Down press moves exactly one step in the sidebar (keys not registered twice)', after === one.navs[one.navs.indexOf(one.from) + 1], `moved from ${one.from} to ${after}`);
    }
    check('no JavaScript errors', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  // ---- Main screens ----
  const { page, pageErrors } = await newApp(browser);
  await page.evaluate(() => { const p = document.getElementById('profilePickerOverlay'); if (p && p.style.display === 'flex') p.querySelector('.profile-picker-card')?.click(); });
  await sleep(500);

  const tabs = [
    ['HOME', '.nav-btn[data-tab="HOME"]'], ['SEARCH', '.nav-btn[data-tab="SEARCH"]'], ['MOVIES', '.nav-btn[data-tab="MOVIES"]'],
    ['SERIES', '.nav-btn[data-tab="SERIES"]'], ['LIVE_TV', '.nav-btn[data-tab="LIVE_TV"]'], ['WATCHLIST', '.nav-btn[data-tab="WATCHLIST"]'],
    ['PROFILE', '.user-profile-pill'], ['SETTINGS', '.settings-icon-btn'],
  ];
  for (const [tab, sel] of tabs) {
    console.log(`\n2. Screen: ${tab}`);
    const exists = await page.evaluate(sel => !!document.querySelector(sel), sel);
    if (!exists) { console.log(`  (skipped: no sidebar button "${sel}" on this build)`); continue; }
    await page.evaluate(async t => { await window.navigateToTab(t); }, tab);
    await sleep(900);
    const f0 = await focusInfo(page);
    await walk(page, tab, sel, 150, tab.length * 11);
    // Arrows on the sidebar switch tabs, so the walk may have left this screen: open it again before measuring
    await page.evaluate(async t => { await window.navigateToTab(t); }, tab);
    await sleep(900);
    if (['SEARCH', 'MOVIES', 'SERIES'].includes(tab)) {
      // Real key path: search box -> (recent searches) -> filter chips left to right -> first poster -> back up
      const nm = () => page.evaluate(() => { const a = document.activeElement; return (a.id || (a.innerText || a.className) + '').toString().trim().replace(/\s+/g, ' '); });
      await page.evaluate(() => document.getElementById('filterSearchInput')?.focus());
      let guard = 0, name = await nm();
      while (!/^Genre/.test(name) && guard++ < 6) { await page.keyboard.press('ArrowDown'); await sleep(130); name = await nm(); }
      check(`${tab}: Down from the search box reaches the filter chips`, /^Genre/.test(name), `ended on "${name}"`);
      const chips = [name];
      for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await sleep(130); chips.push(await nm()); }
      check(`${tab}: Right walks all 7 filter chips`, new Set(chips).size === 7 && /^Reset/.test(chips[6]), chips.join(' > '));
      await page.keyboard.press('ArrowDown'); await sleep(200);
      check(`${tab}: Down from the chips reaches the posters`, await page.evaluate(() => !!document.activeElement.closest('.poster-card, .poster-grid')) || /Title/.test(await nm()), await nm());
    } else {
    const r = await reachability(page, '#mainViewport');
    check(`${tab}: every control on the screen (${r.total}) can be reached with the arrows`, r.missing.length === 0, 'unreachable: ' + r.missing.slice(0, 8).join(' | '));
    }
    // Sidebar <-> content: Right from the sidebar enters the screen, Left from its first control returns
    const hop = await page.evaluate((sel) => {
      const side = document.querySelector(sel);
      const vis = Array.from(document.querySelectorAll('#mainViewport .tv-focusable, #mainViewport input')).filter(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
      const minX = Math.min(...vis.map(e => e.getBoundingClientRect().left));
      const first = vis.find(e => e.getBoundingClientRect().left <= minX + 6);   // a control on the left edge
      let into = null, back = null;
      if (side) { side.focus(); window.handleTvKeyEvent('ArrowRight', 39); into = !!document.activeElement?.closest('#mainViewport'); }
      if (first) { first.focus(); window.handleTvKeyEvent('ArrowLeft', 37); back = !!document.activeElement?.closest('#sidebar, .sidebar'); }
      return { into, back, hasContent: !!first };
    }, sel);
    if (hop.hasContent) {
      check(`${tab}: Right from the sidebar enters the screen`, hop.into === true);
      check(`${tab}: Left from a left-edge control returns to the sidebar`, hop.back === true);
    }
    // Back from wherever we are must leave focus somewhere sensible
    await page.keyboard.press('Escape'); await sleep(300);
    const fb = await focusInfo(page);
    check(`${tab}: Back key leaves focus on a visible control`, fb.ok, fb.name);
    const onSidebar = await page.evaluate(() => !!document.activeElement?.closest('#sidebar, .sidebar'));
    if (!onSidebar) { await page.keyboard.press('Escape'); await sleep(300); }
  }

  // ---- Detail screen ----
  for (const [label, key] of [['movie', 'mov_3'], ['series', 'ser_2']]) {
    console.log(`\n3. Detail screen (${label})`);
    await page.evaluate(async () => { await window.navigateToTab('HOME'); });
    await sleep(500);
    await page.evaluate(k => window.openDetailModal(k), key);
    await sleep(900);
    const open = await page.evaluate(() => document.getElementById('detailOverlay').style.display !== 'none');
    check(`detail (${label}) opens`, open);
    const f0 = await focusInfo(page);
    check(`detail (${label}) opens with focus inside it`, f0.ok && await page.evaluate(() => !!document.activeElement.closest('#detailOverlay')), f0.name);
    await walk(page, `detail (${label})`, null, 120, 99);
    const inside = await page.evaluate(() => !!document.activeElement?.closest('#detailOverlay'));
    check(`detail (${label}): focus never leaves the detail screen`, inside, 'focus ended outside');
    const r = await reachability(page, '#detailOverlay');
    check(`detail (${label}): every control (${r.total}) can be reached`, r.missing.length === 0, 'unreachable: ' + r.missing.slice(0, 8).join(' | '));
    await page.keyboard.press('Escape'); await sleep(500);
    const closed = await page.evaluate(() => document.getElementById('detailOverlay').style.display === 'none');
    check(`detail (${label}): Back closes it`, closed);
    const fb = await focusInfo(page);
    check(`detail (${label}): focus returns to a visible control`, fb.ok, fb.name);
  }

  check('no JavaScript errors across all screens', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
