// 18+ Adult and Extras: separate locked areas, each with Movies / Series / Live TV panels.
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
        if (p === '/api/state') return J({ ok: true, totalCatalogCount: 12, credentials: { serverUrl: 'http://x', username: 'u' }, parentalControl: pc() });
        if (p === '/api/status') return J({ ok: true, credentials: { serverUrl: 'http://x', username: 'u', password: 'p' }, catalogCount: 12 });
        if (p === '/api/session') return J({ ok: true, authenticated: true, token: TOKEN });
        if (p === '/api/auth/me') return J({ ok: true, account, token: TOKEN });
        if (p === '/api/profiles') return J({ ok: true, profiles, activeProfileId: 'p1' });
        if (p === '/api/playlists') return J({ ok: true, playlists: [] });
        if (p === '/api/home') return J({ hero: catalog[0], rows: [{ title: 'Featured', items: catalog }] });
        if (p === '/api/query') { S.queries.push(JSON.parse(body || '{}')); return J({ items: catalog, totalMatched: 12, hasMore: false }); }
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
const state = page => page.evaluate(() => ({ adult: window.__s.adult, extras: window.__s.extras }));
const go = async (page, tab) => { await page.evaluate(t => window.navigateToTab(t), tab); await sleep(700); };
const typePin = async (page, pin) => { for (const d of pin) { await page.evaluate(x => pressPinDigit(x), d); } await sleep(500); };

