// Theme: the chosen colour recolours the WHOLE app (no purple left on any screen), a click only previews it,
// Save Profile keeps it, and leaving the screen without saving puts the saved colour back.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'play-ui-session-token-0123456789abcdef0123456789abcdef';
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
    window.fetch = async (url) => new Response(JSON.stringify({ ok: true, success: true, profile: { theme: window.__lastTheme } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const base = { rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, year: 2020 };
    const vers = [1, 2].map(i => ({ streamId: 'v' + i, containerExtension: 'mkv', rawTitle: 'Film v' + i, languageTag: 'English', qualityTag: '1080p' }));
    const movie = { ...base, dedupKey: 'm1', id: 'm1', primaryStreamId: 'v1', cleanTitle: 'Film', mediaType: 'MOVIE', versions: vers, episodes: [] };
    const rel = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ ...base, dedupKey: 'r' + i, id: 'r' + i, primaryStreamId: 'r' + i, cleanTitle: 'Related ' + i, mediaType: 'MOVIE', versions: [], episodes: [] }));
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 5, syncStatus: {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles: profiles.map(x => ({ ...x, theme: localStorage.getItem('streamvault_active_theme') || 'purple' })), activeProfileId: 'p1' });
        if (p === '/api/profiles/update') { const b = JSON.parse(body || '{}'); return J({ ok: true, profile: { ...profiles[0], theme: b.theme } }); }
        if (p === '/api/playlists') return J({ ok: true, playlists: [{ playlist_id: 'pl1', name: 'Home', server_url: 'http://x', username: 'u', is_enabled: 1, status: 'working' }] });
        if (p === '/api/home') return J({ hero: movie, rows: [{ title: 'Featured', items: [movie, ...rel] }] });
        if (p === '/api/detail') return J({ ok: true, item: movie, related: rel });
        if (p === '/api/probe-versions') return J({ ok: true, versions: vers });
        if (p === '/api/query') return J({ items: [movie, ...rel], totalMatched: 9, hasMore: false });
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
const theme = page => page.evaluate(() => [...document.body.classList].filter(c => c.startsWith('theme-')).join() || 'purple');
const stored = page => page.evaluate(() => localStorage.getItem('streamvault_active_theme') || 'purple');
const go = async (page, tab) => { await page.evaluate(t => window.navigateToTab(t), tab); await sleep(700); };
// every purple the old design used, as the browser reports it
const PURPLES = ['124, 58, 237', '139, 92, 246', '167, 139, 250', '196, 181, 253', '221, 214, 254', '76, 29, 149'];
const purpleLeft = page => page.evaluate((P) => {
  const hit = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.brand-logo-icon, .add-prof-color-chip, [data-theme="purple"], .profile-avatar-initials, #profileThemeGroup')) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    const vals = [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderLeftColor, cs.borderBottomColor, cs.borderRightColor, cs.boxShadow, cs.backgroundImage, cs.fill, cs.stroke, cs.stopColor];
    for (const v of vals) if (v && P.some(p => v.includes('rgb(' + p + ')') || v.includes('rgba(' + p + ','))) { hit.push((el.id || el.className || el.tagName).toString().slice(0, 40) + ' : ' + v.slice(0, 60)); break; }
  }
  return hit;
}, PURPLES);

async function run() {
  console.log('=== StreamVault TV — Theme ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await newApp(browser);
  await go(page, 'PROFILE');
  console.log('Preview, Save, and leave without saving');
  await page.evaluate(() => document.querySelector('.profile-theme-chip[data-theme="disney"]').click()); await sleep(200);
  check('clicking Blue recolours the screen at once', await theme(page) === 'theme-disney', await theme(page));
  check('but nothing is stored yet', await stored(page) === 'purple', await stored(page));
  await go(page, 'HOME');
  check('leaving without saving puts the saved colour (purple) back', await theme(page) === 'purple', await theme(page));
  await go(page, 'PROFILE');
  await page.evaluate(() => document.querySelector('.profile-theme-chip[data-theme="netflix"]').click()); await sleep(200);
  await page.evaluate(() => { window.__lastTheme = 'netflix'; document.getElementById('btnSaveProfile').click(); }); await sleep(700);
  check('Save Profile keeps Red', await stored(page) === 'netflix' && await theme(page) === 'theme-netflix', await stored(page) + ' / ' + await theme(page));
  await go(page, 'HOME');
  check('and it stays after leaving the screen', await theme(page) === 'theme-netflix', await theme(page));
  await go(page, 'PROFILE');
  await page.evaluate(() => document.querySelector('.profile-theme-chip[data-theme="prime"]').click()); await sleep(200);
  await page.evaluate(() => window.openAddProfileModal && window.openAddProfileModal()); await sleep(100);
  await go(page, 'SETTINGS');
  check('another unsaved preview is also undone (back to saved Red)', await theme(page) === 'theme-netflix' && await stored(page) === 'netflix', await theme(page));

  console.log('\nSanity: the scan really sees purple when the theme IS purple');
  await page.evaluate(() => { applyProfileTheme('purple'); });
  await go(page, 'SETTINGS');
  check('purple theme: the scan finds purple elements (so the checks below mean something)', (await purpleLeft(page)).length > 5, String((await purpleLeft(page)).length));

  console.log('\nNo purple left when the theme is Blue');
  await page.evaluate(() => { applyProfileTheme('disney'); });
  for (const tab of ['HOME', 'SEARCH', 'MOVIES', 'SERIES', 'LIVE_TV', 'SETTINGS', 'PROFILE', 'LATEST', 'WATCHLIST']) {
    await go(page, tab);
    const left = await purpleLeft(page);
    check(tab + ': every highlight, border, badge and glow follows the theme', left.length === 0, left.slice(0, 4).join(' | '));
  }
  await go(page, 'HOME');
  await page.evaluate(() => window.openDetailModal('m1')); await sleep(900);
  const dl = await purpleLeft(page);
  check('detail screen: no purple left', dl.length === 0, dl.slice(0, 4).join(' | '));
  check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
