// IPTV playlist screen, end to end: the real Worker (cloud playlists on real SQLite) + the real TV page + a TV-native mock
// that records what the page hands to the TV. Added after the second install: Settings showed "Failed" next to "Active",
// Edit did nothing, nothing was ever loaded, and "Refresh Now" claimed to refresh with no playlist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import worker from '../cloud-sync/src/worker.js';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (_) { console.log(`⚠ SKIPPED playlist tests: needs Node 22.13 or newer (found ${process.version}).`); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'cloud-sync/schema.sql'), 'utf8'));
const DB = { prepare(sql) { return { bind(...a) { return {
  async first() { return sqlite.prepare(sql).get(...a) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...a) }; },
  async run() { const r = sqlite.prepare(sql).run(...a); return { success: true, meta: { changes: Number(r.changes) } }; }
}; } }; } };
const env = { DB, DEV_MODE: 'true', BREVO_API_KEY: 'x', AES_SECRET: 'test-aes-secret-for-playlists-0123456789' };
globalThis.fetch = async (u) => { if (String(u).includes('brevo')) return new Response('{}', { status: 201 }); throw new Error('outside call ' + u); };

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const callW = async (method, route, body, token) => {
  const res = await worker.fetch(new Request('https://sync.test' + route, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.' + Math.floor(Math.random() * 200), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};

async function routeToWorker(req) {
  const u = new URL(req.url());
  const headers = { 'CF-Connecting-IP': '203.0.113.9' };
  for (const [k, v] of Object.entries(req.headers())) if (['content-type', 'authorization'].includes(k)) headers[k] = v;
  const res = await worker.fetch(new Request('https://sync.test' + u.pathname + u.search, { method: req.method(), headers, body: req.postData() || undefined }), env);
  const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
  Object.assign(h, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
  await req.respond({ status: res.status, headers: h, body: await res.text() });
}

async function newTv(browser, token, email, nativeStart = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (/^(file|data|blob):/.test(u)) return req.continue();
    if (u.startsWith('https://streamvault-sync.streamvault-app.workers.dev')) return routeToWorker(req).catch(() => req.abort());
    req.abort();
  });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.evaluateOnNewDocument((token, email, nativeStart) => {
    window.__n = Object.assign({ creds: {}, sync: { isSyncing: false, phase: '', error: null }, total: 0, calls: [] }, nativeStart);
    const profiles = [{ id: 'p1', name: 'Me', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }];
    window.AndroidApp = {
      handleApiRequest: (m, p, b) => window.AndroidApp.handleApiRequestWithAuth(m, p, b, null),
      handleApiRequestWithAuth: (method, path, body) => {
        const n = window.__n;
        const j = o => JSON.stringify(o);
        if (path === '/api/state') return j({ ok: true, totalCatalogCount: n.total, credentials: n.creds, syncStatus: { isSyncing: n.sync.isSyncing, phase: n.sync.phase, error: n.sync.error }, parentalControl: {}, profiles, activeProfile: profiles[0] });
        if (path === '/api/status') return j({ ok: true, credentials: n.creds, catalogCount: n.total });
        if (path === '/api/session') return j({ ok: true, authenticated: true, token });
        if (path === '/api/save-credentials') { const b = JSON.parse(body || '{}'); n.calls.push(['save', b]); n.creds = { serverUrl: b.serverUrl, username: b.username, password: b.password, hasPassword: !!b.password, playlistName: b.playlistName }; n.sync = { isSyncing: true, phase: 'Connecting…', error: null }; return j({ ok: true }); }
        if (path === '/api/sync-now') { n.calls.push(['sync']); if (!n.creds.serverUrl) return j({ ok: false, error: 'No working IPTV playlist to refresh. Add one under IPTV Playlists first.' }); return j({ ok: true }); }
        if (path === '/api/clear-playlist') { n.calls.push(['clear']); n.creds = {}; n.total = 0; return j({ success: true }); }
        if (path === '/api/profiles') return j({ ok: true, profiles, activeProfileId: 'p1' });
        return j({ ok: true, items: [], playlists: [] });
      }, playAcousticTick: () => {}
    };
    localStorage.setItem('sv_auth_token', token); localStorage.setItem('streamvault_session_token', token);
    localStorage.setItem('streamvault_account', JSON.stringify({ accountId: 'a', email, displayName: 'Me' })); localStorage.setItem('streamvault_active_profile_id', 'p1');
  }, token, email, nativeStart);
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.navigateToTab === 'function');
  await sleep(500);
  await page.evaluate(() => { const o = document.getElementById('profilePickerOverlay'); if (o && o.style.display === 'flex') o.querySelector('.profile-picker-card')?.click(); });
  return page;
}
const calls = page => page.evaluate(() => window.__n.calls.map(c => c[0]));
const lastSave = page => page.evaluate(() => [...window.__n.calls].reverse().find(c => c[0] === 'save')?.[1]);
const press = async (page, k) => { await page.keyboard.press(k); await sleep(130); };
const openSettings = async page => { await page.evaluate(() => window.navigateToTab('SETTINGS')); await sleep(900); };
const rowText = page => page.evaluate(() => document.querySelector('[data-pl-badge]')?.closest('div[style*="border-radius:8px"]')?.innerText.replace(/\s+/g, ' ') || '');
const toast = page => page.evaluate(() => document.getElementById('tvToastNotification')?.innerText || '');

async function run() {
  console.log('=== StreamVault TV — IPTV playlists (cloud shape, real Worker) ===\n');
  const su = await callW('POST', '/api/auth/signup', { email: 'pl@example.com', password: 'Secret123!' });
  const vf = await callW('POST', '/api/auth/verify-code', { email: 'pl@example.com', code: su.json.devCode });
  const token = vf.json.token;
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox', '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND'] });

  console.log('1. No playlist yet: Refresh Now says so honestly');
  let tv = await newTv(browser, token, 'pl@example.com');
  await openSettings(tv);
  check('Settings invites you to add a playlist', (await tv.evaluate(() => document.getElementById('mainViewport').innerText)).includes('No Playlists Connected'));
  await tv.evaluate(() => document.getElementById('btnEnrichNow').focus()); await press(tv, 'Enter'); await sleep(400);
  check('Refresh Now: "No working IPTV playlist to refresh…" (not "refreshing")', /No working IPTV playlist to refresh/i.test(await toast(tv)), await toast(tv));
  check('and nothing was started on the TV', !(await calls(tv)).includes('sync'));

  console.log('\n2. Add a playlist with the remote');
  await tv.evaluate(() => document.getElementById('btnFirstRunAddPlaylist').focus()); await press(tv, 'Enter'); await sleep(400);
  check('popup opens on the Server box', (await tv.evaluate(() => document.activeElement.id)) === 'inpPlaylistServer');
  await press(tv, 'Enter'); await tv.keyboard.type('http://tv.example.com:8080'); await press(tv, 'Enter');
  await tv.keyboard.type('myuser'); await press(tv, 'Enter');
  await tv.keyboard.type('p@ss word#1'); await press(tv, 'Enter');
  check('Enter after Password lands on Save & Connect', (await tv.evaluate(() => document.activeElement.id)) === 'btnSavePlaylist');
  await press(tv, 'Enter'); await sleep(1200);
  const row = sqlite.prepare('SELECT * FROM playlists').all();
  check('the cloud holds exactly one playlist with the right server and user', row.length === 1 && row[0].server_url === 'http://tv.example.com:8080' && row[0].username === 'myuser', JSON.stringify(row.map(r => [r.server_url, r.username])));
  const sv = await lastSave(tv);
  check('the TV was given the login (so it can download the titles)', !!sv && sv.serverUrl === 'http://tv.example.com:8080' && sv.username === 'myuser' && sv.password === 'p@ss word#1', JSON.stringify(sv));
  check('the playlist name reached the TV', sv && sv.playlistName === 'Primary IPTV', JSON.stringify(sv));
  check('toast says the catalog is loading', /Loading your catalog/i.test(await toast(tv)), await toast(tv));
  let rt = await rowText(tv);
  check('row shows "Loading catalog" while the TV downloads', /Loading catalog/i.test(rt) && !/Failed/.test(rt), rt);

  console.log('\n3. Status follows what the TV is really doing');
  await tv.evaluate(() => { window.__n.sync = { isSyncing: false, phase: '', error: 'The IPTV server refused the login (HTTP 403). Check username and password' }; });
  await sleep(3500);
  rt = await rowText(tv);
  check('failure is shown WITH the reason', /Failed/.test(rt) && /refused the login/.test(rt), rt);
  await tv.evaluate(() => { window.__n.sync = { isSyncing: false, phase: '', error: null }; window.__n.total = 4200; });
  await openSettings(tv);
  rt = await rowText(tv);
  check('once titles exist it says Working', /Working/.test(rt) && !/Failed/.test(rt), rt);

  console.log('\n4. Edit works');
  await tv.evaluate(() => [...document.querySelectorAll('#mainViewport button')].find(b => b.textContent.trim() === 'Edit').focus());
  await press(tv, 'Enter'); await sleep(400);
  const ed = await tv.evaluate(() => ({ open: document.getElementById('playlistModal').style.display, title: document.getElementById('playlistModalTitle').innerText, server: document.getElementById('inpPlaylistServer').value, user: document.getElementById('inpPlaylistUser').value }));
  check('Edit opens the popup, titled Edit, with the current server and user', ed.open === 'flex' && /Edit/.test(ed.title) && ed.server === 'http://tv.example.com:8080' && ed.user === 'myuser', JSON.stringify(ed));
  await tv.evaluate(() => { const i = document.getElementById('inpPlaylistUser'); i.removeAttribute('readonly'); i.value = 'newuser'; });
  await tv.evaluate(() => document.getElementById('btnSavePlaylist').click()); await sleep(1200);
  check('the cloud record has the new username', sqlite.prepare('SELECT username FROM playlists').get().username === 'newuser');
  const sv2 = await lastSave(tv);
  check('TV got the new username AND the old password (left blank in the form)', sv2.username === 'newuser' && sv2.password === 'p@ss word#1', JSON.stringify(sv2));

  console.log('\n5. Switch off / on, and remove');
  await openSettings(tv);
  await tv.evaluate(() => [...document.querySelectorAll('#mainViewport button')].find(b => /Active/.test(b.textContent)).click()); await sleep(1000);
  check('turning off: cloud record disabled and the TV stops using it', sqlite.prepare('SELECT is_enabled FROM playlists').get().is_enabled === 0 && (await calls(tv)).includes('clear'));
  rt = await rowText(tv);
  check('row reads "Off"', /Off/.test(rt), rt);
  await tv.evaluate(() => [...document.querySelectorAll('#mainViewport button')].find(b => /Disabled/.test(b.textContent)).click()); await sleep(1000);
  check('turning on: cloud record enabled and the TV is given the login again', sqlite.prepare('SELECT is_enabled FROM playlists').get().is_enabled === 1 && (await lastSave(tv)).username === 'newuser');
  await openSettings(tv);
  await tv.evaluate(() => [...document.querySelectorAll('#mainViewport button')].find(b => b.textContent.trim() === '✕').click()); await sleep(1000);
  check('remove: cloud record removed and the TV forgets it', sqlite.prepare('SELECT removed_at FROM playlists').get().removed_at > 0);
  check('no JavaScript errors', tv.errors.length === 0, tv.errors.join(' | '));
  await tv.close();

  console.log('\n6. A new TV signing in to an account that already has a playlist');
  await callW('POST', '/api/playlists', { name: 'Home', serverUrl: 'http://tv.example.com:8080', username: 'newuser', password: 'pw9' }, token);
  tv = await newTv(browser, token, 'pl@example.com');
  await openSettings(tv);
  await sleep(600);
  const sv3 = await lastSave(tv);
  check('the cloud playlist is copied to this TV by itself and loading starts', !!sv3 && sv3.username === 'newuser' && sv3.password === 'pw9', JSON.stringify(sv3));
  await tv.close();

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
