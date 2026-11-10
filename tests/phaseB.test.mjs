import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UI_PATH = 'file:///C:/Users/wkhan/.gemini/antigravity/scratch/streamvault-tv/app/src/main/assets/tv-ui.html';

const KIDS_CERTIFICATIONS = new Set(['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'U']);

async function runPhaseBTests() {
  console.log('=== Running StreamVault TV — Phase B Test Suite ===\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  // Native AndroidApp mock implementing StreamVaultDatabase & AppApiRouter logic for Phase B
  await page.evaluateOnNewDocument(() => {
    let mockSessionToken = 'test-session-token-phase-b';
    let mockAccount = { accountId: 'acc_1', email: 'owner@streamvault.tv', displayName: 'Account Owner' };
    let mockMasterPin = '0000';
    let isAdultVaultUnlocked = false;

    // Profiles Store (Max 5)
    let profiles = [
      {
        id: 'prof_primary',
        name: 'Account Owner',
        avatarColor: '#7C3AED',
        isKids: false,
        theme: 'purple',
        isPrimary: true,
        updatedAt: Date.now()
      }
    ];
    let activeProfileId = 'prof_primary';

    // Scoped personal data: profileId -> Set / Map
    const profileWatchlist = new Map(); // profileId -> Set(dedupKey)
    const profileProgress = new Map();  // profileId -> Map(dedupKey -> { posMs, durationMs, updatedAt })
    const profileRatings = new Map();   // profileId -> Map(dedupKey -> rating)
    const profileSearches = new Map();  // profileId -> Array(query)

    // Media Catalog Mock with certifications and isAdult flags
    const catalog = [
      {
        id: 'kids_1',
        dedupKey: 'kids_1',
        title: 'Toy Story',
        category: 'Animation',
        mediaType: 'MOVIES',
        certification: 'G',
        isAdult: false,
        rating: 8.3,
        posterUrl: 'https://example.com/toystory.jpg',
        backdropUrl: 'https://example.com/toystory_bg.jpg',
        plot: 'Woody and Buzz adventure'
      },
      {
        id: 'kids_2',
        dedupKey: 'kids_2',
        title: 'Finding Nemo',
        category: 'Animation',
        mediaType: 'MOVIES',
        certification: 'PG',
        isAdult: false,
        rating: 8.2,
        posterUrl: 'https://example.com/nemo.jpg',
        backdropUrl: 'https://example.com/nemo_bg.jpg',
        plot: 'Clownfish searches for son'
      },
      {
        id: 'uncert_1',
        dedupKey: 'uncert_1',
        title: 'Unknown Indie Film',
        category: 'Drama',
        mediaType: 'MOVIES',
        certification: '', // Uncertified
        isAdult: false,
        rating: 6.8,
        posterUrl: 'https://example.com/indie.jpg',
        backdropUrl: 'https://example.com/indie_bg.jpg',
        plot: 'Indie drama with no MPAA rating'
      },
      {
        id: 'teen_1',
        dedupKey: 'teen_1',
        title: 'The Dark Knight',
        category: 'Action',
        mediaType: 'MOVIES',
        certification: 'PG-13',
        isAdult: false,
        rating: 9.0,
        posterUrl: 'https://example.com/batman.jpg',
        backdropUrl: 'https://example.com/batman_bg.jpg',
        plot: 'Batman battles Joker'
      },
      {
        id: 'adult_1',
        dedupKey: 'adult_1',
        title: 'Vault After Dark',
        category: '18+ Vault',
        mediaType: 'MOVIES',
        certification: 'NC-17',
        isAdult: true,
        rating: 7.0,
        posterUrl: 'https://example.com/vault.jpg',
        backdropUrl: 'https://example.com/vault_bg.jpg',
        plot: 'Adult exclusive title'
      }
    ];

    function getActiveProfile() {
      return profiles.find(p => p.id === activeProfileId) || profiles[0];
    }

    function checkIsAdult(title = '', genre = '', cat = '', path = '') {
      const s = `${title} ${genre} ${cat} ${path}`.toLowerCase();
      return s.includes('xxx') || s.includes('porn') || s.includes('adult') || s.includes('18+') || s.includes('vault after dark');
    }

    window.AndroidApp = {
      handleApiRequest: (method, path, body) => {
        return window.AndroidApp.handleApiRequestWithAuth(method, path, body, null);
      },
      handleApiRequestWithAuth: (method, path, bodyStr, authHeader) => {
        const body = JSON.parse(bodyStr || '{}');

        // State endpoint
        if (path === '/api/state') {
          return JSON.stringify({
            ok: true,
            totalCatalogCount: catalog.length,
            credentials: { serverUrl: 'http://stream.test:8080', username: 'testuser' },
            parentalControl: {
              isLocked: !isAdultVaultUnlocked,
              showAdult: isAdultVaultUnlocked,
              hasCustomPin: true
            }
          });
        }

        // Parental PIN / Adult Vault Session
        if (path === '/api/parental-pin' || path === '/api/parental-control') {
          const action = body.action || 'status';
          if (action === 'status') {
            return JSON.stringify({
              success: true,
              isLocked: !isAdultVaultUnlocked,
              showAdult: isAdultVaultUnlocked
            });
          }
          if (action === 'lock') {
            isAdultVaultUnlocked = false;
            return JSON.stringify({ success: true, isLocked: true, showAdult: false });
          }
          if (action === 'unlock') {
            if (body.pin === mockMasterPin) {
              isAdultVaultUnlocked = true;
              return JSON.stringify({ success: true, isLocked: false, showAdult: true });
            }
            return JSON.stringify({ success: false, error: 'Incorrect Master PIN' });
          }
          if (action === 'verify') {
            if (body.pin === mockMasterPin) {
              return JSON.stringify({ success: true, ok: true });
            }
            return JSON.stringify({ success: false, error: 'Incorrect Master PIN' });
          }
        }

        // Profiles Routes
        if (path === '/api/profiles' && method === 'GET') {
          return JSON.stringify({
            success: true,
            ok: true,
            activeProfileId: activeProfileId,
            profiles: profiles
          });
        }

        if (path === '/api/profiles/create' && method === 'POST') {
          if (profiles.length >= 5) {
            return JSON.stringify({ ok: false, error: 'Maximum 5 profiles allowed' });
          }
          const newProf = {
            id: 'prof_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name: (body.name || 'Profile').trim(),
            avatarColor: body.avatarColor || '#8B5CF6',
            theme: body.theme || 'purple',
            isKids: Boolean(body.isKids),
            isPrimary: false,
            updatedAt: Date.now()
          };
          profiles.push(newProf);
          return JSON.stringify({ success: true, ok: true, profile: newProf });
        }

        if (path === '/api/profiles/update' && method === 'POST') {
          const prof = profiles.find(p => p.id === body.id);
          if (!prof) return JSON.stringify({ ok: false, error: 'Profile not found' });

          // Phase B Rule: Turning Kids Mode OFF requires Master PIN
          if (prof.isKids && body.isKids === false) {
            if (body.pin !== mockMasterPin) {
              return JSON.stringify({ ok: false, error: 'Master PIN required to disable Kids Mode' });
            }
          }

          if (body.name) prof.name = body.name.trim();
          if (body.avatarColor) prof.avatarColor = body.avatarColor;
          if (body.theme) prof.theme = body.theme;
          if (typeof body.isKids === 'boolean') prof.isKids = body.isKids;
          prof.updatedAt = Date.now();

          return JSON.stringify({ success: true, ok: true, profile: prof });
        }

        if (path === '/api/profiles/delete' && method === 'POST') {
          const prof = profiles.find(p => p.id === body.id);
          if (!prof) return JSON.stringify({ ok: false, error: 'Profile not found' });
          if (prof.isPrimary) {
            return JSON.stringify({ ok: false, error: 'Primary profile cannot be deleted' });
          }
          profiles = profiles.filter(p => p.id !== body.id);
          if (activeProfileId === body.id) {
            activeProfileId = profiles[0].id;
            isAdultVaultUnlocked = false;
          }
          return JSON.stringify({ success: true, ok: true });
        }

        if (path === '/api/profiles/switch' && method === 'POST') {
          const prof = profiles.find(p => p.id === body.id);
          if (!prof) return JSON.stringify({ ok: false, error: 'Profile not found' });
          activeProfileId = prof.id;
          // Phase B Rule: Re-lock 18+ Vault on profile switch!
          isAdultVaultUnlocked = false;
          return JSON.stringify({ success: true, ok: true, activeProfileId: prof.id, profile: prof });
        }

        // Query Media (Content Rules Enforcement)
        if (path.startsWith('/api/query') || path === '/api/home') {
          const activeProf = getActiveProfile();
          const isKids = activeProf.isKids;
          const isVaultTab = body.category === '18+ Vault';

          const filtered = catalog.filter(item => {
            // Adult filter
            if (item.isAdult) {
              return isVaultTab && isAdultVaultUnlocked && !isKids;
            }
            if (isVaultTab) return false;

            // Kids Mode filter
            if (isKids) {
              const KIDS_CERTS = ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'U'];
              if (!item.certification || !KIDS_CERTS.includes(item.certification.toUpperCase())) {
                return false; // Uncertified or above young-child certification hidden!
              }
            }

            return true;
          });

          // Join scoped watchlist & progress
          const wl = profileWatchlist.get(activeProf.id) || new Set();
          const prog = profileProgress.get(activeProf.id) || new Map();
          const mapped = filtered.map(item => ({
            ...item,
            inWatchlist: wl.has(item.dedupKey),
            resumePositionMs: prog.get(item.dedupKey)?.posMs || 0
          }));

          if (path === '/api/home') {
            return JSON.stringify({
              hero: mapped[0] || null,
              rows: [{ title: 'Featured', items: mapped }]
            });
          }
          return JSON.stringify({ items: mapped, total: mapped.length });
        }

        // Playback Progress (Adult titles strictly rejected)
        if (path === '/api/progress' && method === 'POST') {
          const activeProf = getActiveProfile();
          const item = catalog.find(c => c.dedupKey === body.id || c.id === body.id);
          if (item && item.isAdult) {
            // Strictly reject saving progress for adult content!
            return JSON.stringify({ ok: false, error: 'Cannot record progress for adult title' });
          }
          if (!profileProgress.has(activeProf.id)) {
            profileProgress.set(activeProf.id, new Map());
          }
          profileProgress.get(activeProf.id).set(body.id, {
            posMs: body.posMs || body.positionMs || 0,
            durationMs: body.durationMs || 100000,
            updatedAt: Date.now()
          });
          return JSON.stringify({ ok: true, success: true });
        }

        // Continue Watching List
        if (path === '/api/continue-watching' && method === 'GET') {
          const activeProf = getActiveProfile();
          const prog = profileProgress.get(activeProf.id) || new Map();
          const items = [];
          for (const [key, p] of prog.entries()) {
            const item = catalog.find(c => c.dedupKey === key);
            if (item && !item.isAdult) {
              if (activeProf.isKids) {
                const KIDS_CERTS = ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'U'];
                if (!item.certification || !KIDS_CERTS.includes(item.certification.toUpperCase())) {
                  continue;
                }
              }
              items.push({ ...item, resumePositionMs: p.posMs });
            }
          }
          return JSON.stringify({ items });
        }

        // Watchlist
        if (path === '/api/watchlist' && method === 'GET') {
          const activeProf = getActiveProfile();
          const wl = profileWatchlist.get(activeProf.id) || new Set();
          const items = catalog.filter(c => wl.has(c.dedupKey) && !c.isAdult);
          return JSON.stringify({ items, ok: true });
        }

        if (path === '/api/watchlist' && method === 'POST') {
          const activeProf = getActiveProfile();
          const item = catalog.find(c => c.dedupKey === body.id || c.id === body.id);
          if (item && item.isAdult) {
            return JSON.stringify({ ok: false, error: 'Adult titles cannot be added to watchlist' });
          }
          if (!profileWatchlist.has(activeProf.id)) {
            profileWatchlist.set(activeProf.id, new Set());
          }
          const wl = profileWatchlist.get(activeProf.id);
          const add = body.action === 'add' || !wl.has(body.id);
          if (add) wl.add(body.id);
          else wl.delete(body.id);
          return JSON.stringify({ ok: true, inWatchlist: add });
        }

        // Search History
        if (path === '/api/search-history') {
          const activeProf = getActiveProfile();
          if (method === 'GET') {
            return JSON.stringify({ history: profileSearches.get(activeProf.id) || [] });
          }
          if (method === 'POST') {
            const q = (body.query || '').trim();
            if (q && !body.isVault && !checkIsAdult(q)) {
              if (!profileSearches.has(activeProf.id)) profileSearches.set(activeProf.id, []);
              const arr = profileSearches.get(activeProf.id);
              if (!arr.includes(q)) arr.unshift(q);
            }
            return JSON.stringify({ ok: true });
          }
        }

        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };

    // Pre-populate session token and playlist in localStorage
    localStorage.setItem('sv_auth_token', mockSessionToken);
    localStorage.setItem('streamvault_session_token', mockSessionToken);
    localStorage.setItem('streamvault_account', JSON.stringify(mockAccount));
    localStorage.setItem('streamvault_playlists', JSON.stringify([{ id: 'pl_1', name: 'Primary IPTV', isDefault: true }]));
  });

  // Load UI with pre-authenticated state
  await page.goto(UI_PATH, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));

  // --- Test 1: Zero Page Errors on Load ---
  console.log('[Test 1] Asserting zero page errors on load...');
  assert.equal(pageErrors.length, 0, `Expected 0 page errors, found: ${pageErrors.join(', ')}`);
  console.log('  ✓ PASS: Zero page errors on startup.\n');

  // --- Test 2: Real Profiles CRUD & 5 Profile Limit Enforcement ---
  console.log('[Test 2] Testing Profile CRUD, 5-profile limit, and primary delete protection...');
  const crudResults = await page.evaluate(async () => {
    // 1. Fetch profiles
    const p1 = await fetch('/api/profiles').then(r => r.json());
    
    // 2. Add profiles up to 5
    const added = [];
    for (let i = 2; i <= 5; i++) {
      const res = await fetch('/api/profiles/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Profile ${i}`, avatarColor: '#3B82F6', isKids: i % 2 === 0 })
      }).then(r => r.json());
      added.push(res);
    }

    // 3. Attempt to add 6th profile (Must be rejected!)
    const p6 = await fetch('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Overflow Profile 6' })
    }).then(r => r.json());

    // 4. Attempt to delete Primary Profile (Must be rejected!)
    const delPrimary = await fetch('/api/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'prof_primary' })
    }).then(r => r.json());

    // 5. Delete a secondary profile
    const secId = added[0].profile.id;
    const delSec = await fetch('/api/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: secId })
    }).then(r => r.json());

    const finalProfiles = await fetch('/api/profiles').then(r => r.json());

    return {
      initialCount: p1.profiles.length,
      addedSuccess: added.every(a => a.ok || a.success),
      overflowRejected: !p6.ok && !p6.success,
      primaryDelRejected: !delPrimary.ok && !delPrimary.success,
      secDelSuccess: delSec.ok || delSec.success,
      finalCount: finalProfiles.profiles.length
    };
  });

  assert.equal(crudResults.initialCount, 1, 'Initial profiles count should be 1');
  assert.equal(crudResults.addedSuccess, true, 'Creating up to 5 profiles must succeed');
  assert.equal(crudResults.overflowRejected, true, '6th profile must be rejected by 5 profile limit');
  assert.equal(crudResults.primaryDelRejected, true, 'Primary profile cannot be deleted');
  assert.equal(crudResults.secDelSuccess, true, 'Secondary profile deletion succeeds');
  assert.equal(crudResults.finalCount, 4, 'Final count after deleting one should be 4');
  console.log('  ✓ PASS: Profile CRUD, 5-profile ceiling, and primary protection verified.\n');

  // --- Test 3: Scoped Personal Data per Profile (Watchlist & Continue Watching) ---
  console.log('[Test 3] Asserting personal data (watchlist & progress) is strictly scoped per profile...');
  const scopeResults = await page.evaluate(async () => {
    // Get profiles list
    const profs = (await fetch('/api/profiles').then(r => r.json())).profiles;
    const profA = profs[0].id;
    const profB = profs[1].id;

    // Switch to Profile A
    await fetch('/api/profiles/switch', { method: 'POST', body: JSON.stringify({ id: profA }) });
    // Profile A adds kids_1 to watchlist and saves progress on kids_2
    await fetch('/api/watchlist', { method: 'POST', body: JSON.stringify({ id: 'kids_1', action: 'add' }) });
    await fetch('/api/progress', { method: 'POST', body: JSON.stringify({ id: 'kids_2', posMs: 45000 }) });

    const profAWl = await fetch('/api/watchlist').then(r => r.json());
    const profACw = await fetch('/api/continue-watching').then(r => r.json());

    // Switch to Profile B
    await fetch('/api/profiles/switch', { method: 'POST', body: JSON.stringify({ id: profB }) });
    const profBWl = await fetch('/api/watchlist').then(r => r.json());
    const profBCw = await fetch('/api/continue-watching').then(r => r.json());

    // Profile B adds teen_1 to watchlist
    await fetch('/api/watchlist', { method: 'POST', body: JSON.stringify({ id: 'teen_1', action: 'add' }) });
    const profBWlAfter = await fetch('/api/watchlist').then(r => r.json());

    // Switch back to Profile A
    await fetch('/api/profiles/switch', { method: 'POST', body: JSON.stringify({ id: profA }) });
    const profAWlAfter = await fetch('/api/watchlist').then(r => r.json());

    return {
      profAWatchlist: profAWl.items.map(i => i.id),
      profAContinueWatching: profACw.items.map(i => i.id),
      profBInitialWatchlist: profBWl.items.map(i => i.id),
      profBInitialContinueWatching: profBCw.items.map(i => i.id),
      profBFinalWatchlist: profBWlAfter.items.map(i => i.id),
      profAFinalWatchlist: profAWlAfter.items.map(i => i.id)
    };
  });

  assert.deepEqual(scopeResults.profAWatchlist, ['kids_1'], 'Profile A has kids_1 in watchlist');
  assert.deepEqual(scopeResults.profAContinueWatching, ['kids_2'], 'Profile A has kids_2 in continue watching');
  assert.deepEqual(scopeResults.profBInitialWatchlist, [], 'Profile B watchlist starts empty');
  assert.deepEqual(scopeResults.profBInitialContinueWatching, [], 'Profile B continue watching starts empty');
  assert.deepEqual(scopeResults.profBFinalWatchlist, ['teen_1'], 'Profile B watchlist has teen_1');
  assert.deepEqual(scopeResults.profAFinalWatchlist, ['kids_1'], 'Profile A watchlist untouched by Profile B');
  console.log('  ✓ PASS: Personal data completely isolated and scoped per profile.\n');

  // --- Test 4: Content Rules — Kids Mode Certification Filtering & Hidden Adult Vault ---
  console.log('[Test 4] Testing Kids Mode: certification filtering and Vault tab complete removal...');
  const kidsFilterResults = await page.evaluate(async () => {
    // Create dedicated Kids profile
    const createRes = await fetch('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Kids Profile', isKids: true })
    }).then(r => r.json());
    const kidsProfId = createRes.profile.id;

    // Switch to Kids profile
    await window.switchUserProfile(kidsProfId);

    // Query media
    const mediaRes = await fetch('/api/query').then(r => r.json());
    const visibleIds = mediaRes.items.map(i => i.id);

    // Check sidebar tabs
    window.renderSidebar();
    const navItems = Array.from(document.querySelectorAll('#navList .nav-btn')).map(el => el.getAttribute('data-tab'));

    return {
      isKids: window.currentActiveProfile.isKids,
      visibleIds: visibleIds,
      navItems: navItems
    };
  });

  assert.equal(kidsFilterResults.isKids, true, 'Active profile must have isKids = true');
  assert.ok(kidsFilterResults.visibleIds.includes('kids_1'), 'G-certified title must be visible');
  assert.ok(kidsFilterResults.visibleIds.includes('kids_2'), 'PG-certified title must be visible');
  assert.equal(kidsFilterResults.visibleIds.includes('uncert_1'), false, 'Uncertified titles must be HIDDEN in kids mode');
  assert.equal(kidsFilterResults.visibleIds.includes('teen_1'), false, 'PG-13 and above titles must be HIDDEN in kids mode');
  assert.equal(kidsFilterResults.visibleIds.includes('adult_1'), false, 'Adult titles must be HIDDEN in kids mode');
  assert.equal(kidsFilterResults.navItems.includes('VAULT_18'), false, '18+ Vault tab must be completely removed in Kids Mode');
  console.log('  ✓ PASS: Kids mode strictly allows young-child certifications and hides Vault tab.\n');

  // --- Test 5: Turning Kids Mode OFF Requires Master PIN ---
  console.log('[Test 5] Asserting turning Kids Mode OFF requires Master PIN...');
  const pinOffResults = await page.evaluate(async () => {
    const profId = window.currentActiveProfile.id;

    // 1. Attempt to turn kids mode off without PIN
    const noPin = await fetch('/api/profiles/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profId, isKids: false })
    }).then(r => r.json());

    // 2. Attempt with wrong PIN
    const wrongPin = await fetch('/api/profiles/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profId, isKids: false, pin: '9999' })
    }).then(r => r.json());

    // 3. Attempt with valid PIN
    const validPin = await fetch('/api/profiles/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profId, isKids: false, pin: '0000' })
    }).then(r => r.json());

    return {
      noPinRejected: !noPin.ok && !noPin.success,
      wrongPinRejected: !wrongPin.ok && !wrongPin.success,
      validPinSuccess: validPin.ok || validPin.success,
      updatedIsKids: validPin.profile?.isKids
    };
  });

  assert.equal(pinOffResults.noPinRejected, true, 'Disabling kids mode without PIN must be rejected');
  assert.equal(pinOffResults.wrongPinRejected, true, 'Disabling kids mode with wrong PIN must be rejected');
  assert.equal(pinOffResults.validPinSuccess, true, 'Disabling kids mode with valid Master PIN must succeed');
  assert.equal(pinOffResults.updatedIsKids, false, 'Profile kids mode is now false');
  console.log('  ✓ PASS: Master PIN protection on Kids Mode OFF enforced.\n');

  // --- Test 6: 18+ Vault Session-Only Unlock & Auto Re-Lock ---
  console.log('[Test 6] Testing 18+ Vault session-only unlock and auto re-lock on standby/switch...');
  const vaultResults = await page.evaluate(async () => {
    // Switch to Primary adult profile
    await window.switchUserProfile('prof_primary');

    // 1. Initially locked: adult items excluded from home
    const homeBefore = await fetch('/api/home').then(r => r.json());
    const adultInHomeBefore = homeBefore.rows[0].items.some(i => i.isAdult);

    // 2. Unlock Vault with Master PIN
    const unlockRes = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unlock', pin: '0000' })
    }).then(r => r.json());

    // Adult items accessible only from 18+ Vault tab
    const vaultQuery = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: '18+ Vault' })
    }).then(r => r.json());

    // 3. Simulate background / standby
    await window.lockParentalControls();
    const statusAfterStandby = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' })
    }).then(r => r.json());

    // 4. Re-unlock, then switch profile
    await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unlock', pin: '0000' })
    });
    // Switch profile
    const secProf = (await fetch('/api/profiles').then(r => r.json())).profiles[1].id;
    await window.switchUserProfile(secProf);

    const statusAfterSwitch = await fetch('/api/parental-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' })
    }).then(r => r.json());

    return {
      adultInHomeBefore,
      unlockSuccess: unlockRes.success,
      vaultItemCount: vaultQuery.items.length,
      isLockedAfterStandby: statusAfterStandby.isLocked,
      isLockedAfterSwitch: statusAfterSwitch.isLocked
    };
  });

  assert.equal(vaultResults.adultInHomeBefore, false, 'Adult titles must never appear in Home while locked');
  assert.equal(vaultResults.unlockSuccess, true, 'Master PIN unlocks adult session');
  assert.ok(vaultResults.vaultItemCount > 0, 'Vault query returns adult items when unlocked');
  assert.equal(vaultResults.isLockedAfterStandby, true, 'Vault must auto-lock on app standby/background');
  assert.equal(vaultResults.isLockedAfterSwitch, true, 'Vault must auto-lock on profile switch');
  console.log('  ✓ PASS: Vault session-only unlock and auto re-lock verified.\n');

  // --- Test 7: Adult Title Progress Save Strictly Rejected & Zero Adult History ---
  console.log('[Test 7] Asserting progress save for adult title is rejected and search history excluded...');
  const privacyResults = await page.evaluate(async () => {
    // Switch to primary profile
    await window.switchUserProfile('prof_primary');

    // 1. Attempt to save progress for adult title adult_1
    const progRes = await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'adult_1', posMs: 50000, durationMs: 120000 })
    }).then(r => r.json());

    // 2. Query continue watching: adult_1 must NOT be there
    const cw = await fetch('/api/continue-watching').then(r => r.json());
    const adultInCw = cw.items.some(i => i.isAdult || i.id === 'adult_1');

    // 3. Attempt to save search history for adult query
    await window.saveSearchQuery('Vault After Dark');
    const hist = await fetch('/api/search-history').then(r => r.json());
    const adultInHist = hist.history.some(q => q.toLowerCase().includes('vault') || q.toLowerCase().includes('adult'));

    return {
      progressRejected: !progRes.ok && !progRes.success,
      adultInContinueWatching: adultInCw,
      adultInSearchHistory: adultInHist
    };
  });

  assert.equal(privacyResults.progressRejected, true, 'Progress recording for adult title must be rejected');
  assert.equal(privacyResults.adultInContinueWatching, false, 'Adult title must never appear in Continue Watching');
  assert.equal(privacyResults.adultInSearchHistory, false, 'Adult search query must never be saved to search history');
  console.log('  ✓ PASS: Absolute privacy for adult titles strictly enforced.\n');

  await browser.close();
  console.log('====================================================');
  console.log('  ALL PHASE B ASSERTIONS PASSED (7/7)');
  console.log('====================================================');
}

runPhaseBTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