async function run() {
  console.log('=== StreamVault TV — 18+ Adult and Extras areas ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox'] });
  const page = await newApp(browser);

  console.log('1. Invisible until unlocked');
  let tabs = await navTabs(page);
  check('no 18+ or Extras tab at all on a normal profile', !tabs.includes('VAULT_18') && !tabs.includes('EXTRAS'), tabs.join());
  check('normal Live TV tab is present', tabs.includes('LIVE_TV'));
  await go(page, 'PROFILE');
  const sw = await page.evaluate(() => ({ a: document.getElementById('btnToggleParentalLock')?.innerText, e: document.getElementById('btnToggleExtrasLock')?.innerText }));
  check('Profile screen has two separate switches, both "Unlock"', sw.a === 'Unlock' && sw.e === 'Unlock', JSON.stringify(sw));

  console.log('\n2. Unlock Extras only (needs the PIN)');
  await page.evaluate(() => document.getElementById('btnToggleExtrasLock').click()); await sleep(500);
  check('PIN popup opens', await page.evaluate(() => document.getElementById('parentalPinModal').style.display === 'flex'));
  check('popup says Extras', /Extras/.test(await page.evaluate(() => document.getElementById('parentalPinSubtitle').innerText)));
  await typePin(page, '9999');
  check('wrong PIN: still locked', !(await state(page)).extras);
  await page.evaluate(() => clearPin());
  await typePin(page, '1234');
  let st = await state(page);
  check('right PIN unlocks Extras and not Adult', st.extras && !st.adult, JSON.stringify(st));
  check('the unlock was sent for target=extras', await page.evaluate(() => window.__s.calls.some(c => c.action === 'unlock' && c.target === 'extras' && c.pin === '1234')));
  tabs = await navTabs(page);
  check('Extras tab now appears; 18+ still does not', tabs.includes('EXTRAS') && !tabs.includes('VAULT_18'), tabs.join());

  console.log('\n3. Three panels: Movies / Series / Live TV');
  await go(page, 'EXTRAS');
  const bar = await page.evaluate(() => [...document.querySelectorAll('#vaultPanelBar button')].map(b => b.innerText.trim()));
  check('panel bar shows Movies, Series, Live TV', bar.join() === 'Movies,Series,Live TV', bar.join());
  let q = await page.evaluate(() => window.__s.queries.at(-1));
  check('Movies panel asks for extras only, movies only', q && q.extrasOnly === true && q.mediaTypeFilter === 'MOVIE' && !q.adultOnly, JSON.stringify(q));
  await page.evaluate(() => document.getElementById('vaultPanelSERIES').click()); await sleep(700);
  q = await page.evaluate(() => window.__s.queries.at(-1));
  check('Series panel asks for series', q && q.extrasOnly === true && q.mediaTypeFilter === 'SERIES', JSON.stringify(q));
  check('panel bar is still there after switching', await page.evaluate(() => !!document.getElementById('vaultPanelLIVE')));
  await page.evaluate(() => document.getElementById('vaultPanelLIVE').click()); await sleep(800);
  const live = await page.evaluate(() => window.__s.lives.at(-1));
  check('Live TV panel asks for the extras live group', /group=extras/.test(live || ''), live);
  check('Live TV panel lists channels', await page.evaluate(() => /Chan/.test(document.getElementById('mainViewport').innerText)));
  check('panel bar still on top of Live TV', await page.evaluate(() => !!document.getElementById('vaultPanelBar')));

  console.log('\n4. No history');
  await page.evaluate(() => saveSearchQuery('some dance clip')); await sleep(200);
  check('search in Extras is never recorded', await page.evaluate(() => window.__s.history.length === 0));

  console.log('\n5. Locks again');
  await go(page, 'HOME');
  st = await state(page); tabs = await navTabs(page);
  check('leaving the Extras tab locks it and removes the tab', !st.extras && !tabs.includes('EXTRAS'), JSON.stringify(st) + tabs.join());
  check('normal Live TV request never carries an adult/extras group', await (async () => { await go(page, 'LIVE_TV'); return page.evaluate(() => /group=normal/.test(window.__s.lives.at(-1) || '')); })());

  console.log('\n6. Both open at once: each lock is separate');
  await page.evaluate(() => { window.__s.adult = true; window.__s.extras = true; appStatus.parentalControl.showAdult = true; appStatus.parentalControl.isLocked = false; appStatus.parentalControl.showExtras = true; renderSidebar(); });
  tabs = await navTabs(page);
  check('both tabs show when both are unlocked', tabs.includes('VAULT_18') && tabs.includes('EXTRAS'));
  await go(page, 'EXTRAS'); await go(page, 'HOME');
  st = await state(page);
  check('leaving Extras locks Extras but 18+ stays open', !st.extras && st.adult, JSON.stringify(st));
  await go(page, 'VAULT_18');
  const q2 = await page.evaluate(() => window.__s.queries.at(-1));
  check('18+ Movies panel asks adult only', q2 && q2.adultOnly === true && !q2.extrasOnly && q2.mediaTypeFilter === 'MOVIE', JSON.stringify(q2));
  await page.evaluate(() => document.getElementById('vaultPanelLIVE').click()); await sleep(800);
  check('18+ Live TV panel asks for the adult live group', /group=adult/.test(await page.evaluate(() => window.__s.lives.at(-1) || '')));

  console.log('\n7. 30 minutes idle');
  const has = await page.evaluate(() => window.__idle.length);
  check('a 30-minute lock timer is armed while something is unlocked', has > 0);
  await page.evaluate(() => { window.__s.extras = true; appStatus.parentalControl.showExtras = true; renderSidebar(); window.__idle.at(-1)(); }); await sleep(900);
  st = await state(page);
  check('when the timer fires, everything is locked and the user is sent Home', !st.adult && !st.extras && (await page.evaluate(() => currentTab)) === 'HOME', JSON.stringify(st));

  console.log('\n8. App to background / TV off');
  await page.evaluate(() => { window.__s.adult = true; window.__s.extras = true; appStatus.parentalControl.showAdult = true; appStatus.parentalControl.showExtras = true; renderSidebar(); });
  await page.evaluate(() => window.lockParentalControls()); await sleep(500);
  st = await state(page); tabs = await navTabs(page);
  check('background lock closes both', !st.adult && !st.extras && !tabs.includes('VAULT_18') && !tabs.includes('EXTRAS'), JSON.stringify(st));

  console.log('\n9. Kids mode');
  await page.evaluate(() => { window.__s.adult = true; window.__s.extras = true; appStatus.parentalControl.showAdult = true; appStatus.parentalControl.showExtras = true; renderSidebar(); });
  await go(page, 'PROFILE');
  await page.evaluate(() => document.getElementById('btnToggleKidsMode').click()); await sleep(600);
  st = await state(page); tabs = await navTabs(page);
  check('turning Kids mode ON needs no PIN and closes 18+ and Extras at once', !st.adult && !st.extras && !tabs.includes('VAULT_18') && !tabs.includes('EXTRAS'), JSON.stringify(st) + tabs.join());
  check('Kids mode: no Live TV tab', !tabs.includes('LIVE_TV'), tabs.join());
  await go(page, 'LIVE_TV');
  check('opening Live TV directly in Kids mode lands on Home', (await page.evaluate(() => currentTab)) === 'HOME');
  await page.close();

  console.log('\n10. A saved Kids profile');
  const kp = await newApp(browser, true);
  await sleep(300);
  let ktabs = await navTabs(kp);
  check('no Live TV, 18+ or Extras tab', !ktabs.includes('LIVE_TV') && !ktabs.includes('VAULT_18') && !ktabs.includes('EXTRAS'), ktabs.join());
  await go(kp, 'PROFILE');
  const kr = await kp.evaluate(() => ({ a: !!document.getElementById('btnToggleParentalLock'), e: !!document.getElementById('btnToggleExtrasLock') }));
  check('Profile screen has no unlock switches', !kr.a && !kr.e, JSON.stringify(kr));
  await go(kp, 'LIVE_TV');
  check('opening Live TV directly lands on Home', (await kp.evaluate(() => currentTab)) === 'HOME');
  await go(kp, 'EXTRAS');
  check('opening Extras directly lands on Home', (await kp.evaluate(() => currentTab)) === 'HOME');
  await go(kp, 'VAULT_18');
  check('opening 18+ directly lands on Home and asks no PIN', (await kp.evaluate(() => currentTab)) === 'HOME' && (await kp.evaluate(() => document.getElementById('parentalPinModal').style.display !== 'flex')));
  check('no JavaScript errors (Kids)', kp.errors.length === 0, kp.errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
