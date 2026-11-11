// Sidebar: every tab visible with Adult + Extras unlocked (no scrolling), Profile + Settings pinned and on screen,
// the highlighted tab's left line is not at the screen edge, and switching tabs does not rebuild the list (no flicker).
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'side-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser, w, h, adult, extras) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN, ADULT, EXTRAS) => {
    window.fetch = async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const m = { dedupKey: 'm1', id: 'm1', cleanTitle: 'T', mediaType: 'MOVIE', year: 2000, rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, episodes: [] };
    window.AndroidApp = {
      handleApiRequest: (a, b, c) => window.AndroidApp.handleApiRequestWithAuth(a, b, c, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 5, syncStatus: {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: !ADULT, showAdult: ADULT, showExtras: EXTRAS, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return J({ hero: m, rows: [{ title: 'Featured', items: [m] }] });
        if (p === '/api/query') return J({ items: [m], totalMatched: 1, hasMore: false });
        if (p === '/api/latest') return J({ ok: true, movies: [], series: [], live: [], days: 14 });
        return J({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN, adult, extras);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => window.navigateToTab('HOME'));
  await sleep(700);
  return page;
}
const measure = page => page.evaluate(() => {
  const nav = document.getElementById('navList');
  const btns = [...nav.querySelectorAll('.nav-btn')];
  const bottom = document.querySelector('.sidebar-bottom').getBoundingClientRect();
  const pill = document.getElementById('sidebarUserProfilePill').getBoundingClientRect();
  const set = document.getElementById('sidebarSettingsBtn').getBoundingClientRect();
  const last = btns[btns.length - 1].getBoundingClientRect();
  const first = btns[0].getBoundingClientRect();
  return { n: btns.length, tabs: btns.map(b => b.dataset.tab).join(), noScroll: nav.scrollHeight <= nav.clientHeight + 1,
    lastBottom: last.bottom, bottomTop: bottom.top, pillBottom: pill.bottom, setBottom: set.bottom, vh: innerHeight, firstLeft: first.left };
});

async function run() {
  console.log('=== StreamVault TV — sidebar ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  for (const [w, h] of [[960, 540], [960, 420], [960, 360]]) {
    console.log(`Adult + Extras unlocked, screen ${w}x${h}`);
    const page = await newApp(browser, w, h, true, true);
    const m = await measure(page);
    if (process.env.DBG) console.log(await page.evaluate(() => { const n=document.getElementById('navList'); const sb=document.querySelector('.sidebar'); return JSON.stringify({ch:n.clientHeight, sh:n.scrollHeight, vars:sb.style.cssText, fitted:sb.dataset.fitted, btnH:n.querySelector('.nav-btn').getBoundingClientRect().height, top:n.getBoundingClientRect().top}); }));
    check('all tabs including 18+ Vault and Extras are in the list', /VAULT_18/.test(m.tabs) && /EXTRAS/.test(m.tabs), m.tabs);
    check('no scrolling: every tab fits', m.noScroll, JSON.stringify(m));
    check('last tab ends above the pinned Profile/Settings row', m.lastBottom <= m.bottomTop + 1, `${m.lastBottom} vs ${m.bottomTop}`);
    check('Profile and Settings are fully on screen', m.pillBottom <= m.vh + 0.5 && m.setBottom <= m.vh + 0.5, `${m.pillBottom}/${m.setBottom}/${m.vh}`);
    check('the tab highlight starts away from the screen edge', m.firstLeft >= 8, String(m.firstLeft));
    check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }
  console.log('\nNormal screen, nothing unlocked');
  const p2 = await newApp(browser, 960, 540, false, false);
  const m2 = await measure(p2);
  check('fits and keeps the roomy default size', m2.noScroll && await p2.evaluate(() => getComputedStyle(document.querySelector('.nav-btn')).fontSize === '14px'), JSON.stringify(m2));
  console.log('\nSwitching tabs does not rebuild the list');
  await p2.evaluate(() => { document.querySelector('.nav-btn[data-tab="HOME"]').__keep = 1; });
  await p2.evaluate(() => window.navigateToTab('MOVIES')); await sleep(600);
  await p2.evaluate(() => window.navigateToTab('SERIES')); await sleep(600);
  check('the same tab elements are still there (no flicker)', await p2.evaluate(() => document.querySelector('.nav-btn[data-tab="HOME"]').__keep === 1));
  check('the highlight moved to the new tab', await p2.evaluate(() => document.querySelector('.nav-btn.active').dataset.tab === 'SERIES'));
  check('no JavaScript errors', p2.errors.length === 0, p2.errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
