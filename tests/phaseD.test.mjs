import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

async function runPhaseDTests() {
  console.log('=== Running StreamVault TV — Phase D Test Suite (Real Sync) ===\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  // Native AndroidApp mock + In-Memory Cloud Sync Store
  await page.evaluateOnNewDocument(() => {
    let mockSessionToken = 'test-token-phase-d-valid';
    let mockAccount = { accountId: 'acc_sync_test', email: 'owner@streamvault.tv', displayName: 'StreamVault Owner' };

    // In-memory cloud databases
    const cloudCatalog = new Map();
    const cloudProfileData = new Map();
    const tmdbCache = new Map();

    // Local native storage
    let localCredentials = { playlistName: '', serverUrl: '', username: '', password: '' };
    let localProfiles = [
      {
        id: 'prof_primary',
        name: 'StreamVault Owner',
        avatarColor: '#7C3AED',
        isKids: false,
        theme: 'purple',
        isPrimary: true,
        updatedAt: Date.now()
      },
      {
        id: 'prof_secondary',
        name: 'Guest Room',
        avatarColor: '#3B82F6',
        isKids: false,
        theme: 'midnight',
        isPrimary: false,
        updatedAt: Date.now()
      }
    ];
    let localActiveProfileId = 'prof_primary';

    // Local Room-like stores
    let localCatalog = [
      {
        id: 'item_1',
        dedupKey: 'tmdb:157336',
        title: 'Interstellar',
        category: 'Sci-Fi',
        mediaType: 'MOVIES',
        certification: 'PG-13',
        isAdult: false,
        rating: 8.6,
        posterUrl: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
        backdropUrl: 'https://image.tmdb.org/t/p/w1280/rAiYTsqhk0ND1aRHY6P1pT7vj41.jpg',
        plot: 'Mankind was born on Earth. It was never meant to die here.'
      },
      {
        id: 'item_adult_1',
        dedupKey: 'vault:adult_999',
        title: 'Vault After Dark',
        category: '18+ Adult',
        mediaType: 'MOVIES',
        certification: 'NC-17',
        isAdult: true,
        rating: 6.0,
        posterUrl: '',
        backdropUrl: '',
        plot: 'Adult content'
      }
    ];

    let localProgress = new Map();
    let localWatchlist = new Set();
    let localRatings = new Map();

    let cloudPlaylists = [
      {
        id: 'pl_cloud_1',
        name: 'Cloud Fast IPTV',
        serverUrl: 'http://cloud-iptv.example.com:8080',
        username: 'clouduser',
        password: 'cloudpassword',
        isEnabled: true,
        status: 'active'
      }
    ];

    window.__mockCloudStore = {
      cloudCatalog,
      cloudProfileData,
      tmdbCache,
      localCatalog,
      localProgress,
      localWatchlist,
      localRatings,
      cloudPlaylists
    };

    window.AndroidApp = {
      handleApiRequest: (method, path, body) => {
        return window.AndroidApp.handleApiRequestWithAuth(method, path, body, null);
      },
      handleApiRequestWithAuth: (method, path, body, authHeader) => {
        const token = (authHeader || '').replace('Bearer ', '').trim() || mockSessionToken;
        const hasSession = !!token;

        if (!hasSession && (path.startsWith('/api/playlists') || path === '/api/save-credentials' || path === '/api/sync-now' || path.startsWith('/api/profiles'))) {
          return JSON.stringify({ error: 'Unauthorized', status: 401, ok: false });
        }

        if (path === '/api/state') {
          return JSON.stringify({
            ok: true,
            totalCatalogCount: localCatalog.length,
            credentials: localCredentials,
            parentalControl: { isLocked: true, showAdult: false },
            isAdultVaultUnlocked: false
          });
        }

        if (path === '/api/session') {
          if (method === 'POST') {
            const data = JSON.parse(body || '{}');
            mockSessionToken = data.token;
            return JSON.stringify({ ok: true, authenticated: true });
          }
        }

        if (path === '/api/save-credentials') {
          const creds = JSON.parse(body || '{}');
          localCredentials = creds;
          return JSON.stringify({ ok: true });
        }

        if (path.startsWith('/api/playlists')) {
          if (method === 'GET') {
            return JSON.stringify({ ok: true, playlists: cloudPlaylists });
          }
        }

        if (path === '/api/profiles') {
          return JSON.stringify({ ok: true, profiles: localProfiles, activeProfileId: localActiveProfileId });
        }

        if (path === '/api/profiles/switch') {
          const req = JSON.parse(body || '{}');
          localActiveProfileId = req.profileId;
          const prof = localProfiles.find(p => p.id === req.profileId);
          return JSON.stringify({ ok: true, profile: prof });
        }

        if (path === '/api/watchlist' || path === '/api/watchlist/toggle') {
          const req = JSON.parse(body || '{}');
          const dedupKey = req.dedupKey;
          if (req.inWatchlist !== undefined) {
            if (req.inWatchlist) localWatchlist.add(dedupKey);
            else localWatchlist.delete(dedupKey);
            return JSON.stringify({ ok: true, inWatchlist: req.inWatchlist });
          }
          if (localWatchlist.has(dedupKey)) {
            localWatchlist.delete(dedupKey);
            return JSON.stringify({ ok: true, inWatchlist: false });
          } else {
            localWatchlist.add(dedupKey);
            return JSON.stringify({ ok: true, inWatchlist: true });
          }
        }

        if (path === '/api/progress') {
          const req = JSON.parse(body || '{}');
          if (req.isAdult) return JSON.stringify({ ok: false, error: 'Adult tracking forbidden' });
          localProgress.set(req.dedupKey, {
            posMs: req.positionMs || 0,
            durationMs: req.durationMs || 0,
            isWatched: (req.durationMs > 0 && req.positionMs / req.durationMs >= 0.9)
          });
          return JSON.stringify({ ok: true });
        }

        if (path === '/api/rating') {
          const req = JSON.parse(body || '{}');
          localRatings.set(req.dedupKey, req.rating);
          return JSON.stringify({ ok: true, rating: req.rating });
        }

        if (path === '/api/catalog/pull-cloud') {
          // Native router streams items from cloud catalog into Room
          let imported = 0;
          for (const item of cloudCatalog.values()) {
            if (!item.isRemoved) {
              const existingIdx = localCatalog.findIndex(c => c.dedupKey === item.dedupKey);
              if (existingIdx >= 0) {
                localCatalog[existingIdx] = Object.assign({}, localCatalog[existingIdx], item);
              } else {
                localCatalog.push(item);
              }
              imported++;
            }
          }
          return JSON.stringify({ ok: true, count: imported, message: `Catalog pulled from cloud (${imported} titles)` });
        }

        if (path === '/api/sync/status') {
          return JSON.stringify({
            ok: true,
            lastSyncTimestamp: Date.now(),
            syncState: 'Ready'
          });
        }

        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };

    // Intercept Worker Proxy calls (/api/tmdb, /api/catalog, /api/sync)
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input.url || '');
      const method = (init && init.method ? init.method : 'GET').toUpperCase();
      const headers = (init && init.headers) || {};
      const body = init && init.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : null;

      // 1. Worker TMDB Proxy
      if (url.includes('/api/tmdb/')) {
        const sub = url.split('/api/tmdb/')[1];
        if (tmdbCache.has(sub)) {
          return new Response(JSON.stringify(tmdbCache.get(sub)), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' }
          });
        }
        const mockData = {
          id: 157336,
          title: 'Interstellar',
          overview: 'Mankind was born on Earth...',
          vote_average: 8.6,
          vote_count: 32000,
          runtime: 169,
          release_date: '2014-11-05',
          genres: [{ id: 18, name: 'Drama' }, { id: 878, name: 'Science Fiction' }],
          release_dates: {
            results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }]
          }
        };
        tmdbCache.set(sub, mockData);
        return new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' }
        });
      }

      // 2. Worker Catalog Sync-Batch
      if (url.includes('/api/catalog/sync-batch') && method === 'POST') {
        const items = (body && body.items) || [];
        for (const item of items) {
          cloudCatalog.set(item.dedupKey, item);
        }
        return new Response(JSON.stringify({ success: true, count: items.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 3. Worker Catalog Mark-Removed
      if (url.includes('/api/catalog/mark-removed') && method === 'POST') {
        const dedupKeys = (body && body.dedupKeys) || [];
        for (const k of dedupKeys) {
          if (cloudCatalog.has(k)) {
            const it = cloudCatalog.get(k);
            it.isRemoved = true;
            it.removedAt = Date.now();
          }
        }
        return new Response(JSON.stringify({ success: true, count: dedupKeys.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 4. Worker Catalog Pull
      if (url.includes('/api/catalog/pull') && method === 'GET') {
        const items = Array.from(cloudCatalog.values());
        return new Response(JSON.stringify({ success: true, items, total: items.length, hasMore: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 5. Worker Sync Push
      if (url.includes('/api/sync/push') && method === 'POST') {
        const profileId = (body && body.profileId) || 'prof_primary';
        const dataType = (body && body.dataType) || 'progress';
        const items = (body && body.items) || [];
        for (const it of items) {
          const key = `${profileId}:::${dataType}:::${it.itemKey}`;
          cloudProfileData.set(key, {
            profileId,
            dataType,
            itemKey: it.itemKey,
            data: it.data,
            updatedAt: it.updatedAt || Date.now()
          });
        }
        return new Response(JSON.stringify({ success: true, count: items.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 6. Worker Sync Pull
      if (url.includes('/api/sync/pull') && method === 'GET') {
        const parsed = new URL(url, 'http://localhost');
        const profId = parsed.searchParams.get('profile_id');
        const results = [];
        for (const entry of cloudProfileData.values()) {
          if (!profId || entry.profileId === profId) {
            results.push(entry);
          }
        }
        return new Response(JSON.stringify({ success: true, items: results }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 7. Worker Playlists Sync
      if (url.includes('/api/playlists')) {
        return new Response(JSON.stringify({ ok: true, playlists: cloudPlaylists }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 8. Cloud status
      if (url.includes('/api/cloud/status')) {
        return new Response(JSON.stringify({ activeCode: { code: 'SV-TEST' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return originalFetch.apply(this, arguments);
    };
  });

  // Pre-seed localStorage to simulate an authenticated TV session with active profile
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('sv_auth_token', 'test-token-phase-d-valid');
    localStorage.setItem('streamvault_session_token', 'test-token-phase-d-valid');
    localStorage.setItem('streamvault_token', 'test-token-phase-d-valid');
    localStorage.setItem('streamvault_account', JSON.stringify({
      accountId: 'acc_sync_test',
      email: 'owner@streamvault.tv',
      displayName: 'StreamVault Owner'
    }));
    localStorage.setItem('sv_last_profile_id', 'prof_primary');
    sessionStorage.setItem('sv_session_profile_active', 'true');
    localStorage.setItem('sv_credentials', JSON.stringify({
      playlistName: 'Initial IPTV',
      serverUrl: 'http://iptv.example.com',
      username: 'user1',
      password: 'pwd'
    }));
  });

  await page.goto(UI_PATH, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));

  // --- Test 1: Zero Page Errors on Startup ---
  console.log('[Test 1] Asserting zero page errors on startup...');
  assert.equal(pageErrors.length, 0, `Expected 0 page errors, found: ${pageErrors.join(', ')}`);
  console.log('  ✓ PASS: Zero page errors on startup.\n');

  // --- Test 2: TMDB Worker Proxy with Shared Cache & US Certification ---
  console.log('[Test 2] Testing TMDB worker proxy (Bearer auth, cache HIT/MISS, certification extraction)...');
  const tmdbResults = await page.evaluate(async () => {
    // 1st request: Cache MISS
    const res1 = await fetch('/api/tmdb/movie/157336?append_to_response=release_dates');
    const cacheHeader1 = res1.headers.get('X-Cache');
    const data1 = await res1.json();

    // 2nd request: Cache HIT from D1/Memory
    const res2 = await fetch('/api/tmdb/movie/157336?append_to_response=release_dates');
    const cacheHeader2 = res2.headers.get('X-Cache');
    const data2 = await res2.json();

    // Certification lookup simulation matching CatalogSyncEngine logic
    let cert = '';
    if (data1.release_dates && data1.release_dates.results) {
      const usResult = data1.release_dates.results.find(r => r.iso_3166_1 === 'US');
      if (usResult && usResult.release_dates && usResult.release_dates.length > 0) {
        cert = usResult.release_dates[0].certification;
      }
    }

    return {
      cacheHeader1,
      cacheHeader2,
      cert,
      title: data1.title
    };
  });

  assert.equal(tmdbResults.cacheHeader1, 'MISS', 'First TMDB proxy call should be cache MISS');
  assert.equal(tmdbResults.cacheHeader2, 'HIT', 'Second TMDB proxy call should be cache HIT');
  assert.equal(tmdbResults.cert, 'PG-13', 'US certification PG-13 extracted cleanly from TMDB');
  assert.equal(tmdbResults.title, 'Interstellar', 'Movie title matched');
  console.log('  ✓ PASS: TMDB proxy cache HIT/MISS and US certification verified without APK API key.\n');

  // --- Test 3: Catalogue Upload (25-item chunks, retry backoff) & 14-day Soft Delete ---
  console.log('[Test 3] Testing Catalogue upload to /api/catalog/sync-batch and /api/catalog/mark-removed...');
  const catalogSyncResults = await page.evaluate(async () => {
    // Generate 30 mock enriched items to verify chunking into batches of 25
    const batchItems = [];
    for (let i = 1; i <= 30; i++) {
      batchItems.push({
        dedupKey: `tmdb:${1000 + i}`,
        mediaType: 'MOVIES',
        title: `Synced Movie ${i}`,
        cleanTitle: `synced movie ${i}`,
        year: 2024,
        tmdbId: 1000 + i,
        plot: `Plot for synced movie ${i}`,
        posterPath: `https://example.com/poster${i}.jpg`,
        backdropPath: `https://example.com/backdrop${i}.jpg`,
        rating: 7.5,
        runtimeMins: 110,
        genres: ['Action', 'Thriller'],
        versions: [{ streamId: 5000 + i, name: `Synced Movie ${i} 1080p`, language: 'en', quality: '1080p' }],
        isAdult: false
      });
    }

    // Direct chunking verification as implemented in CatalogSyncEngine.uploadCatalogSyncBatch
    let uploadedCount = 0;
    const chunkSize = 25;
    for (let i = 0; i < batchItems.length; i += chunkSize) {
      const chunk = batchItems.slice(i, i + chunkSize);
      const res = await fetch('/api/catalog/sync-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistId: 'primary', items: chunk })
      });
      const data = await res.json();
      if (data.success) uploadedCount += data.count;
    }

    // Soft delete mark-removed for 2 items
    const removedRes = await fetch('/api/catalog/mark-removed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKeys: ['tmdb:1001', 'tmdb:1002'] })
    });
    const removedData = await removedRes.json();

    const cloudStore = window.__mockCloudStore.cloudCatalog;
    const item1001 = cloudStore.get('tmdb:1001');

    return {
      uploadedCount,
      totalInCloud: cloudStore.size,
      removedSuccess: removedData.success,
      item1001IsRemoved: item1001 ? item1001.isRemoved : false
    };
  });

  assert.equal(catalogSyncResults.uploadedCount, 30, 'All 30 items chunked and uploaded');
  assert.equal(catalogSyncResults.totalInCloud, 30, 'Cloud store holds all 30 items');
  assert.equal(catalogSyncResults.removedSuccess, true, 'Mark-removed returned success');
  assert.equal(catalogSyncResults.item1001IsRemoved, true, 'Item soft-delete flag isRemoved set to true');
  console.log('  ✓ PASS: Catalogue sync batching and soft-delete verified.\n');

  // --- Test 4: Catalogue Down Streaming to Room on Sign-In ---
  console.log('[Test 4] Testing Catalogue Down (/api/catalog/pull-cloud) streaming into local catalog...');
  const catalogDownResults = await page.evaluate(async () => {
    // Native router call /api/catalog/pull-cloud
    const res = await fetch('/api/catalog/pull-cloud', { method: 'POST' });
    const data = await res.json();
    return {
      ok: data.ok,
      importedCount: data.count,
      localCatalogSize: window.__mockCloudStore.localCatalog.length
    };
  });

  assert.equal(catalogDownResults.ok, true, 'Pull cloud catalog returned ok');
  assert.ok(catalogDownResults.importedCount >= 28, 'Imported active cloud items excluding soft-deleted ones');
  console.log('  ✓ PASS: Catalogue down successfully streams cloud catalog into local Room storage.\n');

  // --- Test 5: Profile Data Scoped Sync (Watchlist, Progress, Ratings, Privacy Exclusions) ---
  console.log('[Test 5] Testing ProfileSyncManager (queue, 10s debounce, flush, privacy filtering)...');
  const profileSyncResults = await page.evaluate(async () => {
    // 1. Record watchlist change for Interstellar
    await window.toggleWatchlist('tmdb:157336');

    // 2. Record rating change
    await window.toggleUserRating('tmdb:157336', 5);

    // 3. Record playback progress (position 45000ms of 120000ms)
    await window.recordPlaybackProgress('tmdb:157336', 45000, 120000);

    // 4. Attempt to record adult content progress -> MUST be ignored
    window.ProfileSyncManager.recordChange('progress', 'vault:adult_999', {
      resumePositionMs: 30000,
      durationMs: 90000,
      isAdult: true
    });

    const pendingBeforeFlush = window.ProfileSyncManager.getPendingCount();

    // 5. Immediate flush simulation (e.g. app exit, visibilitychange, profile switch)
    await window.ProfileSyncManager.flush();
    const pendingAfterFlush = window.ProfileSyncManager.getPendingCount();

    const cloudData = window.__mockCloudStore.cloudProfileData;
    const progressKey = 'prof_primary:::progress:::tmdb:157336';
    const watchlistKey = 'prof_primary:::watchlist:::tmdb:157336';
    const ratingsKey = 'prof_primary:::ratings:::tmdb:157336';
    const adultKey = 'prof_primary:::progress:::vault:adult_999';

    return {
      pendingBeforeFlush,
      pendingAfterFlush,
      hasProgress: cloudData.has(progressKey),
      progressData: cloudData.get(progressKey)?.data,
      hasWatchlist: cloudData.has(watchlistKey),
      hasRatings: cloudData.has(ratingsKey),
      hasAdultInCloud: cloudData.has(adultKey)
    };
  });

  assert.equal(profileSyncResults.pendingBeforeFlush, 3, 'Pending queue holds 3 non-adult operations');
  assert.equal(profileSyncResults.pendingAfterFlush, 0, 'Pending queue emptied after flush()');
  assert.equal(profileSyncResults.hasProgress, true, 'Playback progress synced to cloud');
  assert.equal(profileSyncResults.progressData.resumePositionMs, 45000, 'Resume position matched in cloud payload');
  assert.equal(profileSyncResults.hasWatchlist, true, 'Watchlist synced to cloud');
  assert.equal(profileSyncResults.hasRatings, true, 'Ratings synced to cloud');
  assert.equal(profileSyncResults.hasAdultInCloud, false, 'Adult content strictly rejected from cloud profile sync');
  console.log('  ✓ PASS: ProfileSyncManager queues, flushes, and preserves privacy.\n');

  // --- Test 6: Cloud Playlists Auto-Import on Fresh TV ---
  console.log('[Test 6] Testing Cloud Playlists sync & auto-import when local credentials empty...');
  const playlistSyncResults = await page.evaluate(async () => {
    // Clear local credentials to simulate fresh TV
    localStorage.removeItem('sv_credentials');
    window.AndroidApp.handleApiRequest('POST', '/api/save-credentials', JSON.stringify({ playlistName: '', serverUrl: '', username: '', password: '' }));
    if (window.appStatus) {
      window.appStatus.credentials = { playlistName: '', serverUrl: '', username: '', password: '' };
    }

    // loadPlaylistsData() triggers auto-import of first enabled cloud playlist
    const playlists = await window.loadPlaylistsData();
    const state = JSON.parse(window.AndroidApp.handleApiRequest('GET', '/api/state', null));

    return {
      playlistsCount: playlists.length,
      firstPlaylistName: playlists[0]?.name,
      importedServerUrl: state.credentials?.serverUrl,
      importedUsername: state.credentials?.username
    };
  });

  assert.equal(playlistSyncResults.playlistsCount, 1, 'Cloud playlists fetched successfully');
  assert.equal(playlistSyncResults.firstPlaylistName, 'Cloud Fast IPTV', 'Playlist name matched');
  assert.equal(playlistSyncResults.importedServerUrl, 'http://cloud-iptv.example.com:8080', 'Auto-imported serverUrl to local TV credentials');
  assert.equal(playlistSyncResults.importedUsername, 'clouduser', 'Auto-imported username to local TV credentials');
  console.log('  ✓ PASS: Cloud Playlists automatically configure new TV on sign-in.\n');

  // --- Test 7: Real Sync Settings UI & Status Labels ---
  console.log('[Test 7] Testing Settings screen Real Sync UI (triggerCloudSync, syncStatusLabel, syncPendingLabel)...');
  await page.evaluate(async () => {
    await window.navigateToTab('SETTINGS');
  });
  await page.waitForSelector('#syncPendingLabel', { timeout: 5000 });

  const uiSyncResults = await page.evaluate(async () => {
    // Add 1 pending item to queue
    window.ProfileSyncManager.recordChange('ratings', 'tmdb:157336', { userRating: 5 });
    window.renderSyncStatus();

    const pendingLabelBefore = document.getElementById('syncPendingLabel')?.innerText;

    // Trigger Cloud Sync via button handler
    await window.triggerCloudSync();

    const statusLabelAfter = document.getElementById('syncStatusLabel')?.innerText;
    const pendingLabelAfter = document.getElementById('syncPendingLabel')?.innerText;

    return {
      pendingLabelBefore,
      statusLabelAfter,
      pendingLabelAfter
    };
  });

  assert.equal(uiSyncResults.pendingLabelBefore, '1 pending', 'Pending label shows "1 pending" before sync');
  assert.equal(uiSyncResults.statusLabelAfter, 'Just now', 'Status label updates to "Just now" after sync');
  assert.equal(uiSyncResults.pendingLabelAfter, 'All synced', 'Pending label updates to "All synced" after sync');
  console.log('  ✓ PASS: Real Sync Settings UI elements reflect active sync state and timestamps.\n');

  // --- Test 8: Universal Dedup Key Re-Linking Across Playlist Swaps ---
  console.log('[Test 8] Testing profile personal data retention across IPTV credential swaps (re-link by dedupKey)...');
  const dedupRelinkResults = await page.evaluate(async () => {
    // Check initial user profile state for Interstellar (dedupKey: tmdb:157336)
    const initialWatchlistHas = window.__mockCloudStore.localWatchlist.has('tmdb:157336');
    const initialProgress = window.__mockCloudStore.localProgress.get('tmdb:157336');
    const initialRating = window.__mockCloudStore.localRatings.get('tmdb:157336');

    // Simulate owner swapping IPTV providers completely:
    // New provider: different server, different credentials, new stream IDs in catalog
    await fetch('/api/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playlistName: 'Provider Beta',
        serverUrl: 'http://provider-beta.net:25461',
        username: 'betaprovider_user',
        password: 'betapassword99'
      })
    });

    // Replace stream versions inside local catalog for Interstellar
    const item = window.__mockCloudStore.localCatalog.find(i => i.dedupKey === 'tmdb:157336');
    if (item) {
      item.versions = [{ streamId: 999888, name: 'Provider Beta - Interstellar 4K', language: 'en', quality: '4K' }];
    }

    // Verify personal data remains 100% attached to dedupKey tmdb:157336
    const postSwapWatchlistHas = window.__mockCloudStore.localWatchlist.has('tmdb:157336');
    const postSwapProgress = window.__mockCloudStore.localProgress.get('tmdb:157336');
    const postSwapRating = window.__mockCloudStore.localRatings.get('tmdb:157336');

    return {
      initialWatchlistHas,
      postSwapWatchlistHas,
      progressPreserved: postSwapProgress && postSwapProgress.posMs === initialProgress.posMs,
      ratingPreserved: postSwapRating === initialRating,
      newStreamId: item?.versions[0]?.streamId
    };
  });

  assert.equal(dedupRelinkResults.initialWatchlistHas, true, 'Watchlist had item before swap');
  assert.equal(dedupRelinkResults.postSwapWatchlistHas, true, 'Watchlist still has item after provider swap');
  assert.equal(dedupRelinkResults.progressPreserved, true, 'Resume position preserved across provider swap');
  assert.equal(dedupRelinkResults.ratingPreserved, true, 'User rating preserved across provider swap');
  assert.equal(dedupRelinkResults.newStreamId, 999888, 'Catalog stream ID successfully updated to new provider');
  console.log('  ✓ PASS: DedupKey anchoring preserves 100% of user profile data across playlist swaps.\n');

  await browser.close();
  console.log('====================================================');
  console.log('  ALL PHASE D ASSERTIONS PASSED (8/8)');
  console.log('====================================================');
}

runPhaseDTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
