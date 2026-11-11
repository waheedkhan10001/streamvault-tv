// TV <-> phone linking, end to end. Real Worker code on a real SQLite database, the real TV page
// (tv-ui.html) and the real phone page (/link) each running in Chrome. Nothing about the link flow is mocked
// except the e-mail sender (the 6-digit e-mail codes are captured instead of being sent).
// Added after the first phone test: three tabs, two different codes, two "Link TV" buttons, and a phone that
// said "signed in" while the TV never moved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import worker from '../cloud-sync/src/worker.js';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (_) { console.log(`⚠ SKIPPED pairing tests: needs Node 22.13 or newer (found ${process.version}).`); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'cloud-sync/schema.sql'), 'utf8');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(SCHEMA);
const DB = {
  prepare(sql) {
    return { bind(...a) { return {
      async first() { return sqlite.prepare(sql).get(...a) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...a) }; },
      async run() { const r = sqlite.prepare(sql).run(...a); return { success: true, meta: { changes: Number(r.changes) } }; }
    }; } };
  }
};
const env = { DB, DEV_MODE: 'false', BREVO_API_KEY: 'xkeysib-test' };

const emails = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.brevo.com')) {
    const body = JSON.parse(init.body);
    emails.push({ to: body.to[0].email, code: (body.subject.match(/(\d{6})/) || [])[1] });
    return new Response('{"messageId":"x"}', { status: 201 });
  }
  throw new Error('unexpected outside call ' + url);
};
const lastEmailCode = to => [...emails].reverse().find(e => e.to === to)?.code;
const clearLimits = () => sqlite.exec('DELETE FROM rate_limits');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Anything the browser asks of the cloud host goes to the real Worker code.
async function routeToWorker(req) {
  const u = new URL(req.url());
  const headers = { 'CF-Connecting-IP': '203.0.113.7' };
  for (const [k, v] of Object.entries(req.headers())) if (['content-type', 'authorization', 'origin'].includes(k)) headers[k] = v;
  const post = req.postData();
  const res = await worker.fetch(new Request('https://sync.test' + u.pathname + u.search, { method: req.method(), headers, body: post || undefined }), env);
  const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
  h['access-control-allow-origin'] = '*'; h['access-control-allow-headers'] = '*'; h['access-control-allow-methods'] = '*';
  await req.respond({ status: res.status, headers: h, body: await res.text() });
}
const isCloud = u => u.startsWith('https://sync.test') || u.startsWith('https://streamvault-sync.streamvault-app.workers.dev');

async function newTv(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
    if (isCloud(u)) return routeToWorker(req).catch(() => req.abort());
    req.abort();
  });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    window.AndroidApp = {
      handleApiRequest: (m, p) => window.AndroidApp.handleApiRequestWithAuth(m, p, '', null),
      handleApiRequestWithAuth: (method, path) => {
        if (path === '/api/state') return JSON.stringify({ ok: true, totalCatalogCount: 0, credentials: {}, parentalControl: {} });
        if (path === '/api/status') return JSON.stringify({ ok: true, credentials: {}, catalogCount: 0 });
        if (path === '/api/session') return JSON.stringify({ ok: true, authenticated: false });
        if (path === '/api/playlists') return JSON.stringify({ ok: true, playlists: [] });
        if (path === '/api/profiles') return JSON.stringify({ ok: true, profiles: [{ id: 'prof_primary', name: 'Me', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }], activeProfileId: 'prof_primary' });
        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };
    localStorage.clear();
  });
  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^SV-[A-Z0-9]{4}$/.test(document.getElementById('welcomeCodeDisplay')?.innerText || ''), { timeout: 10000 });
  return page;
}
const tvCode = page => page.evaluate(() => document.getElementById('welcomeCodeDisplay').innerText);
const tvSignedIn = page => page.waitForFunction(() => document.getElementById('welcomeScreenOverlay').style.display === 'none' && !!localStorage.getItem('sv_auth_token'), { timeout: 12000 }).then(() => true, () => false);

async function newPhone(browser) {
  const ctx = browser.createBrowserContext ? await browser.createBrowserContext() : await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true });
  await page.setRequestInterception(true);
  page.on('request', req => isCloud(req.url()) ? routeToWorker(req).catch(() => req.abort()) : req.abort());
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.ctx = ctx;
  return page;
}
const open = (phone, qs = '') => phone.goto('https://sync.test/link' + qs, { waitUntil: 'networkidle0' });
const visible = (page, id) => page.evaluate(id => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null; }, id);
const shownView = page => page.evaluate(() => ['viewCode', 'viewAuth', 'viewVerify', 'viewConfirm', 'viewDone'].find(v => !document.getElementById(v).hidden));
const type = async (page, sel, text) => { await page.click(sel, { clickCount: 3 }); await page.type(sel, text); };
const waitView = (page, v) => page.waitForFunction(v => !document.getElementById(v).hidden, { timeout: 6000 }, v).then(() => true, () => false);

