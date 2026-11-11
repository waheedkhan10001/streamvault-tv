// Series: poster cards say how many seasons (not a bare SERIES) and an opened series offers EVERY season and episode.
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
    window.fetch = async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const base = { rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, year: 2020, versions: [] };
    const eps = []; for (let s = 1; s <= 3; s++) for (let e = 1; e <= (s === 2 ? 4 : 2); e++) eps.push({ id: `${s}0${e}`, season: s, episodeNum: e, title: `Ep ${s}x${e}`, containerExtension: 'mp4' });
    const multi = { ...base, dedupKey: 's1', id: 's1', primaryStreamId: '900', cleanTitle: 'Big Show', mediaType: 'SERIES', seasonTag: '3 Seasons', episodes: [] };
    const unknown = { ...base, dedupKey: 's2', id: 's2', primaryStreamId: '901', cleanTitle: 'Mystery', mediaType: 'SERIES', episodes: [] };
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 5, syncStatus: {}, credentials: { serverUrl: 'http://x', username: 'u', hasPassword: true }, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return J({ hero: multi, rows: [{ title: 'Featured', items: [multi, unknown] }] });
        if (p === '/api/detail') return J({ ok: true, item: { ...multi, episodes: eps }, episodes: eps, related: [] });
        if (p === '/api/query') return J({ items: [multi, unknown], totalMatched: 2, hasMore: false });
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

async function run() {
  console.log('=== StreamVault TV — Series seasons ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await newApp(browser);
  await page.evaluate(() => window.navigateToTab('SERIES')); await sleep(800);
  const tags = await page.evaluate(() => [...document.querySelectorAll('.poster-card.is-series')].map(c => c.querySelector('.badge-series').innerText.trim()));
  check('a series with known seasons says "3 Seasons"', tags[0] === '3 Seasons', tags.join());
  check('a series with unknown seasons falls back to SERIES', tags[1] === 'SERIES', tags.join());
  await page.evaluate(() => window.openDetailModal('s1')); await sleep(1000);
  const pills = await page.evaluate(() => [...document.querySelectorAll('.season-pill')].map(b => b.innerText.trim()));
  check('all 3 seasons are offered', pills.length === 3, pills.join());
  const counts = [];
  for (const s of [1, 2, 3]) { await page.evaluate(n => window.selectSeriesSeason(n), s); counts.push(await page.evaluate(() => document.querySelectorAll('#seriesEpisodesStrip .episode-card').length)); }
  check('every episode of every season is listed (2 + 4 + 2)', counts.join() === '2,4,2', counts.join());
  check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
