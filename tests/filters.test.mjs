// Filters, paging and "More Like This" — drives the real screens with real key presses and checks exactly what the
// page asks the app to search for, what it shows, and where focus goes. (Whether the Kotlin database honours the
// request is covered by reading/compiling the Kotlin side; this proves the screen sends the right thing.)
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'filters-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('=== StreamVault TV — Filters, paging and More Like This ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN) => {
    window.__q = []; window.__detail = [];
    const mk = (i) => ({ dedupKey: 'mov_' + i, id: 'mov_' + i, cleanTitle: 'Movie ' + i, mediaType: 'MOVIE', year: 2010 + (i % 10), rating: 6 + (i % 4), posterUrl: '', backdropUrl: '', qualityBadges: ['HD'], language: 'English', genres: ['Drama', 'Action'], plot: 'Plot ' + i, certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, inWatchlist: false, versions: [], cast: ['A'], director: 'D' });
    window.fetch = async (url, init) => {
      const u = String(url);
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return json({ ok: true, success: true });
    };
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, bodyStr) => {
        if (path === '/api/query') {
          const body = JSON.parse(bodyStr || '{}'); window.__q.push(body);
          const off = body.offset || 0, total = 300;
          const n = Math.max(0, Math.min(120, total - off));
          return JSON.stringify({ ok: true, items: Array.from({ length: n }, (_, i) => mk(off + i)), totalMatched: total, hasMore: off + n < total });
        }
        if (path.startsWith('/api/detail')) { window.__detail.push(path); return JSON.stringify({ ok: true, item: mk(1), related: [mk(2), mk(3)], episodes: [] }); }
        if (path === '/api/state') return JSON.stringify({ ok: true, totalCatalogCount: 10, credentials: { serverUrl: 'http://x', username: 'u' }, parentalControl: {} });
        if (path === '/api/status') return JSON.stringify({ ok: true, credentials: { serverUrl: 'http://x', username: 'u', password: 'p' }, catalogCount: 10 });
        if (path === '/api/session') return JSON.stringify({ ok: true, authenticated: true, token: TOKEN });
        if (path === '/api/auth/me') return JSON.stringify({ ok: true, account, token: TOKEN });
        if (path === '/api/profiles') return JSON.stringify({ ok: true, profiles, activeProfileId: 'p1' });
        if (path === '/api/playlists') return JSON.stringify({ ok: true, playlists: [] });
        return JSON.stringify({ ok: true, items: [] });
      }, playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN);
    localStorage.setItem('streamvault_account', JSON.stringify(account)); localStorage.setItem('streamvault_active_profile_id', 'p1');
  }, TOKEN);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => { const c = document.querySelector('#profilePickerOverlay .profile-picker-card'); if (c && document.getElementById('profilePickerOverlay').style.display === 'flex') c.click(); });
  await sleep(300);
  await page.evaluate(() => window.navigateToTab('MOVIES')); await sleep(700);

  const press = async k => { await page.keyboard.press(k); await sleep(130); };
  const lastQ = () => page.evaluate(() => window.__q[window.__q.length - 1]);
  const qCount = () => page.evaluate(() => window.__q.length);
  const focusPill = idx => page.evaluate(i => document.querySelector(`[data-pill-idx="${i}"] .filter-pill-btn`).focus(), idx);
  const focusedPillIdx = () => page.evaluate(() => document.activeElement?.closest('[data-pill-idx]')?.getAttribute('data-pill-idx') ?? 'none');
  const pillText = idx => page.evaluate(i => document.querySelector(`[data-pill-idx="${i}"] .filter-pill-btn`).innerText.replace(/\s+/g, ' ').trim(), idx);
  // open pill idx, go Down `downs` times, press OK
  async function pick(idx, downs) {
    await focusPill(idx); await press('Enter'); await sleep(120);
    for (let i = 0; i < downs; i++) await press('ArrowDown');
    await press('Enter'); await sleep(500);
  }

  console.log('1. Movies tab asks for movies only, sorted by recently added');
  let q = await lastQ();
  check('first request is Movies, Recent, nothing else', q.mediaTypeFilter === 'MOVIE' && q.sortBy === 'NEWLY_ADDED' && q.includedGenres.length === 0 && !q.decade && !q.qualityFilter && q.minRating === 0, JSON.stringify(q));

  console.log('\n2. Each filter sends the right value, updates its label and hands focus back to its own button');
  const cases = [
    [0, 2, 'Genre', q => q.includedGenres.length === 1, 'genre'],
    [1, 2, 'Year', q => q.decade === 2010, 'decade 2010'],
    [2, 2, 'Lang', q => q.selectedLanguages.length === 1, 'language'],
    [3, 2, 'Quality', q => q.qualityFilter === '1080p', 'quality 1080p'],
    [4, 2, 'Rating', q => q.minRating === 6.5 || q.minRating === 7, 'rating'],
    [5, 3, 'Sort', q => q.sortBy === 'RATING_DESC' || q.sortBy === 'TITLE_ASC' || q.sortBy === 'RELEASE_YEAR_DESC', 'sort'],
  ];
  for (const [idx, downs, label, test, what] of cases) {
    const before = await qCount();
    await pick(idx, downs);
    const q2 = await lastQ();
    check(`${label}: choosing an option sends ${what}`, (await qCount()) > before && test(q2), JSON.stringify(q2));
    check(`${label}: pill shows the choice`, !/: (All|Any)$/.test(await pillText(idx)) || label === 'Sort', await pillText(idx));
    check(`${label}: focus returns to the ${label} button`, (await focusedPillIdx()) === String(idx), 'focus on pill ' + await focusedPillIdx());
  }
  q = await lastQ();
  check('all six filters are active together in one request', q.includedGenres.length === 1 && q.decade === 2010 && q.selectedLanguages.length === 1 && q.qualityFilter === '1080p' && q.minRating > 0 && q.mediaTypeFilter === 'MOVIE', JSON.stringify(q));

  console.log('\n3. Multi-genre');
  await pick(0, 4);   // another genre while one is already ticked
  q = await lastQ();
  check('picking a second genre keeps the first (two genres sent)', q.includedGenres.length === 2, JSON.stringify(q.includedGenres));
  check('genres are combined with AND (title must have BOTH)  <-- ask owner if intended', q.matchAllIncludedGenres === true);

  console.log('\n4. Reset');
  await focusPill(0);
  await page.evaluate(() => [...document.querySelectorAll('.filter-pill-btn')].find(b => b.textContent.trim() === 'Reset').focus());
  await press('Enter'); await sleep(500);
  q = await lastQ();
  check('Reset clears every filter but stays on Movies', q.includedGenres.length === 0 && !q.decade && !q.qualityFilter && q.minRating === 0 && q.selectedLanguages.length === 0 && q.mediaTypeFilter === 'MOVIE', JSON.stringify(q));

  console.log('\n5. Count and "load more"');
  const label = await page.evaluate(() => document.getElementById('filterCountLabel').innerText);
  check('shows "Showing 1 - 120 of 300 titles"', /1 - 120 of 300/.test(label), label);
  await page.evaluate(() => { const g = document.getElementById('filterResultsGrid'); g.scrollTop = g.scrollHeight; g.dispatchEvent(new Event('scroll')); });
  await sleep(700);
  q = await lastQ();
  check('scrolling to the bottom asks for the next page (offset 120)', q.offset === 120, 'offset=' + q.offset);
  const cards = await page.evaluate(() => document.querySelectorAll('#filterResultsGrid .poster-card').length);
  check('the grid now holds more than 120 cards', cards > 120, 'cards=' + cards);

  console.log('\n6. More Like This on the Detail screen');
  await page.evaluate(() => window.openDetailModal('mov_1')); await sleep(900);
  await page.evaluate(() => window.switchDetailLowerTab && window.switchDetailLowerTab('RELATED')); await sleep(300);
  const modes = ['everything', 'story', 'setting', 'cast_director'];
  for (const m of modes) {
    await page.evaluate(m => document.querySelector(`.mlt-chip[data-mode="${m}"]`)?.focus(), m);
    await press('Enter'); await sleep(400);
    const last = await page.evaluate(() => window.__detail[window.__detail.length - 1]);
    check(`"${m}" chip asks for matchMode=${m}`, last.includes('matchMode=' + m), last);
  }
  await page.evaluate(() => document.getElementById('mltHideWatchedChip').focus());
  await press('Enter'); await sleep(400);
  const lastD = await page.evaluate(() => window.__detail[window.__detail.length - 1]);
  check('"Hide Watched" asks for hideWatched=true', lastD.includes('hideWatched=true'), lastD);
  check('related titles are shown', await page.evaluate(() => document.querySelectorAll('#mltPosterStrip .poster-card').length >= 2));

  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
