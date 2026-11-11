// Playback: the screen must never need the IPTV password. The TV engine builds the stream address (/api/stream-url).
// The mock answers /api/state exactly like the real TV: credentials WITHOUT the password (only hasPassword).
// Regression for: "The page at file:// says IPTV credentials required" on every Watch Now.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'play-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newApp(browser, hasLogin) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  page.errors = []; page.dialogs = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', async d => { page.dialogs.push(d.message()); await d.dismiss(); });
  await page.setRequestInterception(true);
  page.on('request', r => (/^(file|data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument((TOKEN, HAS_LOGIN) => {
    window.fetch = async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'a', email: 'o@x.tv', displayName: 'Owner' };
    const profiles = [{ id: 'p1', name: 'Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    const movie = { dedupKey: 'm1', primaryStreamId: '501', id: 'm1', cleanTitle: 'Test Movie', mediaType: 'MOVIE', year: 2024, rating: 7, posterUrl: '', backdropUrl: '', qualityBadges: ['1080p'], language: 'English', genres: ['Drama'], plot: 'p', certification: 'PG', isAdult: false, isWatched: false, resumePositionMs: 0, durationMs: 0, runtimeMins: 100, versions: [{ streamId: '501', containerExtension: 'mkv', rawTitle: 'Test Movie', languageTag: 'English', qualityTag: '1080p' }], episodes: [] };
    const series = { ...movie, dedupKey: 's1', primaryStreamId: '900', cleanTitle: 'Test Series', mediaType: 'SERIES', versions: [], episodes: [{ id: '7001', season: 1, episodeNum: 1, title: 'Pilot', containerExtension: 'mp4' }, { id: '7002', season: 1, episodeNum: 2, title: 'Two', containerExtension: 'mp4' }] };
    window.__played = []; window.__urlCalls = [];
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const p = path.split('?')[0]; const J = o => JSON.stringify(o);
        const cred = HAS_LOGIN ? { serverUrl: 'http://prov.example:8080', username: 'u', hasPassword: true } : { serverUrl: '', username: '', hasPassword: false };
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 5, syncStatus: {}, credentials: cred, parentalControl: { isLocked: true, showAdult: false, showExtras: false, hasCustomPin: true } });
        if (p === '/api/stream-url') {
          const b = JSON.parse(body || '{}'); window.__urlCalls.push(b);
          if (!HAS_LOGIN) return J({ ok: false, error: 'no_login', message: 'Your IPTV login is not on this TV yet. Open Settings, then IPTV Playlists.' });
          return J({ ok: true, url: `http://prov.example:8080/${b.kind}/u/SECRET/${b.id}.${b.kind === 'live' ? 'm3u8' : b.ext}` });
        }
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return J({ hero: movie, rows: [{ title: 'Featured', items: [movie, series] }] });
        if (p === '/api/detail') { const k = (path.match(/dedupKey=([^&]+)/) || [])[1]; return J({ ok: true, item: k === 's1' ? series : movie, related: [] }); }
        if (p === '/api/query') return J({ items: [movie, series], totalMatched: 2, hasMore: false });
        return J({ ok: true, items: [] });
      },
      playStream: (...a) => { window.__played.push(a); },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN); localStorage.setItem('streamvault_session_token', TOKEN); localStorage.setItem('streamvault_account', JSON.stringify(account));
  }, TOKEN, hasLogin);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await sleep(500);
  return page;
}

async function run() {
  console.log('=== StreamVault TV — Playback address ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });

  console.log('With an IPTV login on the TV (the screen is never given the password)');
  const page = await newApp(browser, true);
  check('the screen state really has no password (as on the real TV)', await page.evaluate(() => typeof appStatus !== "undefined" && appStatus && appStatus.credentials && appStatus.credentials.password === undefined && appStatus.credentials.hasPassword === true));
  await page.evaluate(() => window.startMoviePlayback('m1', 0, 0)); await sleep(400);
  let played = await page.evaluate(() => window.__played);
  check('a movie starts: the player gets the engine-built address with the right stream id and extension', played.length === 1 && /\/movie\/u\/SECRET\/501\.mkv$/.test(played[0][0]), JSON.stringify(played));
  await page.evaluate(() => window.startMoviePlayback('s1', 0, 0, '7002')); await sleep(400);
  played = await page.evaluate(() => window.__played);
  check('a chosen episode starts with its own id', played.length === 2 && /\/series\/u\/SECRET\/7002\.mp4$/.test(played[1][0]), JSON.stringify(played[1]));
  await page.evaluate(() => window.startLivePlayback('42', 'News')); await sleep(400);
  played = await page.evaluate(() => window.__played);
  check('a live channel starts as .m3u8', played.length === 3 && /\/live\/u\/SECRET\/42\.m3u8$/.test(played[2][0]), JSON.stringify(played[2]));
  check('no browser alert box appeared', page.dialogs.length === 0, page.dialogs.join(' | '));
  check('no JavaScript errors', page.errors.length === 0, page.errors.join(' | '));

  console.log('\nOpen a title and press Watch with the remote (real key press)');
  await page.evaluate(() => window.openDetailModal('m1')); await sleep(900);
  await page.evaluate(() => { const b = document.querySelector('#detailActionButtonsContainer .btn-primary') || document.querySelector('#detailActionButtonsContainer button'); if (b) b.focus(); });
  await page.keyboard.press('Enter'); await sleep(500);
  played = await page.evaluate(() => window.__played);
  check('Enter on the main button starts playback', played.length === 4, 'plays: ' + played.length);
  check('still no alert box', page.dialogs.length === 0, page.dialogs.join(' | '));
  await page.close();

  console.log('\nWithout an IPTV login on the TV');
  const np = await newApp(browser, false);
  await np.evaluate(() => window.startMoviePlayback('m1', 0, 0)); await sleep(400);
  const toast = await np.evaluate(() => { const t = document.getElementById('tvToastNotification'); return t ? t.innerText : ''; });
  check('a clear in-app message is shown (no alert box)', /IPTV login is not on this TV/.test(toast) && np.dialogs.length === 0, toast + ' | ' + np.dialogs.join(' | '));
  check('nothing is played', (await np.evaluate(() => window.__played)).length === 0);
  await np.evaluate(() => window.startLivePlayback('42', 'News')); await sleep(400);
  check('live without a login also shows the message and plays nothing', (await np.evaluate(() => window.__played)).length === 0 && np.dialogs.length === 0);
  check('no JavaScript errors (no login)', np.errors.length === 0, np.errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
