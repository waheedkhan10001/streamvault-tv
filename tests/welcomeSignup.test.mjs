// Welcome + Sign-up/Sign-in remote-control (D-pad) tests (Puppeteer, REAL key presses).
// Added after the first TV install showed: QR/code not loading, Create Account skipping Display Name,
// and focus jumping to the background behind the popup. Unlike phases A-E this drives the page with
// real ArrowUp/Down/Left/Right/Enter/Escape key events and checks where focus actually lands.
// The native Kotlin layer is still a JS mock: Kotlin-side behaviour is covered by the Robolectric test.
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, UI_PATH } from './test-config.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser, { codeFails = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 }); // TV UI is laid out at 960x540
  const external = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
    external.push(u);               // the TV may have no route to third-party hosts: nothing external may be needed
    req.abort();
  });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.evaluateOnNewDocument((codeFails) => {
    window.__cloud = [];
    // Answers the way the real Worker does. The page captures this as its raw fetch.
    window.fetch = async (url, init) => {
      const u = String(url);
      const body = init && init.body ? JSON.parse(init.body) : {};
      window.__cloud.push({ url: u, body });
      const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
      if (u.endsWith('/api/auth/request-code')) return codeFails ? Promise.reject(new TypeError('Failed to fetch')) : json({ success: true, code: 'SV-AB12', expiresInSeconds: 600 });
      if (u.endsWith('/api/auth/poll-code')) return json({ success: true, status: 'pending' });
      if (u.endsWith('/api/auth/signup')) return json({ success: true, requireVerification: true });
      if (u.endsWith('/api/auth/login')) return json({ error: 'Invalid email or password' }, 401);
      if (u.endsWith('/api/auth/verify-code')) return body.code === '123456'
        ? json({ success: true, token: 'tok-0123456789abcdef0123456789abcdef0123', accountId: 'acc_1', email: body.email, displayName: 'Dr Saman' })
        : json({ error: 'Invalid or expired code' }, 400);
      return json({ ok: true });
    };
    // Minimal native-layer mock (fresh install: no session).
    window.AndroidApp = {
      handleApiRequest: (m, p) => window.AndroidApp.handleApiRequestWithAuth(m, p, '', null),
      handleApiRequestWithAuth: (method, path) => {
        if (path === '/api/state') return JSON.stringify({ ok: true, totalCatalogCount: 0, credentials: {}, parentalControl: {} });
        if (path === '/api/status') return JSON.stringify({ ok: true, credentials: {}, catalogCount: 0 });
        if (path === '/api/session') return JSON.stringify({ ok: true, authenticated: false });
        if (path === '/api/playlists') return JSON.stringify({ ok: true, playlists: [] });
        if (path === '/api/profiles') return JSON.stringify({ ok: true, profiles: [{ id: 'prof_primary', name: 'Dr Saman', avatarColor: '#7C3AED', isKids: false, theme: 'purple', isPrimary: true, updatedAt: 1 }], activeProfileId: 'prof_primary' });
        if (path === '/api/auth/me') return JSON.stringify({ ok: true, account: { accountId: 'acc_1', email: 'saman@example.com', displayName: 'Dr Saman' } });
        return JSON.stringify({ ok: true });
      },
      playAcousticTick: () => {}
    };
    localStorage.clear();
  }, codeFails);

  await page.goto(UI_PATH, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('welcomeScreenOverlay')?.style.display === 'flex', { timeout: 8000 });
  await sleep(300);
  return { page, external, pageErrors };
}

const active = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || 'none');
const insideModal = page => page.evaluate(() => !!document.activeElement?.closest('#cloudAuthModal'));
async function press(page, key) { await page.keyboard.press(key); await sleep(140); }

// Walks a list of [key, expectedFocusId] steps; also asserts focus never leaves the popup.
async function walk(page, label, steps) {
  for (const [key, expected] of steps) {
    await press(page, key);
    const now = await active(page);
    const inModal = await insideModal(page);
    check(`${label}: ${key} -> ${expected}`, now === expected && inModal, `focus is on "${now}"${inModal ? '' : ' (OUTSIDE the popup)'}`);
  }
}