async function run() {
  console.log('=== StreamVault — TV <-> phone linking, end to end ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox'] });

  console.log('1. Brand-new user: scan QR -> create account -> e-mail code -> TV signs in');
  {
    clearLimits();
    const tv = await newTv(browser);
    const code = await tvCode(tv);
    const qrOk = await tv.evaluate(() => (document.getElementById('welcomeQrImg').src || '').startsWith('data:image'));
    check('TV shows a TV code and an offline QR', /^SV-/.test(code) && qrOk, code);
    const tvText = await tv.evaluate(() => document.getElementById('welcomeScreenOverlay').innerText);
    check('TV tells the user what to do in 3 plain steps', /Scan this QR/i.test(tvText) && /Sign in or create an account/i.test(tvText) && /signs in by itself/i.test(tvText));

    const phone = await newPhone(browser);
    await open(phone, '?code=' + code);
    check('phone opens straight to sign-in (no code box, QR already carried the code)', (await shownView(phone)) === 'viewAuth');
    const tabs = await phone.evaluate(() => [...document.querySelectorAll('.tabs button')].map(b => b.textContent.trim()));
    check('phone has exactly two choices: Sign in | Create account (no "Link TV" tab)', tabs.join('|') === 'Sign in|Create account', tabs.join('|'));
    check('phone shows which TV it is linking', await phone.evaluate(c => document.querySelector('#viewAuth .chip').innerText.includes(c), code));
    const linkButtons = await phone.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && /^link tv$/i.test(b.textContent.trim())).length);
    check('no stray "Link TV" buttons', linkButtons === 0, 'found ' + linkButtons);

    await phone.click('#tabUp');
    await type(phone, '#upName', 'Dr Saman'); await type(phone, '#upEmail', 'saman@example.com'); await type(phone, '#upPass', 'Secret123!');
    await phone.click('#btnUp');
    check('after Create account the phone asks for the e-mail code', await waitView(phone, 'viewVerify'));
    const verText = await phone.evaluate(() => document.getElementById('viewVerify').innerText);
    check('it names the e-mail address and says this is NOT the TV code', verText.includes('saman@example.com') && /not.*the code on your TV/i.test(verText), verText.slice(0, 120));
    check('TV is still waiting (not signed in before verification)', !(await tv.evaluate(() => !!localStorage.getItem('sv_auth_token'))));

    await type(phone, '#verCode', '000000'); await phone.click('#btnVerify');
    await sleep(500);
    check('wrong e-mail code: error shown, still on that step', (await shownView(phone)) === 'viewVerify' && await visible(phone, 'errVerify'));
    await type(phone, '#verCode', lastEmailCode('saman@example.com')); await phone.click('#btnVerify');
    check('right e-mail code: phone shows "Your TV is linked"', await waitView(phone, 'viewDone'));
    check('TV signs itself in and leaves the welcome screen', await tvSignedIn(tv));
    const acct = await tv.evaluate(() => JSON.parse(localStorage.getItem('streamvault_account') || '{}'));
    check('TV is signed in as the new account', acct.email === 'saman@example.com', JSON.stringify(acct));
    const sessions = sqlite.prepare('SELECT COUNT(*) n FROM sessions').get().n;
    check('server holds a session for the TV (and one for the phone)', sessions === 2, 'sessions=' + sessions);
    check('no JS errors on either screen', tv.errors.length + phone.errors.length === 0, [...tv.errors, ...phone.errors].join(' | '));
    await tv.close(); await phone.ctx.close();
  }

  console.log('\n2. Same phone, second TV: one tap, no typing');
  {
    clearLimits();
    const tv = await newTv(browser);
    const code = await tvCode(tv);
    const phone = await newPhone(browser);
    await open(phone, '?code=' + code);
    await phone.evaluate(() => {});
    await type(phone, '#inEmail', 'saman@example.com'); await type(phone, '#inPass', 'Secret123!');
    await phone.click('#btnIn');
    check('sign-in links the TV with no extra step', await waitView(phone, 'viewDone'));
    check('TV 2 signs in', await tvSignedIn(tv));
    // same phone again, third TV
    const tv3 = await newTv(browser);
    const code3 = await tvCode(tv3);
    await open(phone, '?code=' + code3);
    check('already signed in on the phone: asks "Link this TV?" with the e-mail', (await shownView(phone)) === 'viewConfirm' && await phone.evaluate(() => document.getElementById('confirmEmail').textContent === 'saman@example.com'));
    await phone.click('#btnConfirm');
    check('one tap links the 3rd TV', await waitView(phone, 'viewDone') && await tvSignedIn(tv3));
    await open(phone, '?code=' + code3);
    check('using a link twice is refused', (await shownView(phone)) === 'viewConfirm');
    await phone.click('#btnConfirm'); await sleep(600);
    check('a used TV code cannot be linked again (asks for a new code)', (await shownView(phone)) === 'viewCode' && await visible(phone, 'errCode'));
    await tv.close(); await tv3.close(); await phone.ctx.close();
  }

  console.log('\n3. Phone opened without a code (typed the address): enter the TV code first');
  {
    clearLimits();
    const tv = await newTv(browser);
    const code = await tvCode(tv);
    const phone = await newPhone(browser);
    await open(phone);
    check('asks for the code on the TV', (await shownView(phone)) === 'viewCode');
    await type(phone, '#tvCode', 'zz'); await phone.click('#btnCode');
    check('rejects a malformed code', (await shownView(phone)) === 'viewCode' && await visible(phone, 'errCode'));
    await type(phone, '#tvCode', code.toLowerCase().replace('sv-', '')); await phone.click('#btnCode');
    check('accepts the code typed in lower case without the SV- prefix', (await shownView(phone)) === 'viewAuth');
    await type(phone, '#inEmail', 'saman@example.com'); await type(phone, '#inPass', 'wrong-password'); await phone.click('#btnIn');
    await sleep(600);
    check('wrong password: clear error, TV untouched', await visible(phone, 'errAuth') && !(await tv.evaluate(() => !!localStorage.getItem('sv_auth_token'))));
    await type(phone, '#inPass', 'Secret123!'); await phone.click('#btnIn');
    check('right password: linked', await waitView(phone, 'viewDone') && await tvSignedIn(tv));
    await tv.close(); await phone.ctx.close();
  }

  console.log('\n4. Bad or hostile codes in the address');
  {
    clearLimits();
    const phone = await newPhone(browser);
    await open(phone, '?code=' + encodeURIComponent('"></script><script>window.__x=1</script>'));
    check('a script in ?code= is ignored and never runs', (await shownView(phone)) === 'viewCode' && !(await phone.evaluate(() => window.__x)));
    await open(phone, '?code=SV-0O1I');
    check('lookalike characters (0 O 1 I) are not accepted', (await shownView(phone)) === 'viewCode');
    await phone.ctx.close();
  }

  console.log('\n5. Sign-up never finished (e-mail not verified) is sent to the e-mail step');
  {
    clearLimits();
    const tv = await newTv(browser);
    const code = await tvCode(tv);
    await fetch2('/api/auth/signup', { email: 'half@example.com', password: 'Secret123!' });
    clearLimits();
    const phone = await newPhone(browser);
    await open(phone, '?code=' + code);
    await type(phone, '#inEmail', 'half@example.com'); await type(phone, '#inPass', 'Secret123!'); await phone.click('#btnIn');
    check('goes to e-mail verification, TV not linked yet', await waitView(phone, 'viewVerify') && !(await tv.evaluate(() => !!localStorage.getItem('sv_auth_token'))));
    await tv.close(); await phone.ctx.close();
  }

  console.log('\n6. TV code expires: the TV shows a new one by itself');
  {
    clearLimits();
    const tv = await newTv(browser);
    const code = await tvCode(tv);
    sqlite.prepare('UPDATE pairing_codes SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, code);
    const changed = await tv.waitForFunction(old => /^SV-/.test(document.getElementById('welcomeCodeDisplay').innerText) && document.getElementById('welcomeCodeDisplay').innerText !== old, { timeout: 9000 }, code).then(() => true, () => false);
    check('expired code is replaced on the TV screen', changed);
    const phone = await newPhone(browser);
    await open(phone, '?code=' + code);
    await type(phone, '#inEmail', 'saman@example.com'); await type(phone, '#inPass', 'Secret123!'); await phone.click('#btnIn');
    await waitView(phone, 'viewCode');
    check('phone using the old code is told to read the new one', await visible(phone, 'errCode') && /expired|already used/i.test(await phone.evaluate(() => document.getElementById('errCode').textContent)));
    await tv.close(); await phone.ctx.close();
  }

  console.log('\n7. Abuse limits on the pairing routes');
  {
    clearLimits();
    const hit = async (m, p, tok) => (await worker.fetch(new Request('https://sync.test' + p, { method: m, headers: { 'CF-Connecting-IP': '198.51.100.9', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined }), env)).status;
    let last = 0; for (let i = 0; i < 25; i++) last = await hit('POST', '/api/auth/request-code');
    check('request-code is limited per address', last === 429, 'last=' + last);
    last = 0; for (let i = 0; i < 65; i++) last = await hit('GET', '/api/auth/poll-code?code=SV-AAAA');
    check('poll-code is limited per address (TV polls ~20/min, well under it)', last === 429, 'last=' + last);
    const tok = sqlite.prepare('SELECT 1').get() && null;
    check('claim-code needs a signed-in account', (await hit('POST', '/api/auth/claim-code')) === 401);
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

async function fetch2(route, body) {
  return worker.fetch(new Request('https://sync.test' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.5' }, body: JSON.stringify(body) }), env);
}

run().catch(e => { console.error(e); process.exit(1); });
