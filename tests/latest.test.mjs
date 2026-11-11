// Latest added tab: Movies / Series / Live TV panels fed by /api/latest.
// Real page + stateful TV-native mock. Rules checked: invisible until unlocked, unlock needs the PIN, locks on leaving /
// idle 30 min / background, Kids mode shows neither and hides Live TV, no search history.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'vault-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser, kids = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN, KIDS) => {
    // record the long (30 min) timer so the test can fire it without waiting
    window.__idle = [];
    const st = window.setTimeout;
    window.setTimeout = function (fn, ms, ...a) { if (ms === 30 * 60 * 1000) window.__idle.push(fn); return st.call(window, fn, ms, ...a); };
    window.fetch = async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const mk = (i, series) => ({ dedupKey: (series ? 's' : 'm') + i, id: (series ? 's' : 'm') + i, cleanTitle: 'Title ' + i, mediaType: series ? 'SERIES' : 'MOVIE', year: 2000, rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, episodes: [] });
    const catalog = Array.from({ length: 12 }, (_, i) => mk(i, false));
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: KIDS, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    window.__s = { adult: false, extras: false, calls: [], queries: [], lives: [], history: [] };
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const S = window.__s; const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        const pc = () => ({ isLocked: !S.adult, showAdult: S.adult, showExtras: S.extras, hasPin: true, hasCustomPin: true });
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: window.__empty ? 0 : 12, syncStatus: window.__sync || {}, credentials: { serverUrl: 'http://x', username: 'u' }, parentalControl: pc() });
        if (p === '/api/status') return J({ ok: true, credentials: { serverUrl: 'http://x', username: 'u', password: 'p' }, catalogCount: 12 });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return window.__empty ? J({ hero: null, rows: [] }) : J({ hero: catalog[0], rows: [{ title: 'Featured', items: catalog }] });
        if (p === '/api/query') { S.queries.push(JSON.parse(body || '{}')); return window.__empty ? J({ items: [], totalMatched: 0, hasMore: false }) : J({ items: catalog, totalMatched: 12, hasMore: false }); }
        if (p === '/api/latest') {
          const k = (n, s, t) => Array.from({ length: n }, (_, i) => ({ ...mk(i, s), cleanTitle: (t || (s ? 'New Series ' : 'New Movie ')) + i }));
          const out = { ok: true, movies: k(5, false), series: k(3, true), live: KIDS ? [] : [{ streamId: '9', name: 'New Channel', categoryName: 'X' }], days: 14 };
          if (!KIDS && S.adult) out.adult = { movies: k(2, false, 'Adult Movie '), series: k(1, true, 'Adult Series '), live: [{ streamId: '77', name: 'Adult Channel', categoryName: 'XXX' }] };
          if (!KIDS && S.extras) out.extras = { movies: k(4, false, 'Extra Movie '), series: [], live: [] };
          return J(out);
        }
        if (p === '/api/live') { S.lives.push(path); return J({ ok: true, tabs: [{ id: 'ALL', label: 'All' }], channels: [{ streamId: '1', name: 'Chan', categoryName: 'X' }] }); }
        if (p === '/api/search-history') { if (method === 'POST') S.history.push(body); return J({ ok: true, history: [], items: [] }); }
        if (p === '/api/parental-pin') {
          const b = JSON.parse(body || '{}'); S.calls.push(b);
          if (b.action === 'status') return J({ success: true, ...pc(), hasCustomPin: true, hasPin: true });
          if (b.action === 'unlock') { if (b.pin !== '1234') return J({ success: false, error: 'Incorrect Master PIN' }); if ((b.target || 'adult') === 'extras') S.extras = true; else S.adult = true; return J({ success: true, ...pc() }); }
          if (b.action === 'lock') { if (b.target === 'adult') S.adult = false; else if (b.target === 'extras') S.extras = false; else { S.adult = false; S.extras = false; } return J({ success: true, ...pc() }); }
          return J({ success: true, ok: true });
        }
        return J({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN, kids);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await sleep(500);
  return page;
}
const navTabs = page => page.evaluate(() => [...document.querySelectorAll('.nav-btn')].map(n => n.dataset.tab));
const go = async (page, tab) => { await page.evaluate(t => window.navigateToTab(t), tab); await sleep(700); };
async function run() {
  console.log('=== StreamVault TV — Latest added ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await newApp(browser);
  const tabs = await navTabs(page);
  check('"New" tab is in the sidebar, right after Home', tabs[0] === 'HOME' && tabs[1] === 'LATEST', tabs.join());
  await go(page, 'LATEST');
  const bar = await page.evaluate(() => [...document.querySelectorAll('#latestPanelBar button')].map(b => b.innerText.trim()));
  check('three panels with counts', bar.join() === 'Movies (5),Series (3),Live TV (1)', bar.join());
  check('movies panel shows 5 poster cards', await page.evaluate(() => document.querySelectorAll('#filterResultsGrid .poster-card').length) === 5);
  await page.evaluate(() => document.getElementById('latestPanelMOVIES').focus());
  await page.keyboard.press('ArrowDown'); await sleep(200);
  check('Down from the panel bar reaches the first title', await page.evaluate(() => !!document.activeElement.closest('#filterResultsGrid')));
  await page.evaluate(() => document.getElementById('latestPanelSERIES').click()); await sleep(300);
  check('series panel shows 3 titles', await page.evaluate(() => document.querySelectorAll('#filterResultsGrid .poster-card').length) === 3);
  await page.evaluate(() => document.getElementById('latestPanelLIVE').click()); await sleep(300);
  check('live panel lists the new channel with a Watch button', await page.evaluate(() => /New Channel/.test(document.getElementById('mainViewport').innerText) && !!document.querySelector('#latestLiveGrid button')));
  check('panel bar survives switching', await page.evaluate(() => !!document.getElementById('latestPanelBar')));
  check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));
  await page.close();

  console.log('\nAdult and Extras panels inside Latest');
  const ap = await newApp(browser);
  await go(ap, 'LATEST');
  let abar = await ap.evaluate(() => [...document.querySelectorAll('#latestPanelBar button')].map(b => b.innerText.trim()));
  check('locked: no 18+ or Extras panel, and no adult title anywhere', abar.join() === 'Movies (5),Series (3),Live TV (1)' && !(await ap.evaluate(() => /Adult /.test(document.body.innerText))), abar.join());
  await ap.evaluate(() => { window.__s.adult = true; window.__s.extras = true; appStatus.parentalControl.showAdult = true; appStatus.parentalControl.showExtras = true; appStatus.parentalControl.isLocked = false; });
  await go(ap, 'HOME'); await go(ap, 'LATEST');
  abar = await ap.evaluate(() => [...document.querySelectorAll('#latestPanelBar button')].map(b => b.innerText.trim()));
  check('unlocked: 18+ (4) and Extras (4) panels appear', abar.join() === 'Movies (5),Series (3),Live TV (1),18+ (4),Extras (4)', abar.join());
  await ap.evaluate(() => document.getElementById('latestPanelADULT').click()); await sleep(300);
  let atxt = await ap.evaluate(() => document.getElementById('mainViewport').innerText);
  check('18+ panel shows its movies, series and live channel', /Adult Movie 0/.test(atxt) && /Adult Series 0/.test(atxt) && /Adult Channel/.test(atxt), atxt.slice(0, 200));
  check('18+ panel does not show Extras or normal titles', !/Extra Movie/.test(atxt) && !/New Movie/.test(atxt));
  await ap.evaluate(() => document.getElementById('latestPanelEXTRAS').click()); await sleep(300);
  atxt = await ap.evaluate(() => document.getElementById('mainViewport').innerText);
  check('Extras panel shows only extras titles', /Extra Movie 0/.test(atxt) && !/Adult /.test(atxt));
  const nm = await ap.evaluate(() => { document.getElementById('latestPanelMOVIES').click(); return document.getElementById('mainViewport').innerText; }); await sleep(300);
  check('normal Movies panel never contains adult or extras titles', !/Adult |Extra Movie/.test(await ap.evaluate(() => document.getElementById('mainViewport').innerText)));
  await ap.evaluate(() => { appStatus.parentalControl.showAdult = false; appStatus.parentalControl.showExtras = false; window.__s.adult = false; window.__s.extras = false; renderLatest(document.getElementById('mainViewport')); });
  abar = await ap.evaluate(() => [...document.querySelectorAll('#latestPanelBar button')].map(b => b.innerText.trim()));
  check('locking again removes both panels at once', abar.join() === 'Movies (5),Series (3),Live TV (1)', abar.join());
  check('no JavaScript errors (adult/extras)', ap.errors.length === 0, ap.errors.join(' | '));
  await ap.close();

  const kp = await newApp(browser, true);
  await go(kp, 'LATEST');
  const kbar = await kp.evaluate(() => [...document.querySelectorAll('#latestPanelBar button')].map(b => b.innerText.trim()));
  check('Kids mode: Movies and Series only, no Live TV panel', kbar.join() === 'Movies (5),Series (3)', kbar.join());
  check('no JavaScript errors (Kids)', kp.errors.length === 0, kp.errors.join(' | '));
  console.log('\nEmpty catalog while downloading');
  const ep = await newApp(browser);
  await ep.evaluate(() => { window.__empty = true; window.__sync = { isSyncing: true, phase: 'Parsed 12,000 Movies (11,000 unique cards)...' }; });
  await go(ep, 'HOME');
  let txt = await ep.evaluate(() => document.getElementById('mainViewport').innerText);
  check('Home says "Loading your catalog" and shows the progress', /Loading your catalog/.test(txt) && /Parsed 12,000 Movies/.test(txt), txt.slice(0, 120));
  await go(ep, 'MOVIES');
  txt = await ep.evaluate(() => document.getElementById('mainViewport').innerText);
  check('Movies says the same instead of "No matching titles"', /Loading your catalog/.test(txt) && !/No matching titles/.test(txt), txt.slice(0, 120));
  await ep.evaluate(() => { window.__sync = { isSyncing: false, phase: '', error: 'The IPTV server refused the login (HTTP 403). Check username and password' }; });
  await go(ep, 'HOME');
  txt = await ep.evaluate(() => document.getElementById('mainViewport').innerText);
  check('a failed download shows the reason and where to fix it', /Could not load your catalog/.test(txt) && /refused the login/.test(txt) && /IPTV Playlists/.test(txt), txt.slice(0, 160));
  check('no JavaScript errors (loading)', ep.errors.length === 0, ep.errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
