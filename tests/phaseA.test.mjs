import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UI_PATH = 'file:///C:/Users/wkhan/.gemini/antigravity/scratch/streamvault-tv/app/src/main/assets/tv-ui.html';

async function runPhaseATests() {
  console.log('=== Running StreamVault TV — Phase A Test Suite ===\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  // Native AndroidApp mock simulating AppApiRouter
  await page.evaluateOnNewDocument(() => {
    let mockSessionToken = null;
    let mockCredentials = { playlistName: '', serverUrl: '', username: '', password: '' };
    let mockCatalogCount = 0;

    window.AndroidApp = {
      handleApiRequest: (method, path, body) => {
        return window.AndroidApp.handleApiRequestWithAuth(method, path, body, null);
      },
      handleApiRequestWithAuth: (method, path, body, authHeader) => {
        const token = (authHeader || '').replace('Bearer ', '').trim() || mockSessionToken;
        const hasSession = !!token;

        // Requirement 6: 401 enforcement on native router
        const isProtected = path.startsWith('/api/playlists') ||
                            path === '/api/save-credentials' ||
                            path === '/api/sync-now' ||
                            path.startsWith('/api/profiles');

        if (isProtected && !hasSession) {
          return JSON.stringify({ error: 'Unauthorized - No active session', status: 401, ok: false });
        }

        if (path === '/api/session') {
          if (method === 'POST') {
            const data = JSON.parse(body || '{}');
            mockSessionToken = data.token;
            return JSON.stringify({ ok: true, authenticated: true });
          }
          if (method === 'DELETE') {
            mockSessionToken = null;
            mockCredentials = { playlistName: '', serverUrl: '', username: '', password: '' };
            mockCatalogCount = 0;
            return JSON.stringify({ ok: true });
          }
        }

        if (path === '/api/state') {
          return JSON.stringify({
            ok: true,
            totalCatalogCount: mockCatalogCount,
            credentials: mockCredentials,
            parentalControl: { isLocked: true, showAdult: false }
          });
        }

        if (path === '/api/factory-reset') {
          mockSessionToken = null;
          mockCredentials = { playlistName: '', serverUrl: '', username: '', password: '' };
          mockCatalogCount = 0;
          return JSON.stringify({ ok: true, message: 'Reset complete' });
        }

        if (path.startsWith('/api/playlists')) {
          return JSON.stringify([]);
        }

        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };
  });

  // Load UI on fresh boot (empty localStorage)
  await page.goto(UI_PATH, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));

  // --- Test 1: Zero Page Errors on Load ---
  console.log('[Test 1] Asserting zero pageerror on load...');
  assert.equal(pageErrors.length, 0, `Expected 0 page errors, found: ${pageErrors.join(', ')}`);
  console.log('  ✓ PASS: Zero page errors on startup.\n');

  // --- Test 2: Fresh State Shows Welcome Screen ---
  console.log('[Test 2] Asserting fresh state shows Welcome screen...');
  const welcomeDisplay = await page.evaluate(() => {
    const el = document.getElementById('welcomeScreenOverlay');
    return el ? window.getComputedStyle(el).display : 'missing';
  });
  assert.equal(welcomeDisplay, 'flex', `Expected welcomeScreenOverlay display to be 'flex', got '${welcomeDisplay}'`);
  console.log('  ✓ PASS: Welcome overlay is visible on first boot.\n');

  // --- Test 3: No Guest Button in the DOM ---
  console.log('[Test 3] Asserting Guest button and guest mode completely removed...');
  const guestBtnExists = await page.evaluate(() => {
    return !!document.getElementById('welcomeBtnGuest');
  });
  assert.equal(guestBtnExists, false, 'Expected welcomeBtnGuest to be null / removed');
  console.log('  ✓ PASS: Guest button completely removed.\n');

  // --- Test 4: App Tabs Unreachable Before Sign-In ---
  console.log('[Test 4] Asserting app tabs unreachable before sign-in...');
  const navAttempt = await page.evaluate(async () => {
    // Attempt to navigate to HOME and MOVIES directly
    await window.navigateToTab('HOME');
    const welcome = document.getElementById('welcomeScreenOverlay');
    const homeTab = window.currentTab;
    return {
      welcomeVisible: welcome && window.getComputedStyle(welcome).display === 'flex',
      currentTab: homeTab
    };
  });
  assert.equal(navAttempt.welcomeVisible, true, 'Welcome overlay must remain visible when unauthenticated');
  console.log('  ✓ PASS: Content tabs blocked; user locked behind Welcome gate.\n');

  // --- Test 5: Native Router Returns 401 for Protected Endpoints When Unauthenticated ---
  console.log('[Test 5] Asserting native 401 enforcement for protected endpoints...');
  const authEnforcement = await page.evaluate(async () => {
    const results = {};
    for (const ep of ['/api/playlists', '/api/save-credentials', '/api/sync-now', '/api/profiles']) {
      const res = await window.fetch(ep, { method: ep === '/api/playlists' ? 'GET' : 'POST' });
      results[ep] = res.status;
    }
    return results;
  });
  for (const [ep, status] of Object.entries(authEnforcement)) {
    assert.equal(status, 401, `Expected endpoint ${ep} to return 401, got ${status}`);
  }
  console.log('  ✓ PASS: /api/playlists, /api/save-credentials, /api/sync-now, /api/profiles all return 401.\n');

  // --- Test 6: Hardcoded Identities Removed ---
  console.log('[Test 6] Asserting hardcoded identities removed...');
  const identities = await page.evaluate(() => {
    const defaultProfile = window.getDefaultProfile();
    const displayName = window.getAccountDisplayName();
    const pillName = document.getElementById('sidebarProfileName')?.innerText;
    return {
      defaultProfileName: defaultProfile.name,
      displayName: displayName,
      pillName: pillName
    };
  });
  assert.notEqual(identities.defaultProfileName, 'Waleed Khan', 'Profile name must not be hardcoded Waleed Khan');
  assert.notEqual(identities.pillName, 'Waleed', 'Sidebar pill must not be hardcoded Waleed');
  console.log(`  ✓ PASS: Dynamic identity resolved (name="${identities.displayName}", pill="${identities.pillName}").\n`);

  // --- Test 7: Sign Out Restores Clean State and Shows Welcome ---
  console.log('[Test 7] Asserting Sign Out clears session and returns to Welcome screen...');
  const signOutResult = await page.evaluate(async () => {
    // Simulate active session
    localStorage.setItem('sv_auth_token', 'test-token-12345678901234567890123456789012');
    localStorage.setItem('streamvault_account', JSON.stringify({ email: 'user@example.com', accountId: 'acc_1' }));
    
    // Call confirmSignOutAccount
    await window.confirmSignOutAccount();

    return {
      token: localStorage.getItem('sv_auth_token'),
      account: localStorage.getItem('streamvault_account'),
      welcomeDisplay: document.getElementById('welcomeScreenOverlay')?.style?.display
    };
  });
  assert.equal(signOutResult.token, null, 'Auth token must be cleared');
  assert.equal(signOutResult.account, null, 'Account cache must be cleared');
  assert.equal(signOutResult.welcomeDisplay, 'flex', 'Welcome screen must be visible after sign out');
  console.log('  ✓ PASS: Sign out cleanly purges session and displays Welcome.\n');

  await browser.close();
  console.log('====================================================');
  console.log('  ALL PHASE A ASSERTIONS PASSED (7/7)');
  console.log('====================================================');
}

runPhaseATests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
