// Round 2 UI tests (Puppeteer): About/TMDB attribution, emailed-code PIN reset screen,
// and the PIN sync calls the TV page makes to the cloud (hash + salt, proof when changing).
// Like phases A-D, the native Kotlin layer is a JS mock here: this proves the UI/JS side only.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const TOKEN = 'round2-ui-session-token-0123456789abcdef0123456789abcdef';

async function run() {
  console.log('=== Running StreamVault TV — Round 2 UI Test Suite ===\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.evaluateOnNewDocument((TOKEN) => {
    // Cloud (absolute URL) calls: recorded and answered here. The page captures this as its raw fetch.
    window.__cloud = [];
    window.fetch = async (url, init) => {
      const u = String(url);
      window.__cloud.push({ url: u, method: init && init.method, headers: (init && init.headers) || {}, body: init && init.body });
      let reply = { ok: true };
      if (u.endsWith('/api/account/request-pin-reset')) reply = { success: true, sentTo: 'o***@streamvault.tv' };
      if (u.endsWith('/api/account/pin')) reply = { success: true };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // Native layer mock: every call is recorded.
    window.__native = [];
    const account = { accountId: 'acc_1', email: 'owner@streamvault.tv', displayName: 'Account Owner' };
    const profiles = [{ id: 'prof_primary', name: 'Account Owner', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: Date.now() }];
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const req = body ? JSON.parse(body) : {};
        window.__native.push({ method, path, req });
        if (path === '/api/state') return JSON.stringify({ ok: true, totalCatalogCount: 10, credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'user1' }, parentalControl: { isLocked: true, showAdult: false, hasPin: true, hasCustomPin: true } });
        if (path === '/api/status') return JSON.stringify({ ok: true, credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'user1', password: 'pass1' }, catalogCount: 10 });
        if (path === '/api/session') return JSON.stringify({ ok: true, authenticated: true, token: TOKEN });
        if (path === '/api/auth/me') return JSON.stringify({ ok: true, account, token: TOKEN });
        if (path === '/api/playlists') return JSON.stringify({ ok: true, playlists: [{ playlist_id: 'pl_1', name: 'Primary IPTV', server_url: 'http://iptv.example.com:8080', username: 'user1', password: 'pass1', is_enabled: 1, status: 'working' }] });
        if (path === '/api/profiles') return JSON.stringify({ ok: true, profiles, activeProfileId: 'prof_primary' });
        if (path === '/api/parental-pin') {
          if (req.action === 'set_pin') return JSON.stringify({ success: true, pinHash: 'a'.repeat(64), pinSalt: 'salt-1234-abcd', hasCustomPin: true });
          if (req.action === 'reset_pin') return JSON.stringify({ success: true, message: 'PIN reset successfully' });
          return JSON.stringify({ success: true, ok: true });
        }
        if (path.startsWith('/api/catalog')) return JSON.stringify({ ok: true, items: [] });
        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };

    localStorage.setItem('sv_auth_token', TOKEN);
    localStorage.setItem('streamvault_session_token', TOKEN);
    localStorage.setItem('streamvault_account', JSON.stringify(account));
    localStorage.setItem('streamvault_active_theme', 'purple');
    localStorage.setItem('streamvault_active_profile_id', 'prof_primary');
  }, TOKEN);

  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await page.evaluate(() => {
    const picker = document.getElementById('profilePickerOverlay');
    if (picker && picker.style.display === 'flex') { const c = picker.querySelector('.profile-picker-card'); if (c) c.click(); }
  });
  await new Promise(r => setTimeout(r, 200));

  const goSettings = async () => {
    await page.evaluate(async () => { await window.navigateToTab('SETTINGS'); });
    await page.waitForFunction(() => document.getElementById('btnAddPlaylistBtn') !== null);
    await new Promise(r => setTimeout(r, 150));
  };
  let passed = 0;
  const pass = (m) => { passed++; console.log('  ✓ PASS: ' + m + '\n'); };

  // ---------- U1: About card + TMDB attribution, reachable with the remote ----------
  console.log('[Test 1] Settings > About shows the exact TMDB notice and is reachable with the D-pad...');
  await goSettings();
  const about = await page.evaluate(() => {
    const card = document.getElementById('settingsAboutCard');
    const txt = document.getElementById('tmdbAttributionText');
    return {
      exists: !!card,
      focusable: !!card && card.tabIndex === 0 && card.classList.contains('tv-focusable'),
      text: txt ? txt.innerText.trim() : null,
      mentionsAbout: !!card && /About/i.test(card.innerText)
    };
  });
  assert.equal(about.exists, true, 'About card present');
  assert.equal(about.focusable, true, 'About card is focusable (tabindex 0 + tv-focusable)');
  assert.equal(about.mentionsAbout, true);
  assert.equal(about.text, 'This product uses the TMDB API but is not endorsed or certified by TMDB.', 'exact required wording');

  const reached = await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      if (document.activeElement && document.activeElement.id === 'settingsAboutCard') return { ok: true, steps: i };
      window.handleTvKeyEvent('ArrowDown');
    }
    return { ok: document.activeElement && document.activeElement.id === 'settingsAboutCard', steps: 60 };
  });
  assert.equal(reached.ok, true, 'About card must be reachable by pressing Down on the remote');
  const visible = await page.evaluate(() => {
    const r = document.getElementById('settingsAboutCard').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.height > 0;
  });
  assert.equal(visible, true, 'focused About card is scrolled fully into view');
  pass(`TMDB notice exact; card focusable, reached in ${reached.steps} D-pad presses and visible on screen.`);

  // ---------- U2: reset-PIN modal with emailed code ----------
  console.log('[Test 2] Reset PIN screen: "Email me a code" + code entry...');
  await page.evaluate(() => { openResetPinModal(); });
  const modal = await page.evaluate(() => ({
    shown: document.getElementById('resetPinModal').style.display === 'flex',
    hasCode: !!document.getElementById('resetPinCodeInput'),
    hasReq: !!document.getElementById('btnRequestPinResetCode'),
    reqFocusable: document.getElementById('btnRequestPinResetCode').classList.contains('tv-focusable'),
    codeFocusable: document.getElementById('resetPinCodeInput').classList.contains('tv-focusable')
  }));
  assert.deepEqual(modal, { shown: true, hasCode: true, hasReq: true, reqFocusable: true, codeFocusable: true });

  await page.evaluate(() => { window.__cloud.length = 0; });
  await page.evaluate(async () => { await requestPinResetCode(); });
  const rq = await page.evaluate(() => ({
    call: window.__cloud.find(c => c.url.endsWith('/api/account/request-pin-reset')),
    msg: document.getElementById('resetPinErrorMessage').innerText
  }));
  assert.ok(rq.call, 'request-pin-reset called');
  assert.equal(rq.call.method, 'POST');
  assert.equal(rq.call.headers.Authorization, 'Bearer ' + TOKEN, 'sent with the signed-in session token');
  assert.match(rq.msg, /Code sent to o\*\*\*@streamvault\.tv/);

  // code path
  await page.evaluate(() => {
    document.getElementById('resetPinPasswordInput').value = '';
    document.getElementById('resetPinCodeInput').value = '123456';
    document.getElementById('resetPinNewInput').value = '4321';
    window.__native.length = 0;
  });
  await page.evaluate(async () => { await submitResetPin(); });
  let nat = await page.evaluate(() => window.__native.filter(n => n.path === '/api/parental-pin' && n.req.action === 'reset_pin').map(n => n.req));
  assert.equal(nat.length, 1);
  assert.deepEqual(nat[0], { action: 'reset_pin', code: '123456', newPin: '4321' }, 'code path sends the code, no password');

  // password path (unchanged behaviour)
  await page.evaluate(() => {
    openResetPinModal();
    document.getElementById('resetPinPasswordInput').value = 'AccountPass123!';
    document.getElementById('resetPinNewInput').value = '2468';
    window.__native.length = 0;
  });
  await page.evaluate(async () => { await submitResetPin(); });
  nat = await page.evaluate(() => window.__native.filter(n => n.path === '/api/parental-pin' && n.req.action === 'reset_pin').map(n => n.req));
  assert.deepEqual(nat[0], { action: 'reset_pin', password: 'AccountPass123!', newPin: '2468' }, 'password path still works');

  // validation
  const msgs = await page.evaluate(async () => {
    const out = {};
    openResetPinModal();
    document.getElementById('resetPinNewInput').value = '1234';
    window.__native.length = 0;
    await submitResetPin();
    out.neither = document.getElementById('resetPinErrorMessage').innerText;
    document.getElementById('resetPinCodeInput').value = '12345';
    await submitResetPin();
    out.shortCode = document.getElementById('resetPinErrorMessage').innerText;
    document.getElementById('resetPinCodeInput').value = '123456';
    document.getElementById('resetPinNewInput').value = '12';
    await submitResetPin();
    out.shortPin = document.getElementById('resetPinErrorMessage').innerText;
    out.nativeCalls = window.__native.filter(n => n.path === '/api/parental-pin' && n.req.action === 'reset_pin').length;
    return out;
  });
  assert.match(msgs.neither, /password or the 6-digit code/);
  assert.match(msgs.shortCode, /exactly 6 digits/);
  assert.match(msgs.shortPin, /exactly 4 numeric digits/);
  assert.equal(msgs.nativeCalls, 0, 'nothing is sent while the form is invalid');
  await page.evaluate(() => closeResetPinModal());
  pass('Email-code request uses the session; code and password paths send the right bodies; bad input never leaves the TV.');

  // ---------- U3: PIN sync helper ----------
  console.log('[Test 3] PIN sync to cloud sends hash + salt, with proof only when changing...');
  await page.evaluate(() => { window.__cloud.length = 0; });
  await page.evaluate(() => {
    syncPinToCloud({ pinHash: 'c'.repeat(64), pinSalt: 'salt-aaaa-bbbb' });                       // first PIN
    syncPinToCloud({ pinHash: 'd'.repeat(64), pinSalt: 'salt-cccc-dddd' }, { currentPin: '1111' }); // change
    syncPinToCloud({ pinHash: 'e'.repeat(64) });                                                   // no salt -> must not send
    syncPinToCloud(null);
  });
  const sent = await page.evaluate(() => window.__cloud.filter(c => c.url.endsWith('/api/account/pin')).map(c => ({ auth: c.headers.Authorization, body: JSON.parse(c.body) })));
  assert.equal(sent.length, 2, 'only calls that have both hash and salt are sent');
  assert.deepEqual(sent[0].body, { pinHash: 'c'.repeat(64), pinSalt: 'salt-aaaa-bbbb' }, 'first PIN: no proof field');
  assert.deepEqual(sent[1].body, { pinHash: 'd'.repeat(64), pinSalt: 'salt-cccc-dddd', currentPin: '1111' }, 'change: carries current PIN');
  assert.equal(sent[0].auth, 'Bearer ' + TOKEN);
  pass('Helper sends hash+salt; proof included only for a change; incomplete data is never sent.');

  // ---------- U4: Settings "Change PIN" syncs with proof ----------
  console.log('[Test 4] Changing the PIN (Profile > Parental Controls) syncs the new hash+salt with the old PIN as proof...');
  await page.evaluate(async () => { await window.navigateToTab('PROFILE'); });
  await page.waitForFunction(() => document.getElementById('setCurPin') !== null);
  await page.evaluate(() => {
    window.__cloud.length = 0; window.__native.length = 0;
    document.getElementById('setCurPin').value = '1111';
    document.getElementById('setNewPin').value = '2222';
    document.getElementById('setConfirmPin').value = '2222';
  });
  await page.evaluate(async () => { await changeParentalPin(); });
  const nativeSet = await page.evaluate(() => window.__native.find(n => n.path === '/api/parental-pin' && n.req.action === 'set_pin'));
  assert.deepEqual(nativeSet.req, { action: 'set_pin', pin: '1111', newPin: '2222' });
  const cloudSet = await page.evaluate(() => { const c = window.__cloud.find(x => x.url.endsWith('/api/account/pin')); return c && JSON.parse(c.body); });
  assert.deepEqual(cloudSet, { pinHash: 'a'.repeat(64), pinSalt: 'salt-1234-abcd', currentPin: '1111' });
  assert.equal(JSON.stringify(cloudSet).includes('2222'), false, 'the NEW PIN itself is never sent to the cloud');
  pass('Change-PIN pushes hash+salt with currentPin proof; the new PIN never leaves the TV.');

  // ---------- U5: sign-in on a new TV restores hash AND salt ----------
  console.log('[Test 5] Signing in restores the PIN hash and its salt into the TV...');
  await page.evaluate(() => { window.__native.length = 0; });
  await page.evaluate(async () => {
    await handleSuccessfulAuth({ token: 'tok-' + 'x'.repeat(60), accountId: 'acc_2', email: 'o@streamvault.tv', pinHash: 'b'.repeat(64), pinSalt: 'salt-9999-wxyz' });
  });
  const restore = await page.evaluate(() => window.__native.find(n => n.path === '/api/parental-pin' && n.req.action === 'restore'));
  assert.ok(restore, 'restore called on sign-in');
  assert.deepEqual(restore.req, { action: 'restore', pinHash: 'b'.repeat(64), pinSalt: 'salt-9999-wxyz' }, 'salt travels with the hash');
  pass('Sign-in restore carries the salt (previously the salt was lost, so a restored PIN could never match).');

  console.log('[Test 6] No page errors during any of the above...');
  assert.equal(pageErrors.length, 0, 'page errors: ' + pageErrors.join(' | '));
  pass('Zero page errors.');

  await browser.close();
  console.log('====================================================');
  console.log(`  ALL ROUND 2 UI ASSERTIONS PASSED (${passed}/6)`);
  console.log('====================================================');
}

run().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
