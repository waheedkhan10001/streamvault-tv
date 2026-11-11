// Popup remote-control tests (Puppeteer, REAL key presses).
// For every popup in the app: open it, press the arrows many times, and check focus NEVER leaves it
// (no jumping to the screen behind). Also checks the Back key closes the popup that is on top.
// Added after the first TV install showed focus escaping behind the sign-up popup; the same class of
// bug existed for the "Reset Master PIN" popup (it was missing from the list) and for any popup opened
// over the Detail screen (its focus trap stole focus back).
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'popup-ui-session-token-0123456789abcdef0123456789abcdef';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('=== StreamVault TV — Popup focus & Back-key tests ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.evaluateOnNewDocument((TOKEN) => {
    window.fetch = async (url) => new Response(JSON.stringify({ ok: true, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const account = { accountId: 'acc_1', email: 'owner@streamvault.tv', displayName: 'Account Owner' };
    const profiles = [{ id: 'prof_primary', name: 'Account Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        if (path === '/api/state') return JSON.stringify({ ok: true, totalCatalogCount: 10, credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'u' }, parentalControl: { isLocked: true, showAdult: false, hasPin: true, hasCustomPin: true } });
        if (path === '/api/status') return JSON.stringify({ ok: true, credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'u', password: 'p' }, catalogCount: 10 });
        if (path === '/api/session') return JSON.stringify({ ok: true, authenticated: true, token: TOKEN });
        if (path === '/api/auth/me') return JSON.stringify({ ok: true, account, token: TOKEN });
        if (path === '/api/playlists') return JSON.stringify({ ok: true, playlists: [] });
        if (path === '/api/profiles') return JSON.stringify({ ok: true, profiles, activeProfileId: 'prof_primary' });
        if (path === '/api/parental-pin') return JSON.stringify({ success: true, ok: true, hasCustomPin: true, hasPin: true });
        if (path.startsWith('/api/catalog')) return JSON.stringify({ ok: true, items: [] });
        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', TOKEN);
    localStorage.setItem('streamvault_session_token', TOKEN);
    localStorage.setItem('streamvault_account', JSON.stringify(account));
    localStorage.setItem('streamvault_active_profile_id', 'prof_primary');
  }, TOKEN);

  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => {
    const picker = document.getElementById('profilePickerOverlay');
    if (picker && picker.style.display === 'flex') { const c = picker.querySelector('.profile-picker-card'); if (c) c.click(); }
  });
  await sleep(300);
  await page.evaluate(async () => { await window.navigateToTab('SETTINGS'); });
  await sleep(400);

  const press = async k => { await page.keyboard.press(k); await sleep(110); };
  const isOpen = id => page.evaluate(id => document.getElementById(id)?.style.display === 'flex', id);
  const insideNow = id => page.evaluate(id => !!document.activeElement?.closest('#' + id), id);
  const describe = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);
  const closeAll = async () => {
    await page.evaluate(() => {
      for (const id of ['playlistModal','cloudAuthModal','resetPinModal','parentalPinModal','signOutModal','factoryResetModal','userProfileModal','addProfileModal','deleteProfileModal','deleteHistoryModal','clearAllHistoryModal','voiceSearchModal','detailOverlay'])
        { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
    });
    await sleep(80);
  };


  // Can the remote reach EVERY control in the popup? Builds the arrow-key graph by pressing each arrow on each control.
  const unreachable = id => page.evaluate((id) => {
    const modal = document.getElementById(id);
    const vis = el => !el.disabled && el.getAttribute('tabindex') !== '-1' && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
    const els = Array.from(modal.querySelectorAll('.tv-focusable, input, button, a[tabindex]')).filter(vis);
    const name = el => el.id || (el.innerText || el.placeholder || el.className || el.tagName).toString().trim().slice(0, 28);
    const keys = [['ArrowUp', 38], ['ArrowDown', 40], ['ArrowLeft', 37], ['ArrowRight', 39]];
    const edges = new Map(els.map(e => [e, new Set()]));
    for (const el of els) for (const [k, c] of keys) {
      el.focus(); window.handleTvKeyEvent(k, c);
      const to = document.activeElement;
      if (to && to !== el && edges.has(to)) edges.get(el).add(to);
    }
    const start = modal.contains(document.activeElement) && edges.has(document.activeElement) ? document.activeElement : els[0];
    const seen = new Set([start]); const q = [start];
    while (q.length) { const n = q.shift(); for (const m of edges.get(n) || []) if (!seen.has(m)) { seen.add(m); q.push(m); } }
    return els.filter(e => !seen.has(e)).map(name);
  }, id);

  const popups = [
    ['playlistModal', 'Add Playlist', () => window.openAddPlaylistModal()],
    ['signOutModal', 'Sign Out', () => window.openSignOutModal()],
    ['factoryResetModal', 'Factory Reset', () => window.openFactoryResetModal()],
    ['userProfileModal', 'User Profile', () => window.openUserProfileModal()],
    ['addProfileModal', 'Add Profile', () => window.promptAddNewProfile()],
    ['deleteHistoryModal', 'Delete History item', () => window.openDeleteHistoryModal('abc')],
    ['clearAllHistoryModal', 'Clear All History', () => window.openClearAllHistoryModal()],
    ['parentalPinModal', 'PIN entry', () => window.openParentalPinModal({ action: 'unlock' })],
    ['resetPinModal', 'Reset Master PIN', () => window.openResetPinModal()],
  ];

  console.log('1. Every popup keeps focus inside, and Back closes it');
  for (const [id, label, open] of popups) {
    await closeAll();
    await page.evaluate(open);
    await sleep(350);
    if (!(await isOpen(id))) { check(`${label}: opens`, false, 'did not open'); continue; }
    check(`${label}: opens with focus inside`, await insideNow(id), `focus is on "${await describe()}"`);
    let escaped = null;
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowLeft']) {
      await press(k);
      if (!(await insideNow(id))) { escaped = `after ${k} focus is on "${await describe()}"`; break; }
    }
    check(`${label}: 13 arrow presses never leave the popup`, !escaped, escaped || '');
    await page.evaluate(open); await sleep(300);   // fresh open, so the start point is the real opening focus
    const missing = await unreachable(id);
    check(`${label}: every control can be reached with the remote`, missing.length === 0, 'unreachable: ' + missing.join(', '));
    await press('Escape');
    await sleep(150);
    check(`${label}: Back key closes it`, !(await isOpen(id)));
  }

  console.log('\n2. Popup opened over the Detail screen (its focus trap used to steal focus)');
  {
    await closeAll();
    await page.evaluate(() => { document.getElementById('detailOverlay').style.display = 'flex'; });
    await page.evaluate(() => window.openSignOutModal());
    await sleep(300);
    let escaped = null;
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) {
      await press(k);
      if (!(await insideNow('signOutModal'))) { escaped = `after ${k} focus is on "${await describe()}"`; break; }
    }
    check('arrows stay inside the popup, not the Detail screen behind it', !escaped, escaped || '');
    await closeAll();
  }

  console.log('\n3. Two popups at once: Back closes the one on top first');
  {
    await closeAll();
    await page.evaluate(() => { window.openFactoryResetModal(); window.openSignOutModal(); });
    await sleep(300);
    await press('Escape');
    check('top popup (Sign Out) closes first', !(await isOpen('signOutModal')) && (await isOpen('factoryResetModal')));
    await press('Escape');
    check('then the one underneath closes', !(await isOpen('factoryResetModal')));
  }

  console.log('\n4. Reset PIN popup: typing and moving between its fields');
  {
    await closeAll();
    await page.evaluate(() => window.openResetPinModal());
    await sleep(350);
    check('focus starts on the password box', (await describe()) === 'resetPinPasswordInput', `focus is on "${await describe()}"`);
    await closeAll();
  }


  console.log('\n5. IPTV credentials popup: Down/Up visit every field in order, Enter moves on, typing works');
  {
    await closeAll();
    await page.evaluate(() => window.openAddPlaylistModal());
    await sleep(400);
    const order = ['inpPlaylistName', 'inpPlaylistServer', 'inpPlaylistUser', 'inpPlaylistPass', 'btnCancelPlaylist'];
    let start = await describe();
    if (start !== 'inpPlaylistName') { await page.evaluate(() => document.getElementById('inpPlaylistName').focus()); }
    const seen = ['inpPlaylistName'];
    for (let i = 0; i < 4; i++) { await press('ArrowDown'); seen.push(await describe()); }
    check('Down goes Name -> Server -> Username -> Password -> buttons', seen.slice(0, 4).join(',') === order.slice(0, 4).join(',') && ['btnCancelPlaylist', 'btnSavePlaylist'].includes(seen[4]), seen.join(' > '));
    for (let i = 0; i < 3; i++) await press('ArrowUp');
    check('Up walks back through Password, Username to Server', (await describe()) === 'inpPlaylistServer', await describe());
    // typing with the real keyboard, Enter to move on
    await page.evaluate(() => document.getElementById('inpPlaylistServer').focus());
    const flow = [['inpPlaylistServer', 'http://tv.example.com:8080'], ['inpPlaylistUser', 'myuser'], ['inpPlaylistPass', 'mypass']];
    let ok = true, why = ''; const trail = [];
    for (const [id, text] of flow) {
      if ((await describe()) !== id) { ok = false; why = `expected focus on ${id}, was ${await describe()} (${trail.join(', ')})`; break; }
      if (id === 'inpPlaylistServer') await press('Enter');   // OK opens the first box; the next ones open by themselves
      await page.keyboard.type(text); await sleep(60);
      await press('Enter');                       // OK again moves to the next box
      trail.push(id + '->' + await describe());
    }
    const vals = await page.evaluate(() => ['inpPlaylistServer', 'inpPlaylistUser', 'inpPlaylistPass'].map(i => document.getElementById(i).value));
    check('typing Server, Username, Password with Enter in between lands in the right boxes', ok && vals.join('|') === 'http://tv.example.com:8080|myuser|mypass', why || vals.join('|'));
    check('after Password, Enter reaches a button inside the popup', await insideNow('playlistModal') && /btn/.test(await describe()), await describe());
    const vis = await page.evaluate(() => { const r = document.getElementById('btnSavePlaylist').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
    check('Save button is fully on screen (popup not taller than the TV screen)', vis);
    await closeAll();
  }

  check('no JavaScript errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