async function run() {
  console.log('=== StreamVault TV — Welcome / Sign-up remote-control tests ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox'] });

  // ---------- 1. Welcome screen: pairing code + QR ----------
  console.log('1. Welcome screen');
  {
    const { page, external, pageErrors } = await newPage(browser);
    const code = await page.$eval('#welcomeCodeDisplay', e => e.innerText.trim());
    check('pairing code shows the real code (not "SV-....")', code === 'SV-AB12', `shows "${code}"`);
    const qr = await page.evaluate(() => {
      const img = document.getElementById('welcomeQrImg');
      return { src: img?.src || '', ok: !!img && img.complete && img.naturalWidth > 0 };
    });
    check('QR is drawn on the TV itself (no internet service needed)', qr.src.startsWith('data:image') && qr.ok, `src="${qr.src.slice(0, 60)}" loaded=${qr.ok}`);
    check('welcome screen made no requests to outside websites', external.length === 0, external.join(', '));
    check('first focus is Sign In', (await active(page)) === 'welcomeBtnSignIn');
    await press(page, 'ArrowDown');
    check('Down moves to Create Account', (await active(page)) === 'welcomeBtnSignUp');
    await press(page, 'ArrowUp');
    check('Up moves back to Sign In', (await active(page)) === 'welcomeBtnSignIn');
    check('no JavaScript errors on welcome screen', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  // ---------- 1b. Code cannot load: must say so, not sit on "SV-...." ----------
  console.log('\n1b. Welcome screen when the cloud is unreachable');
  {
    const { page } = await newPage(browser, { codeFails: true });
    const code = await page.$eval('#welcomeCodeDisplay', e => e.innerText.trim());
    check('shows a clear message instead of "SV-...."', code !== 'SV-....' && code.length > 0, `shows "${code}"`);
    await page.close();
  }

  // ---------- 2. Create account via remote ----------
  console.log('\n2. Create Account (remote control only)');
  {
    const { page, pageErrors } = await newPage(browser);
    await press(page, 'ArrowDown');                    // Create Account
    await press(page, 'Enter');                        // open popup
    await sleep(200);
    const open = await page.evaluate(() => document.getElementById('cloudAuthModal').style.display === 'flex');
    check('popup opens', open);
    check('focus starts on Display Name (first field)', (await active(page)) === 'cloudAuthName', `focus is on "${await active(page)}"`);

    await walk(page, 'sign-up', [
      ['ArrowDown', 'cloudAuthEmail'],
      ['ArrowDown', 'cloudAuthPassword'],
      ['ArrowDown', 'cloudAuthSubmitBtn'],
      ['ArrowLeft', 'cloudAuthCancelBtn'],
      ['ArrowRight', 'cloudAuthSubmitBtn'],
      ['ArrowDown', 'cloudAuthToggleLink'],
      ['ArrowUp', 'cloudAuthSubmitBtn'],
      ['ArrowUp', 'cloudAuthPassword'],
      ['ArrowUp', 'cloudAuthEmail'],
      ['ArrowUp', 'cloudAuthName'],
      ['ArrowUp', 'cloudAuthName'],                    // top edge: must stay in the popup
    ]);

    // Type a display name, email and password with the remote's OK + keyboard
    await press(page, 'Enter');                        // OK on Display Name -> editable
    await page.keyboard.type('Dr Saman');
    const name = await page.$eval('#cloudAuthName', e => e.value);
    check('can type a Display Name', name === 'Dr Saman', `value="${name}"`);
    await press(page, 'Enter');                        // OK/Next -> Email
    check('Enter on Display Name moves to Email', (await active(page)) === 'cloudAuthEmail', `focus is on "${await active(page)}"`);
    await page.keyboard.type('saman@example.com');
    await press(page, 'Enter');
    check('Enter on Email moves to Password', (await active(page)) === 'cloudAuthPassword', `focus is on "${await active(page)}"`);
    await page.keyboard.type('Secret123!');
    await press(page, 'Enter');
    check('Enter on Password moves to Create Account button (not Cancel)', (await active(page)) === 'cloudAuthSubmitBtn', `focus is on "${await active(page)}"`);

    await press(page, 'Enter');                        // submit
    await sleep(400);
    const signup = await page.evaluate(() => window.__cloud.find(c => c.url.endsWith('/api/auth/signup')));
    check('sign-up request reaches the cloud with the display name', !!signup && signup.body.displayName === 'Dr Saman' && signup.body.email === 'saman@example.com', JSON.stringify(signup));
    const verifyShown = await page.evaluate(() => document.getElementById('cloudAuthVerifyPane').style.display === 'block');
    check('moves to the code-entry screen', verifyShown);
    check('focus is on the code box', (await active(page)) === 'cloudVerifyCodeInput', `focus is on "${await active(page)}"`);

    await walk(page, 'verify', [
      ['ArrowDown', 'cloudVerifySubmitBtn'],
      ['ArrowLeft', 'cloudVerifyBackBtn'],
      ['ArrowRight', 'cloudVerifySubmitBtn'],
      ['ArrowDown', 'cloudVerifyResendLink'],
      ['ArrowUp', 'cloudVerifySubmitBtn'],
      ['ArrowUp', 'cloudVerifyCodeInput'],
    ]);
    await press(page, 'Escape');                       // Back key returns to the form, popup stays open
    const backToForm = await page.evaluate(() => document.getElementById('cloudAuthFormPane').style.display !== 'none' && document.getElementById('cloudAuthModal').style.display === 'flex');
    check('Back key from code screen returns to the form', backToForm);
    check('...and focus is still inside the popup', await insideModal(page), `focus is on "${await active(page)}"`);
    await press(page, 'Escape');
    const closed = await page.evaluate(() => document.getElementById('cloudAuthModal').style.display === 'none');
    check('Back key closes the popup', closed);
    check('...and focus returns to the welcome buttons', ['welcomeBtnSignIn', 'welcomeBtnSignUp'].includes(await active(page)), `focus is on "${await active(page)}"`);
    check('no JavaScript errors during sign-up', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  // ---------- 3. Sign in via remote ----------
  console.log('\n3. Sign In (remote control only)');
  {
    const { page } = await newPage(browser);
    await press(page, 'Enter');                        // Sign In
    await sleep(200);
    check('focus starts on Email', (await active(page)) === 'cloudAuthEmail', `focus is on "${await active(page)}"`);
    await walk(page, 'sign-in', [
      ['ArrowDown', 'cloudAuthPassword'],
      ['ArrowDown', 'cloudAuthSubmitBtn'],
      ['ArrowDown', 'cloudAuthToggleLink'],
      ['ArrowUp', 'cloudAuthSubmitBtn'],
      ['ArrowUp', 'cloudAuthPassword'],
      ['ArrowUp', 'cloudAuthEmail'],
      ['ArrowUp', 'cloudAuthEmail'],
    ]);
    await press(page, 'ArrowDown'); await press(page, 'ArrowDown'); await press(page, 'ArrowDown'); // -> toggle link
    await press(page, 'Enter');                        // "Don't have an account? Sign Up"
    await sleep(150);
    check('switching to Sign Up puts focus on Display Name', (await active(page)) === 'cloudAuthName', `focus is on "${await active(page)}"`);
    await page.close();
  }

  // ---------- 4. Wrong password message, then full sign-up with the emailed code ----------
  console.log('\n4. Wrong password, then finishing sign-up with the emailed code');
  {
    const { page, pageErrors } = await newPage(browser);
    await press(page, 'Enter');                        // Sign In
    await sleep(200);
    await press(page, 'Enter'); await page.keyboard.type('someone@example.com');   // email
    await press(page, 'Enter'); await page.keyboard.type('wrongpass');             // password
    await press(page, 'Enter');                        // -> Sign In button
    await press(page, 'Enter');                        // submit
    await sleep(400);
    const msg = await page.$eval('#cloudAuthStatusMsg', e => e.innerText);
    check('wrong password shows the server message', /invalid email or password/i.test(msg), `shows "${msg}"`);
    check('Sign In button is usable again', await page.evaluate(() => !document.getElementById('cloudAuthSubmitBtn').disabled));
    check('focus is still inside the popup after the error', await insideModal(page), `focus is on "${await active(page)}"`);
    await page.close();
  }
  {
    const { page, pageErrors } = await newPage(browser);
    await press(page, 'ArrowDown'); await press(page, 'Enter'); await sleep(200);  // Create account
    await press(page, 'Enter'); await page.keyboard.type('Dr Saman');
    await press(page, 'Enter'); await page.keyboard.type('saman@example.com');
    await press(page, 'Enter'); await page.keyboard.type('Secret123!');
    await press(page, 'Enter'); await press(page, 'Enter'); await sleep(400);       // submit -> code screen
    await press(page, 'Enter'); await page.keyboard.type('000000');                  // wrong code first
    await press(page, 'Enter'); await press(page, 'Enter'); await sleep(400);
    const wrong = await page.$eval('#cloudVerifyStatusMsg', e => e.innerText);
    check('wrong emailed code shows an error', /invalid|expired/i.test(wrong), `shows "${wrong}"`);
    check('focus is still inside the popup after the wrong code', await insideModal(page), `focus is on "${await active(page)}"`);
    await page.$eval('#cloudVerifyCodeInput', e => { e.value = ''; });
    await press(page, 'ArrowUp'); await press(page, 'Enter'); await page.keyboard.type('123456');
    await press(page, 'Enter'); await press(page, 'Enter'); await sleep(1500);
    const st = await page.evaluate(() => ({
      welcome: document.getElementById('welcomeScreenOverlay').style.display,
      modal: document.getElementById('cloudAuthModal').style.display,
      token: !!localStorage.getItem('sv_auth_token'),
      focus: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
      focusVisible: !!document.activeElement && document.activeElement !== document.body && document.activeElement.offsetParent !== null,
    }));
    check('right code signs in and stores the session', st.token);
    check('welcome screen and popup are gone', st.welcome === 'none' && st.modal === 'none', JSON.stringify(st));
    check('remote still has something to focus afterwards', st.focusVisible, `focus is on "${st.focus}"`);
    // Keys must not be registered twice after signing in (arrows would skip a row, OK would fire twice)
    await page.evaluate(() => { window.__keyCalls = 0; const orig = window.handleTvKeyEvent; window.handleTvKeyEvent = function (...a) { window.__keyCalls++; return orig.apply(this, a); }; });
    await press(page, 'ArrowDown');
    const calls = await page.evaluate(() => window.__keyCalls);
    check('after signing in, one key press is handled exactly once', calls === 1, `handled ${calls} times`);
    check('no JavaScript errors through the whole sign-up', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
