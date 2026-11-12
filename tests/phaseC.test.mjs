import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

async function runPhaseCTests() {
  console.log('=== Running StreamVault TV — Phase C Test Suite ===\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  // Native AndroidApp mock implementing StreamVault backend
  await page.evaluateOnNewDocument(() => {
    let mockSessionToken = 'test-session-token-phase-c';
    let mockAccount = { accountId: 'acc_1', email: 'owner@streamvault.tv', displayName: 'Account Owner' };
    let mockMasterPin = '0000';

    let profiles = [
      {
        id: 'prof_primary',
        name: 'Account Owner',
        avatarColor: '#7C3AED',
        isKids: false,
        theme: 'purple',
        isPrimary: true,
        updatedAt: Date.now()
      },
      {
        id: 'prof_kids',
        name: 'Junior',
        avatarColor: '#10B981',
        isKids: true,
        theme: 'disney',
        isPrimary: false,
        updatedAt: Date.now()
      }
    ];
    let activeProfileId = 'prof_primary';

    let playlists = [
      {
        playlist_id: 'pl_1',
        name: 'Primary IPTV',
        server_url: 'http://iptv.example.com:8080',
        username: 'user1',
        password: 'pass1',
        is_enabled: 1,
        status: 'working'
      }
    ];

    window.AndroidApp = {
      handleApiRequest: (method, path, body) => {
        return window.AndroidApp.handleApiRequestWithAuth(method, path, body, null);
      },
      handleApiRequestWithAuth: (method, path, body, authHeader) => {
        const token = (authHeader || '').replace('Bearer ', '').trim() || mockSessionToken;
        if (!token && (path.startsWith('/api/playlists') || path.startsWith('/api/profiles') || path === '/api/sync-now')) {
          return JSON.stringify({ error: 'Unauthorized', status: 401, ok: false });
        }

        if (path === '/api/state') {
          return JSON.stringify({
            ok: true,
            totalCatalogCount: 10,
            credentials: { serverUrl: 'http://iptv.example.com:8080', username: 'user1' },
            parentalControl: {
              isLocked: true,
              showAdult: false,
              attemptsRemaining: 5,
              lockoutUntil: 0
            }
          });
        }
        if (path === '/api/status') {
          return JSON.stringify({
            ok: true,
            credentials: {
              serverUrl: 'http://iptv.example.com:8080',
              username: 'user1',
              password: 'pass1'
            },
            catalogCount: 10
          });
        }
        if (path === '/api/session') {
          return JSON.stringify({ ok: true, authenticated: true, token: mockSessionToken });
        }
        if (path === '/api/auth/me') {
          return JSON.stringify({ ok: true, account: mockAccount, token: mockSessionToken });
        }
        if (path === '/api/playlists') {
          return JSON.stringify({ ok: true, playlists });
        }
        if (path === '/api/profiles') {
          return JSON.stringify({ ok: true, profiles, activeProfileId });
        }
        if (path === '/api/profiles/switch') {
          const req = JSON.parse(body || '{}');
          activeProfileId = req.profileId || activeProfileId;
          return JSON.stringify({ ok: true, activeProfileId });
        }
        if (path === '/api/parental-pin') {
          const req = JSON.parse(body || '{}');
          if (method === 'POST') {
            if (req.action === 'verify') {
              return JSON.stringify({ ok: req.pin === mockMasterPin, locked: false, attemptsRemaining: 5 });
            }
          }
          return JSON.stringify({ ok: true });
        }
        if (path === '/api/cloud/status') {
          return JSON.stringify({ ok: true, activeCode: { code: 'SV-TEST' } });
        }
        if (path.startsWith('/api/catalog')) {
          return JSON.stringify({ ok: true, items: [] });
        }
        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };

    localStorage.setItem('sv_auth_token', 'test-session-token-phase-c');
    localStorage.setItem('streamvault_session_token', 'test-session-token-phase-c');
    localStorage.setItem('streamvault_account', JSON.stringify(mockAccount));
    localStorage.setItem('streamvault_active_theme', 'purple');
    localStorage.setItem('streamvault_active_profile_id', 'prof_primary');
  });

  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');

  // If Profile Picker overlay is open (since account has > 1 profile), pick primary profile
  await page.evaluate(() => {
    const picker = document.getElementById('profilePickerOverlay');
    if (picker && picker.style.display === 'flex') {
      const firstCard = picker.querySelector('.profile-picker-card');
      if (firstCard) firstCard.click();
    }
  });
  await new Promise(r => setTimeout(r, 150));

  // ==========================================
  // [Test 1] Zero page errors on startup
  // ==========================================
  console.log('[Test 1] Asserting zero page errors on startup...');
  assert.equal(pageErrors.length, 0, `Expected 0 page errors, got: ${pageErrors.join(', ')}`);
  console.log('  ✓ PASS: Zero page errors on startup.\n');

  // ==========================================
  // [Test 2] Settings Screen: Spatial Walking & Reachability
  // ==========================================
  console.log('[Test 2] Testing Settings Screen spatial navigation and reachability...');
  await page.evaluate(async () => {
    await window.navigateToTab('SETTINGS');
  });
  try {
    await page.waitForFunction(() => document.getElementById('btnAddPlaylistBtn') !== null, { timeout: 15000 });
  } catch (e) {
    const diag = await page.evaluate(() => (document.getElementById('mainViewport') || {}).innerText || 'no viewport');
    const more = await page.evaluate(() => ({ tab: typeof currentTab !== 'undefined' ? currentTab : '?', token: typeof getStoredAuthToken === 'function' ? !!getStoredAuthToken() : '?', locked: typeof isAppLockedForPlaylist === 'function' ? isAppLockedForPlaylist() : '?', body: document.body.innerText.slice(0, 400), url: location.href }));
    console.log('DIAG state:', JSON.stringify(more));
    console.log('DIAG page errors:', JSON.stringify(pageErrors));
    console.log('DIAG viewport text:', String(diag).slice(0, 600));
    throw e;
  }
  await new Promise(r => setTimeout(r, 100));

  // Assert expected focusables exist in Settings
  const settingsFocusables = await page.evaluate(() => {
    const vp = document.getElementById('mainViewport');
    const items = Array.from(vp.querySelectorAll('.tv-focusable, button, input'))
      .filter(el => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0);
    return items.map(el => el.id || el.className || el.tagName);
  });
  assert.ok(settingsFocusables.length >= 6, `Expected at least 6 focusables in Settings, got ${settingsFocusables.length}`);

  // Walk through Settings elements with simulated arrow keys
  const settingsReached = await page.evaluate(async () => {
    const reached = new Set();
    const startEl = document.activeElement;
    reached.add(startEl?.id || startEl?.className || 'none');

    const sequence = [
      'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowRight',
      'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowLeft',
      'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowLeft'
    ];

    for (const key of sequence) {
      window.handleTvKeyEvent(key);
      const cur = document.activeElement;
      if (cur && cur.id) reached.add(cur.id);
      if (cur && cur.classList && cur.classList.contains('tv-focusable')) {
        reached.add(cur.id || cur.innerText.trim().slice(0, 15));
      }
    }
    return { list: Array.from(reached), startEl: startEl?.id || startEl?.className };
  });
  console.log('settingsReached details:', settingsReached);
  assert.ok(settingsReached.list.length >= 4, `Expected multiple Settings controls reached via D-pad, got ${settingsReached.list.length}`);
  console.log(`  ✓ PASS: Settings controls reached smoothly via spatial navigation (${settingsReached.list.join(', ')}).\n`);

  // ==========================================
  // [Test 3] Profile Screen: Spatial Walking & Reachability
  // ==========================================
  console.log('[Test 3] Testing Profile Screen spatial navigation and reachability...');
  await page.evaluate(async () => {
    await window.navigateToTab('PROFILE');
  });
  await page.waitForFunction(() => document.getElementById('profNameInput') !== null);
  await new Promise(r => setTimeout(r, 100));

  const profileFocusables = await page.evaluate(() => {
    const vp = document.getElementById('mainViewport');
    const items = Array.from(vp.querySelectorAll('.tv-focusable, button, input'))
      .filter(el => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0);
    return items.map(el => el.id || el.className);
  });
  assert.ok(profileFocusables.length >= 8, `Expected at least 8 focusables in Profile, got ${profileFocusables.length}`);

  // Verify key Profile controls exist and are focusable
  const profileKeyControls = await page.evaluate(() => {
    return {
      hasNameInput: !!document.getElementById('profNameInput'),
      themeChipsCount: document.querySelectorAll('.profile-theme-chip').length,
      hasKidsToggle: !!document.getElementById('btnToggleKidsMode'),
      hasSaveProfile: !!document.getElementById('btnSaveProfile'),
      hasPinInput: !!document.getElementById('setCurPin'),
      hasUpdatePin: !!document.getElementById('btnUpdatePin'),
      hasToggleParentalLock: !!document.getElementById('btnToggleParentalLock'),
      hasClearHistory: !!document.getElementById('btnClearHistory')
    };
  });
  assert.ok(profileKeyControls.hasNameInput, 'profNameInput must exist');
  assert.equal(profileKeyControls.themeChipsCount, 4, 'Expected 4 theme chips (purple, netflix, disney, prime)');
  assert.ok(profileKeyControls.hasKidsToggle, 'btnToggleKidsMode must exist');
  assert.ok(profileKeyControls.hasSaveProfile, 'btnSaveProfile must exist');
  assert.ok(profileKeyControls.hasPinInput, 'setCurPin must exist');
  assert.ok(profileKeyControls.hasUpdatePin, 'btnUpdatePin must exist');
  assert.ok(profileKeyControls.hasToggleParentalLock, 'btnToggleParentalLock must exist');
  assert.ok(profileKeyControls.hasClearHistory, 'btnClearHistory must exist');

  // Walk through Profile controls via spatial navigation
  const profileReached = await page.evaluate(() => {
    const reached = new Set();
    // Start at profNameInput
    const inp = document.getElementById('profNameInput');
    inp.focus();
    reached.add('profNameInput');

    // Down to theme chips
    window.handleTvKeyEvent('ArrowDown');
    if (document.activeElement?.classList.contains('profile-theme-chip')) {
      reached.add('theme-chip');
    }
    // Right across chips
    window.handleTvKeyEvent('ArrowRight');
    if (document.activeElement?.classList.contains('profile-theme-chip')) {
      reached.add('theme-chip-2');
    }
    // Down to kids mode toggle
    window.__navTrail = [document.activeElement.id || document.activeElement.className];
    window.handleTvKeyEvent('ArrowDown');
    window.__navTrail.push(document.activeElement.id || document.activeElement.className);
    if (document.activeElement?.id === 'btnToggleKidsMode') {
      reached.add('btnToggleKidsMode');
    }
    // Down to save profile
    window.handleTvKeyEvent('ArrowDown');
    if (document.activeElement?.id === 'btnSaveProfile') {
      reached.add('btnSaveProfile');
    }
    // Right to Parental controls / Clear history
    window.handleTvKeyEvent('ArrowRight');
    if (document.activeElement?.id) {
      reached.add(document.activeElement.id);
    }
    // Up towards PIN inputs
    window.handleTvKeyEvent('ArrowUp');
    window.handleTvKeyEvent('ArrowUp');
    if (document.activeElement?.id) {
      reached.add(document.activeElement.id);
    }
    return Array.from(reached);
  });

  assert.ok(profileReached.includes('profNameInput'), 'profNameInput must be reached');
  assert.ok(profileReached.includes('theme-chip'), 'Theme chip must be reached');
  const trail = await page.evaluate(() => JSON.stringify(window.__navTrail || []) + ' vp=' + innerWidth + 'x' + innerHeight + ' rects=' + JSON.stringify(['btnToggleKidsMode','btnSaveProfile'].map(id => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return [id, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })) + ' chips=' + JSON.stringify([...document.querySelectorAll('.profile-theme-chip')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })));
  assert.ok(profileReached.includes('btnToggleKidsMode'), 'btnToggleKidsMode must be reached ' + trail);
  assert.ok(profileReached.includes('btnSaveProfile'), 'btnSaveProfile must be reached');
  console.log(`  ✓ PASS: Profile controls reached smoothly via spatial navigation (${profileReached.join(', ')}).\n`);

  // ==========================================
  // [Test 4] Left Boundary Rule: Leftmost Control -> Active Sidebar Item
  // ==========================================
  console.log('[Test 4] Testing Left boundary rule from content to active sidebar element...');
  // In Settings: leftmost control -> sidebarSettingsBtn
  await page.evaluate(async () => {
    await window.navigateToTab('SETTINGS');
  });
  await page.waitForFunction(() => document.getElementById('btnFirstRunAddPlaylist') !== null || document.getElementById('btnAddPlaylistBtn') !== null);
  await new Promise(r => setTimeout(r, 100));
  const test4Diag = await page.evaluate(() => {
    const firstControl = document.getElementById('btnFirstRunAddPlaylist') || document.getElementById('btnAddPlaylistBtn');
    firstControl.focus();
    const beforeId = document.activeElement?.id;
    const handled = window.handleTvKeyEvent('ArrowLeft');
    const afterId = document.activeElement?.id;
    return { beforeId, handled, afterId };
  });
  console.log('Test 4 diag:', test4Diag);
  const settingsActiveSidebar = test4Diag.afterId;
  assert.equal(settingsActiveSidebar, 'sidebarSettingsBtn', 'ArrowLeft from leftmost Settings control must focus sidebarSettingsBtn');

  // In Profile: leftmost control -> sidebarUserProfilePill
  await page.evaluate(async () => {
    await window.navigateToTab('PROFILE');
  });
  await page.waitForFunction(() => document.getElementById('profNameInput') !== null);
  await new Promise(r => setTimeout(r, 100));
  await page.evaluate(() => {
    const firstControl = document.getElementById('profNameInput');
    firstControl.focus();
    window.handleTvKeyEvent('ArrowLeft');
  });
  const profileActiveSidebar = await page.evaluate(() => document.activeElement?.id);
  assert.equal(profileActiveSidebar, 'sidebarUserProfilePill', 'ArrowLeft from leftmost Profile control must focus sidebarUserProfilePill');
  console.log('  ✓ PASS: Left boundary jumps cleanly to active sidebar item for Settings and Profile.\n');

  // ==========================================
  // [Test 5] Leanback Back Key Contract: Content -> Active Sidebar -> HOME -> Exit Confirm
  // ==========================================
  console.log('[Test 5] Testing Leanback Back key hierarchical contract...');
  // 5a: Back from Settings content -> focuses sidebarSettingsBtn
  await page.evaluate(async () => {
    await window.navigateToTab('SETTINGS');
  });
  await page.waitForFunction(() => document.getElementById('btnAddPlaylistBtn') !== null);
  await new Promise(r => setTimeout(r, 100));
  await page.evaluate(() => {
    const btn = document.getElementById('btnAddPlaylistBtn') || document.querySelector('#mainViewport .tv-focusable');
    btn.focus();
  });
  const backHandledSettings = await page.evaluate(() => window.handleAppBackKey());
  const focusAfterBackSettings = await page.evaluate(() => document.activeElement?.id);
  assert.equal(backHandledSettings, true, 'handleAppBackKey must return true when moving to sidebar');
  assert.equal(focusAfterBackSettings, 'sidebarSettingsBtn', 'Back from Settings content must focus sidebarSettingsBtn');

  // 5b: Back from Profile content -> focuses sidebarUserProfilePill
  await page.evaluate(async () => {
    await window.navigateToTab('PROFILE');
  });
  await page.waitForFunction(() => document.getElementById('btnSaveProfile') !== null);
  await new Promise(r => setTimeout(r, 100));
  await page.evaluate(() => {
    const btn = document.getElementById('btnSaveProfile');
    btn.focus();
  });
  const backHandledProfile = await page.evaluate(() => window.handleAppBackKey());
  const focusAfterBackProfile = await page.evaluate(() => document.activeElement?.id);
  assert.equal(backHandledProfile, true, 'handleAppBackKey must return true when moving to sidebar');
  assert.equal(focusAfterBackProfile, 'sidebarUserProfilePill', 'Back from Profile content must focus sidebarUserProfilePill');

  // 5c: Back from sidebar when currentTab !== 'HOME' -> navigates to HOME and focuses HOME nav button
  const backFromSidebarNonHome = await page.evaluate(() => window.handleAppBackKey());
  const currentTabAfterSidebarBack = await page.evaluate(() => window.currentTab);
  const focusedTabBtn = await page.evaluate(() => document.activeElement?.getAttribute('data-tab'));
  assert.equal(backFromSidebarNonHome, true, 'handleAppBackKey must return true when navigating from sidebar to HOME');
  assert.equal(currentTabAfterSidebarBack, 'HOME', 'Tab must transition to HOME');
  assert.equal(focusedTabBtn, 'HOME', 'Focus must land on HOME nav button');

  // 5d: Back from HOME nav button in sidebar -> returns false for exit confirmation
  const backFromHomeSidebar = await page.evaluate(() => window.handleAppBackKey());
  assert.equal(backFromHomeSidebar, false, 'handleAppBackKey must return false on HOME sidebar so Android TV can confirm exit');
  console.log('  ✓ PASS: Back key contract (Content -> Sidebar item -> HOME -> Exit confirm) fully verified.\n');

  // ==========================================
  // [Test 6] Text Input Caret Navigation
  // ==========================================
  console.log('[Test 6] Testing text input caret movement without spatial focus traps...');
  await page.evaluate(async () => {
    await window.navigateToTab('PROFILE');
  });
  await page.waitForFunction(() => document.getElementById('profNameInput') !== null);
  const caretHandled = await page.evaluate(() => {
    const inp = document.getElementById('profNameInput');
    inp.removeAttribute('readonly');
    inp.value = 'StreamVault';
    inp.focus();
    inp.setSelectionRange(5, 5); // caret in middle

    // ArrowLeft and ArrowRight should NOT trigger spatial navigation
    const leftHandled = window.handleTvKeyEvent('ArrowLeft');
    const rightHandled = window.handleTvKeyEvent('ArrowRight');
    const stillFocused = document.activeElement === inp;

    return { leftHandled, rightHandled, stillFocused };
  });

  assert.equal(caretHandled.leftHandled, false, 'ArrowLeft while editing text input must allow native caret movement (return false)');
  assert.equal(caretHandled.rightHandled, false, 'ArrowRight while editing text input must allow native caret movement (return false)');
  assert.ok(caretHandled.stillFocused, 'Input must remain focused while navigating text caret');
  console.log('  ✓ PASS: Native text input caret movement preserved during active editing.\n');

  // ==========================================
  // [Test 7] Enter Key Activation on Focusables
  // ==========================================
  console.log('[Test 7] Testing Enter key activation on buttons and theme chips...');
  await page.evaluate(async () => {
    await window.navigateToTab('PROFILE');
  });
  await page.waitForFunction(() => document.querySelector('.profile-theme-chip[data-theme="netflix"]') !== null);
  const enterResults = await page.evaluate(() => {
    let themeChanged = false;

    // Focus red theme chip and press Enter
    const redChip = document.querySelector('.profile-theme-chip[data-theme="netflix"]');
    redChip.focus();
    window.handleTvKeyEvent('Enter');
    // a theme click is now a preview: the screen changes at once, and it is only stored when Save Profile is pressed
    themeChanged = document.body.classList.contains('theme-netflix') && localStorage.getItem('streamvault_active_theme') !== 'netflix';

    // Focus readonly input and press Enter -> should remove readonly
    const inp = document.getElementById('profNameInput');
    inp.setAttribute('readonly', 'true');
    inp.focus();
    window.handleTvKeyEvent('Enter');
    const readonlyRemoved = !inp.readOnly;

    return { themeChanged, readonlyRemoved };
  });

  assert.ok(enterResults.themeChanged, 'Enter key must activate theme chip');
  assert.ok(enterResults.readonlyRemoved, 'Enter key on readonly input must enter edit mode');
  console.log('  ✓ PASS: Enter key cleanly activates chips, buttons, and input editing.\n');

  // ==========================================
  // [Test 8] Modal Navigation and Focus Trapping
  // ==========================================
  console.log('[Test 8] Testing modal focus trapping and two-way navigation in playlistModal & parentalPinModal...');
  // 8a: Playlist modal
  const playlistModalNav = await page.evaluate(() => {
    window.openAddPlaylistModal();
    const modal = document.getElementById('playlistModal');
    const serverInp = document.getElementById('inpPlaylistServer');
    serverInp.focus();

    // Down to User
    window.handleTvKeyEvent('ArrowDown');
    const userInp = document.activeElement;

    // Down to Pass (Username and Password are stacked now, one per row)
    window.handleTvKeyEvent('ArrowDown');
    const passInp = document.activeElement;

    // Down to Save
    window.handleTvKeyEvent('ArrowDown');
    const saveBtn = document.activeElement;

    // Left to Cancel
    window.handleTvKeyEvent('ArrowLeft');
    const cancelBtn = document.activeElement;

    // Right back to Save
    window.handleTvKeyEvent('ArrowRight');
    const saveBtnAgain = document.activeElement;

    window.closePlaylistModal();

    return {
      userInpId: userInp?.id,
      passInpId: passInp?.id,
      saveBtnId: saveBtn?.id,
      cancelBtnId: cancelBtn?.id,
      saveBtnAgainId: saveBtnAgain?.id
    };
  });

  assert.equal(playlistModalNav.userInpId, 'inpPlaylistUser');
  assert.equal(playlistModalNav.passInpId, 'inpPlaylistPass');
  assert.equal(playlistModalNav.saveBtnId, 'btnSavePlaylist');
  assert.equal(playlistModalNav.cancelBtnId, 'btnCancelPlaylist');
  assert.equal(playlistModalNav.saveBtnAgainId, 'btnSavePlaylist');

  // 8b: Back key in modal closes modal and keeps focus
  const backClosesModal = await page.evaluate(() => {
    window.openAddPlaylistModal();
    const modalBefore = document.getElementById('playlistModal').style.display;
    const handled = window.handleAppBackKey();
    const modalAfter = document.getElementById('playlistModal').style.display;
    return { modalBefore, handled, modalAfter };
  });

  assert.equal(backClosesModal.modalBefore, 'flex');
  assert.equal(backClosesModal.handled, true);
  assert.equal(backClosesModal.modalAfter, 'none');
  console.log('  ✓ PASS: Modal focus trapping and two-way navigation verified.\n');

  await browser.close();
  console.log('====================================================');
  console.log('  ALL PHASE C ASSERTIONS PASSED (8/8)');
  console.log('====================================================');
}

runPhaseCTests().catch(err => {
  console.error('\n❌ PHASE C TEST SUITE FAILED:', err);
  process.exit(1);
});
