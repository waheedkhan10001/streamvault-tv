// Detail screen keyboard flow with real key presses: Watch -> Version pills -> More Like This chips -> posters and back up,
// including when the version sizes arrive late (the version row is redrawn while a pill is focused).
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
    window.fetch = async (url) => {
      if (String(url).includes('/api/probe-versions')) await new Promise(r => setTimeout(r, 1500));   // slow probe
      return new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const base = { rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, year: 2020 };
    const vers = [1, 2, 3].map(i => ({ streamId: 'v' + i, containerExtension: 'mkv', rawTitle: 'Film v' + i, languageTag: 'English', qualityTag: '1080p' }));
    const movie = { ...base, dedupKey: 'm1', id: 'm1', primaryStreamId: 'v1', cleanTitle: 'Film', mediaType: 'MOVIE', versions: vers, episodes: [] };
    const rel = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ ...base, dedupKey: 'r' + i, id: 'r' + i, primaryStreamId: 'r' + i, cleanTitle: 'Related ' + i, mediaType: 'MOVIE', versions: [], episodes: [] }));
    window.__slowDetail = false;
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 5, syncStatus: {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return J({ hero: movie, rows: [{ title: 'Featured', items: [movie] }] });
        if (p === '/api/detail') return window.__kidsBlock ? J({ ok: false, error: 'This title is not available in Kids mode.' }) : J({ ok: true, item: movie, related: window.__noRelated ? [] : rel });
        if (p === '/api/related') {
          const q = new URLSearchParams(path.split('?')[1] || ''); const off = +q.get('offset') || 0, lim = +q.get('limit') || 24; window.__relCalls = (window.__relCalls || []); window.__relCalls.push(path);
          const all = Array.from({ length: 30 }, (_, i) => ({ ...rel[0], dedupKey: 'x' + i, id: 'x' + i, cleanTitle: 'Match ' + i }));
          return J({ ok: true, items: all.slice(off, off + lim), hasMore: off + lim < all.length, offset: off });
        }
        if (p === '/api/probe-versions') return J({ ok: true, versions: vers.map(v => ({ ...v, fileSizeStr: '2.1 GB' })) });
        if (p === '/api/query') return J({ items: [movie], totalMatched: 1, hasMore: false });
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
const where = page => page.evaluate(() => {
  const a = document.activeElement; if (!a || a === document.body) return 'NOWHERE';
  if (a.classList.contains('detail-version-pill')) return 'VERSION';
  if (a.classList.contains('mlt-chip')) return 'CHIP';
  if (a.closest('#mltPosterStrip')) return 'POSTER';
  if (a.closest('#detailActionButtonsContainer')) return 'WATCH';
  return 'OTHER:' + (a.id || a.className);
});
const press = async (page, k) => { await page.keyboard.press(k); await sleep(120); };

async function run() {
  console.log('=== StreamVault TV — Detail screen focus ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  for (const withRelated of [true, false]) {
    console.log(withRelated ? 'Normal list' : 'Empty More Like This list');
    const page = await newApp(browser);
    await page.evaluate(v => { window.__noRelated = !v; }, withRelated);
    await page.evaluate(() => window.openDetailModal('m1')); await sleep(600);
    check('starts on the Watch button', await where(page) === 'WATCH', await where(page));
    await press(page, 'ArrowDown');
    check('Down from Watch reaches a version pill', await where(page) === 'VERSION', await where(page));
    await press(page, 'ArrowRight');
    const idxBefore = await page.evaluate(() => [...document.querySelectorAll('.detail-version-pill')].indexOf(document.activeElement));
    check('Right moves along the version pills', idxBefore === 1, String(idxBefore));
    await sleep(1800);   // the late version sizes redraw the row now
    check('focus is still on a version pill after the late redraw', await where(page) === 'VERSION', await where(page));
    const idxAfter = await page.evaluate(() => [...document.querySelectorAll('.detail-version-pill')].indexOf(document.activeElement));
    check('and on the same pill', idxAfter === idxBefore, `${idxBefore} -> ${idxAfter}`);
    if (process.env.DBG) console.log(await page.evaluate(() => JSON.stringify({chips: document.querySelectorAll('.mlt-chip').length, vis: [...document.querySelectorAll('.mlt-chip')].map(c => c.offsetParent !== null), act: document.activeElement.outerHTML.slice(0, 120), pills: document.querySelectorAll('.detail-version-pill').length})));
    await press(page, 'ArrowDown');
    if (process.env.DBG) console.log(await page.evaluate(() => document.activeElement.outerHTML.slice(0, 160)));
    check('Down from a version pill reaches the More Like This chips', await where(page) === 'CHIP', await where(page));
    await press(page, 'ArrowDown');
    check(withRelated ? 'Down from the chips reaches the first poster' : 'Down on an empty list stays on the chips', await where(page) === (withRelated ? 'POSTER' : 'CHIP'), await where(page));
    if (withRelated) { await press(page, 'ArrowRight'); await press(page, 'ArrowRight'); check('Right moves along the posters', await where(page) === 'POSTER'); await press(page, 'ArrowUp'); check('Up from a poster returns to the chips', await where(page) === 'CHIP', await where(page)); }
    await press(page, 'ArrowUp');
    check('Up from the chips returns to the version pills', await where(page) === 'VERSION', await where(page));
    await press(page, 'ArrowUp');
    check('Up from a version pill returns to Watch', await where(page) === 'WATCH', await where(page));
    check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }
  console.log('Kids profile opening a title that is not child-rated');
  const kp = await newApp(browser);
  await kp.evaluate(() => { window.__kidsBlock = true; window.openDetailModal('m1'); }); await sleep(600);
  const kt = await kp.evaluate(() => ({ toast: (document.getElementById('tvToastNotification') || {}).innerText || '', open: document.getElementById('detailOverlay').style.display }));
  check('it shows a clear message and no broken detail screen', /not available in Kids mode/.test(kt.toast) && kt.open === 'none', JSON.stringify(kt));
  check('no JavaScript errors (Kids block)', kp.errors.length === 0, kp.errors.join(' | '));
  await kp.close();

  console.log('Show more page');
  const sp = await newApp(browser);
  await sp.evaluate(() => window.openDetailModal('m1')); await sleep(600);
  await sp.evaluate(() => document.querySelector('#mltPosterStrip .show-more-card').focus());
  await press(sp, 'Enter'); await sleep(500);
  check('Show more opens a page with the first 24 matches and a Show more card', await sp.evaluate(() => document.querySelectorAll('#filterResultsGrid .poster-card:not(.mlt-more-card)').length) === 24 && await sp.evaluate(() => !!document.querySelector('.mlt-more-card')));
  check('the remote lands on the first match', await sp.evaluate(() => !!document.activeElement.closest('#filterResultsGrid')));
  await sp.evaluate(() => document.querySelector('.mlt-more-card').focus()); await press(sp, 'Enter'); await sleep(400);
  check('Show more adds the remaining 6 and the card goes away', await sp.evaluate(() => document.querySelectorAll('#filterResultsGrid .poster-card:not(.mlt-more-card)').length) === 30 && await sp.evaluate(() => !document.querySelector('.mlt-more-card')));
  check('focus moves to the first new title', await sp.evaluate(() => { const c = [...document.querySelectorAll('#filterResultsGrid .poster-card')]; return c.indexOf(document.activeElement) === 24; }));
  await sp.evaluate(() => document.getElementById('mltPageBack').click()); await sleep(600);
  check('Back returns to the detail screen', await sp.evaluate(() => !!document.querySelector('#detailActionButtonsContainer')));
  check('no JavaScript errors (Show more)', sp.errors.length === 0, sp.errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
