// Fast scrolling: many quick Down presses on a long grid must never feel stuck. Every press moves one row, and the
// view is settled on the focused card right after the last press (no glide still running).
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'scroll-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('=== StreamVault TV — Fast scrolling ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN) => {
    window.fetch = async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const mk = i => ({ dedupKey: 'm' + i, id: 'm' + i, primaryStreamId: 'm' + i, cleanTitle: 'Title ' + i, mediaType: 'MOVIE', year: 2000 + (i % 25), rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, versions: [], episodes: [] });
    const all = Array.from({ length: 400 }, (_, i) => mk(i));
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 400, syncStatus: {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return J({ hero: all[0], rows: [{ title: 'Featured', items: all.slice(0, 20) }] });
        if (p === '/api/query') { const b = JSON.parse(body || '{}'); const off = b.offset || 0, lim = b.limit || 60; return J({ items: all.slice(off, off + lim), totalMatched: 400, hasMore: off + lim < 400 }); }
        return J({ ok: true, items: [] });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => window.navigateToTab('MOVIES', null, true)); await sleep(1200);
  const info = () => page.evaluate(() => {
    const cards = [...document.querySelectorAll('#filterResultsGrid .poster-card')];
    const a = document.activeElement; const t = a && a.querySelector ? a.querySelector('.card-title') : null; const i = t ? parseInt(t.textContent.replace(/\D+/g, ''), 10) : -1;   // the title number = the real position (the grid keeps only a window of cards)
    const r = a && a.getBoundingClientRect ? a.getBoundingClientRect() : null;
    return { idx: i, total: cards.length, cols: Math.round(document.getElementById('filterResultsGrid').getBoundingClientRect().width / 170), visible: r ? (r.top >= 0 && r.bottom <= innerHeight + 4) : false };
  });
  const start = await info();
  check('the Movies grid opened with the remote on the first card', start.idx === 0, JSON.stringify(start));
  // measure the real column count from card positions
  const cols = await page.evaluate(() => getComputedStyle(document.getElementById('filterResultsGrid')).gridTemplateColumns.split(' ').length);
  const presses = 60;
  const t0 = Date.now();
  await page.evaluate(() => { window.__log = []; const r = window.restorePreviousGridWindow; window.restorePreviousGridWindow = function () { window.__log.push('restore@' + windowStartIdx); return r.apply(this, arguments); }; const e = window.executeFilterQuery; window.executeFilterQuery = function (a) { window.__log.push('query' + (a ? '+' : '') + '@off' + currentFilterOffset + ',win' + windowStartIdx); return e.apply(this, arguments); }; });
  const trail = [];
  for (let i = 0; i < presses; i++) { await page.keyboard.press('ArrowDown'); if (process.env.DBG2) trail.push(await page.evaluate(() => { const t = document.activeElement.querySelector && document.activeElement.querySelector('.card-title'); return t ? parseInt(t.textContent.replace(/\D+/g, ''), 10) : -1; })); }   // back to back, no waiting
  if (process.env.DBG) console.log('trail', trail.join(' '));
  const pressMs = Date.now() - t0;
  if (process.env.DBG) console.log('state', await page.evaluate(() => JSON.stringify({ hasMore: hasMoreFilterResults, loading: isLoadingMoreFilter, cards: document.querySelectorAll('#filterResultsGrid .poster-card').length, win: windowStartIdx, off: currentFilterOffset, pend: pendingFilterDownCount, max: typeof MAX_WINDOW_CARDS !== 'undefined' ? MAX_WINDOW_CARDS : null, batch: BATCH_SIZE })));
  if (process.env.DBG) console.log('log', (await page.evaluate(() => window.__log)).join(' '));
  await page.waitForFunction(() => !isLoadingMoreFilter && pendingFilterDownCount === 0, { timeout: 20000 });   // let any batch that was still loading arrive
  await sleep(250);
  const end = await info();
  check(`${presses} quick Down presses moved exactly ${presses} rows (none lost)`, end.idx === presses * cols, `cols ${cols}, idx ${end.idx}`);
  check('the focused card is on screen right after the last press (no glide still running)', end.visible, JSON.stringify(end));
  check('more titles were loaded while scrolling down', end.total > start.total, `${start.total} -> ${end.total}`);
  check(`presses were handled quickly (${pressMs} ms for ${presses})`, pressMs < 6000, String(pressMs));
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp');
  await sleep(250);
  const back = await info();
  check('and 10 quick Up presses go back exactly 10 rows', back.idx === end.idx - 10 * cols && back.visible, JSON.stringify(back));
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
