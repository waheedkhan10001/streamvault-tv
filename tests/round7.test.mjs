// Round 7: the app remembers the title you were on in each tab, empty results can be fixed with the remote,
// "Report a problem" opens and closes, channel +/- on the remote zaps through the list that was on screen.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'r7-ui-session-token-0123456789abcdef0123456789abcdef';
let bad = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); if (!ok) bad++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser, { empty = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN, empty) => {
    window.fetch = async (u) => {
      if (String(u).includes('/api/diag')) return new Response(JSON.stringify({ ok: true, appVersion: '9.9.9', device: 'Test TV, Android 11', titles: 120, enriched: 100, cloudPending: 7, cloudPausedUntil: 0, signedIn: true, lastCrash: null, lines: ['11-12 10:00:00  App started', '11-12 10:01:00  Cloud refused an upload'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const mk = i => ({ dedupKey: 'm' + i, id: 'm' + i, cleanTitle: 'Title ' + i, mediaType: 'MOVIE', year: 2000 + (i % 20), rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, episodes: [] });
    const items = Array.from({ length: 30 }, (_, i) => mk(i + 1));
    window.AndroidApp = {
      handleApiRequest: (a, b, c) => window.AndroidApp.handleApiRequestWithAuth(a, b, c, null),
      handleApiRequestWithAuth: (method, path) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 30, syncStatus: {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [{ id: 'pl1', name: 'Main', serverUrl: 'http://x', username: 'u', status: 'ready', isActive: true }] });
        if (p === '/api/home') return J({ hero: items[0], rows: [{ title: 'Featured', items: items.slice(0, 10) }] });
        if (p === '/api/query') return empty ? J({ items: [], totalMatched: 0, hasMore: false }) : J({ items, totalMatched: 30, hasMore: false });
        if (p === '/api/diag') return J({ ok: true, appVersion: '9.9.9', device: 'Test TV, Android 11', titles: 120, enriched: 100, cloudPending: 7, cloudPausedUntil: 0, signedIn: true, lastCrash: null, lines: ['11-12 10:00:00  App started', '11-12 10:01:00  Cloud refused an upload'] });
        return J({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN, empty);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => window.navigateToTab('HOME'));
  await sleep(800);
  return page;
}
const press = async (page, key, n = 1, gap = 90) => { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(gap); } };
const activeKey = page => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || (a.getAttribute('onclick') || '').slice(0, 40) || a.className.split(' ')[0]) : 'none'; });

async function run() {
  console.log('=== StreamVault TV — round 7 ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });

  // ---- remembers the title in each tab
  let page = await newApp(browser);
  await page.evaluate(() => navigateToTab('MOVIES'));
  await sleep(1200);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#filterResultsGrid .poster-card')][6]; c.focus(); });
  await sleep(150);
  const seventh = await activeKey(page);
  await page.evaluate(() => navigateToTab('SETTINGS'));
  await sleep(900);
  await page.evaluate(() => { document.querySelector('.nav-btn[data-tab="MOVIES"]').focus(); });
  await sleep(100);
  await page.evaluate(() => navigateToTab('MOVIES', null, true));
  await sleep(1700);
  const back = await activeKey(page);
  check('coming back to Movies lands on the title you left, not the first one', seventh.includes('m7') && back === seventh, `${seventh} vs ${back}`);

  // same tab: Left to the sidebar and Right again
  await page.evaluate(() => { const c = [...document.querySelectorAll('#filterResultsGrid .poster-card')][11]; c.focus(); });
  await sleep(100);
  const twelfth = await activeKey(page);
  await page.evaluate(() => document.querySelector('.nav-btn[data-tab="MOVIES"]').focus());
  await sleep(100);
  await press(page, 'ArrowRight');
  await sleep(200);
  check('Left to the sidebar and Right again returns to the same title', (await activeKey(page)) === twelfth, await activeKey(page));
  check('no page errors so far', page.errors.length === 0, page.errors.join(' | '));

  // ---- Report a problem
  await page.evaluate(() => navigateToTab('SETTINGS'));
  await sleep(1000);
  const btn = await page.evaluate(() => !!document.getElementById('btnReportProblem'));
  check('Settings has a "Report a problem" button', btn);
  await page.evaluate(() => document.getElementById('btnReportProblem').focus());
  await press(page, 'Enter');
  await sleep(500);
  const open = await page.evaluate(() => ({ shown: document.getElementById('diagModal').style.display, text: document.getElementById('diagText').textContent, focus: document.activeElement && document.activeElement.id }));
  check('the report opens with the close button focused', open.shown === 'flex' && open.focus === 'btnDiagClose', JSON.stringify(open));
  check('the report shows version, counts and recent events', /9\.9\.9/.test(open.text) && /Titles: 120/.test(open.text) && /Cloud refused an upload/.test(open.text), open.text);
  await press(page, 'ArrowLeft');
  check('Left from Close reaches Refresh (stays inside the popup)', (await activeKey(page)) === 'btnDiagRefresh', await activeKey(page));
  await press(page, 'Escape');
  await sleep(300);
  const closed = await page.evaluate(() => ({ shown: document.getElementById('diagModal').style.display, focus: document.activeElement && document.activeElement.id }));
  check('Back closes the report and returns to its button', closed.shown === 'none' && closed.focus === 'btnReportProblem', JSON.stringify(closed));

  // ---- channel +/- zaps through the list on screen
  const zap = await page.evaluate(async () => {
    const played = [];
    window.startLivePlayback = async (id) => { played.push(id); liveZapCurrentId = id; };
    liveZapList = [{ streamId: 'c1', name: 'One' }, { streamId: 'c2', name: 'Two' }, { streamId: 'c3', name: 'Three' }];
    liveZapCurrentId = 'c3';
    await window.zapLiveChannel(1);   // after the last comes the first
    await window.zapLiveChannel(-1);  // and back
    await window.zapLiveChannel(-1);
    return played;
  });
  check('channel up/down walks the list and wraps around', JSON.stringify(zap) === JSON.stringify(['c1', 'c3', 'c2']), JSON.stringify(zap));
  await page.close();

  // ---- empty results can be fixed with the remote
  page = await newApp(browser, { empty: true });
  await page.evaluate(() => navigateToTab('MOVIES'));
  await sleep(1500);
  const emptyBtn = await page.evaluate(() => { const b = document.getElementById('btnResetFiltersEmpty'); return b ? { focusable: b.classList.contains('tv-focusable'), tab: b.tabIndex } : null; });
  check('an empty result offers a "Reset all filters" button the remote can reach', !!emptyBtn && emptyBtn.focusable && emptyBtn.tab === 0, JSON.stringify(emptyBtn));
  check('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await page.close();

  await browser.close();
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nall round 7 checks passed');
  process.exit(bad ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
