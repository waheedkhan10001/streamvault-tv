// Round 2 security tests: PIN reset / PIN sync / rate limits / TMDB key / migrations.
// Runs the REAL Worker code against a REAL SQLite database created from cloud-sync/schema.sql
// (node:sqlite), so the SQL in worker.js is executed for real, not pattern-matched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../cloud-sync/src/worker.js';

// node:sqlite ships with Node 22.13+. On older Node, skip loudly instead of breaking `npm test`.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (_) {
  console.log(`⚠ SKIPPED Round 2 tests: this needs Node 22.13 or newer (found ${process.version}).`);
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'cloud-sync/schema.sql'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'cloud-sync/src/worker.js'), 'utf8');

// ---------- D1-compatible shim over real SQLite ----------
function createRealD1(schemaSql = SCHEMA) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return sqlite.prepare(sql).get(...args) ?? null; },
            async all() { return { results: sqlite.prepare(sql).all(...args) }; },
            async run() {
              const r = sqlite.prepare(sql).run(...args);
              return { success: true, meta: { changes: Number(r.changes) } };
            }
          };
        }
      };
    }
  };
}

// ---------- helpers ----------
const emails = [];           // every Brevo email captured: { to, subject, code, sender }
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.brevo.com')) {
    const body = JSON.parse(init.body);
    emails.push({
      to: body.to[0].email,
      subject: body.subject,
      code: (body.subject.match(/(\d{6})/) || [])[1],
      sender: body.sender
    });
    return new Response('{"messageId":"x"}', { status: 201 });
  }
  if (String(url).includes('api.themoviedb.org')) {
    return new Response('{"id":1,"title":"Mock"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};

let ipCounter = 1;
const nextIp = () => `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function call(env, method, route, { token, body, ip } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || nextIp() };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('https://sync.test' + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const clearLimits = (db) => db.sqlite.exec('DELETE FROM rate_limits');
const nativeHash = (pin, salt) => 'pbkdf2_sha256$100000$' + crypto.pbkdf2Sync(String(pin), String(salt), 100000, 32, 'sha256').toString('hex');

// sign up + verify an account through the real routes; returns { token, accountId, email }
async function makeAccount(env, db, email, password = 'AccountPass123!') {
  const s = await call(env, 'POST', '/api/auth/signup', { body: { email, password } });
  assert.equal(s.status, 201, 'signup must work on the real schema: ' + JSON.stringify(s.json));
  const v = await call(env, 'POST', '/api/auth/verify-code', { body: { email, code: s.json.devCode } });
  assert.equal(v.status, 200, 'verify must work: ' + JSON.stringify(v.json));
  clearLimits(db);
  return { token: v.json.token, accountId: v.json.accountId, email, password };
}

const newEnv = (extra = {}) => {
  const db = createRealD1();
  return { db, env: { DB: db, DEV_MODE: 'true', BREVO_API_KEY: 'xkeysib-test', ...extra } };
};

let passed = 0;
const pass = (msg) => { passed++; console.log('  ✓ PASS: ' + msg + '\n'); };

async function run() {
  console.log('=== Running StreamVault TV — Round 2 Security Test Suite (real SQLite) ===\n');

  // ---- 1. schema + migrations -------------------------------------------------
  console.log('[Test 1] schema.sql loads in real SQLite; migrations upgrade an OLD database safely...');
  {
    const d = createRealD1();
    const cols = d.sqlite.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
    assert.ok(cols.includes('pin_hash') && cols.includes('pin_salt'), 'fresh schema has pin_hash + pin_salt');

    const old = new DatabaseSync(':memory:');
    old.exec(`CREATE TABLE accounts (account_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL, is_verified INTEGER DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
              INSERT INTO accounts VALUES ('a1','keep@me.com','h',1,1,1);`);
    const dir = path.join(ROOT, 'cloud-sync/migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    assert.equal(files.length, 5, 'five migration files');
    for (const f of files) old.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    const oldCols = old.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
    assert.ok(oldCols.includes('pin_hash') && oldCols.includes('pin_salt'), 'migrated DB has both PIN columns');
    assert.ok(old.prepare("SELECT name FROM sqlite_master WHERE name='rate_limits'").get(), 'rate_limits created');
    assert.equal(old.prepare('SELECT email FROM accounts').get().email, 'keep@me.com', 'existing rows preserved');
    old.exec(fs.readFileSync(path.join(dir, files[0]), 'utf8')); // 0001 must be re-runnable
    pass('schema.sql + 4 migrations verified on real SQLite (existing data kept, 0001 re-runnable).');
  }

  // ---- 2. TMDB key ------------------------------------------------------------
  console.log('[Test 2] TMDB: no hard-coded key; clear 500 when TMDB_API_KEY missing...');
  {
    assert.equal(WORKER_SRC.includes('8265bd1679663a7ea12ac168da84d2e8'), false, 'old fallback key must be gone from worker.js');
    const { db, env } = newEnv();
    const acct = await makeAccount(env, db, 'tmdb@test.com');
    const missing = await call(env, 'GET', '/api/tmdb/movie/1', { token: acct.token });
    assert.equal(missing.status, 500);
    assert.match(missing.json.error, /TMDB_API_KEY is not configured/);
    const ok = await call({ ...env, TMDB_API_KEY: 'test-key' }, 'GET', '/api/tmdb/movie/1', { token: acct.token });
    assert.equal(ok.status, 200, 'works once the secret is configured');
    pass('No fallback key in source; missing secret gives a clear HTTP 500; configured secret proxies.');
  }

  // ---- 3. sender default ------------------------------------------------------
  console.log('[Test 3] Default email sender is noreply@tv.truehats.com / "StreamVault TV"...');
  {
    const { db, env } = newEnv();
    emails.length = 0;
    await makeAccount(env, db, 'sender@test.com');
    assert.equal(emails[0].sender.email, 'noreply@tv.truehats.com');
    assert.equal(emails[0].sender.name, 'StreamVault TV');
    const env2 = { ...env, BREVO_SENDER_EMAIL: 'x@y.com', BREVO_SENDER_NAME: 'Custom' };
    emails.length = 0;
    await call(env2, 'POST', '/api/auth/signup', { body: { email: 'sender2@test.com', password: 'AccountPass123!' } });
    assert.deepEqual(emails[0].sender, { name: 'Custom', email: 'x@y.com' }, 'env override still works');
    pass('Sender default and env override verified.');
  }

  // ---- 4. request-pin-reset (verified accounts) -------------------------------
  console.log('[Test 4] request-pin-reset: verified accounts get a code; rules and limits enforced...');
  let ctx;
  {
    const { db, env } = newEnv();
    const acct = await makeAccount(env, db, 'owner@test.com');
    ctx = { db, env, acct };

    // unauthenticated -> 401 (no public route)
    const anon = await call(env, 'POST', '/api/account/request-pin-reset', { body: { email: 'owner@test.com' } });
    assert.equal(anon.status, 401, 'must require a signed-in session');
    const anonReset = await call(env, 'POST', '/api/account/reset-pin', { body: { email: 'owner@test.com', password: 'AccountPass123!', newPin: '1234' } });
    assert.equal(anonReset.status, 401, 'reset-pin must no longer be reachable without a session');

    // the old blocker: resend-code refuses verified accounts (unchanged), new route works
    const resend = await call(env, 'POST', '/api/auth/resend-code', { body: { email: 'owner@test.com' } });
    assert.equal(resend.status, 400);

    emails.length = 0;
    const r1 = await call(env, 'POST', '/api/account/request-pin-reset', { token: acct.token, body: {} });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.json.sentTo, 'o***@test.com');
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, 'owner@test.com', 'code goes to the account email only');
    assert.match(emails[0].subject, /^\d{6} is your StreamVault TV PIN reset code$/);
    const row = db.sqlite.prepare("SELECT purpose, attempts FROM email_codes WHERE email='owner@test.com' AND purpose='reset_pin'").get();
    assert.ok(row, 'stored with purpose reset_pin');

    // caller cannot redirect the code to another address
    emails.length = 0;
    await call(env, 'POST', '/api/account/request-pin-reset', { token: acct.token, body: { email: 'victim@else.com' } });
    assert.equal(emails.every(e => e.to === 'owner@test.com'), true, 'body email ignored');

    // a reset code is NOT a sign-in code
    const code = db.sqlite.prepare("SELECT code FROM email_codes WHERE purpose='reset_pin' AND is_used=0").get().code;
    const asLogin = await call(env, 'POST', '/api/auth/verify-code', { body: { email: 'owner@test.com', code } });
    assert.equal(asLogin.status, 401, 'reset code must be rejected by verify-code');

    // only one live reset code at a time
    const live = db.sqlite.prepare("SELECT COUNT(*) AS n FROM email_codes WHERE purpose='reset_pin' AND is_used=0").get().n;
    assert.equal(live, 1, 'older reset codes are invalidated');

    // rate limit: 3 per minute per account (2 used above + this one), 4th blocked
    const r3 = await call(env, 'POST', '/api/account/request-pin-reset', { token: acct.token, body: {} });
    assert.equal(r3.status, 200);
    const r4 = await call(env, 'POST', '/api/account/request-pin-reset', { token: acct.token, body: {} });
    assert.equal(r4.status, 429, 'per-account limit kicks in');
    assert.match(r4.json.error, /Too many reset-code requests/);

    // per-IP limit: 5/min from one IP across accounts
    clearLimits(db);
    const ip = '203.0.113.7';
    const extra = [];
    for (let i = 0; i < 6; i++) extra.push(await makeAccount(env, db, `ipacct${i}@test.com`));
    clearLimits(db);
    let last;
    for (let i = 0; i < 6; i++) last = await call(env, 'POST', '/api/account/request-pin-reset', { token: extra[i].token, body: {}, ip });
    assert.equal(last.status, 429, '6th request from one IP is blocked');
    assert.match(last.json.error, /Too many requests/);

    // unverified account cannot request a reset code
    clearLimits(db);
    const su = await call(env, 'POST', '/api/auth/signup', { body: { email: 'unver@test.com', password: 'AccountPass123!' } });
    assert.equal(su.status, 201);
    const unverToken = 'f'.repeat(64);
    const accId = db.sqlite.prepare("SELECT account_id FROM accounts WHERE email='unver@test.com'").get().account_id;
    db.sqlite.prepare('INSERT INTO sessions (session_id, account_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
      .run('s_unver', accId, crypto.createHash('sha256').update(unverToken).digest('hex'), Date.now() + 1e6, Date.now());
    const un = await call(env, 'POST', '/api/account/request-pin-reset', { token: unverToken, body: {} });
    assert.equal(un.status, 401);
    pass('request-pin-reset: verified session required, code only to own email, purpose-isolated, single live code, per-IP + per-account limits, unverified refused.');
  }

  // ---- 5. reset-pin with the emailed code: attempts counted & locked ----------
  console.log('[Test 5] reset-pin: failed code attempts are counted; code locks after 5; new code works...');
  {
    const { db, env, acct } = ctx;
    clearLimits(db);
    db.sqlite.exec("UPDATE email_codes SET is_used = 1 WHERE purpose = 'reset_pin'");
    const req = await call(env, 'POST', '/api/account/request-pin-reset', { token: acct.token, body: {} });
    const good = req.json.devCode;
    const bad = good === '000000' ? '111111' : '000000';

    for (let i = 1; i <= 5; i++) {
      const r = await call(env, 'POST', '/api/account/reset-pin', { token: acct.token, body: { code: bad, newPin: '4321' } });
      assert.equal(r.status, 401, `wrong code #${i} -> 401`);
    }
    const attempts = db.sqlite.prepare("SELECT attempts FROM email_codes WHERE code = ? AND purpose='reset_pin'").get(good).attempts;
    assert.equal(attempts, 5, 'every failed attempt is counted in the database');

    // minute rate limit now blocks further guesses outright (per-account 5/min)
    const rl = await call(env, 'POST', '/api/account/reset-pin', { token: acct.token, body: { code: bad, newPin: '4321' } });
    assert.equal(rl.status, 429);
    assert.match(rl.json.error, /Too many PIN reset attempts/);

    // even after the minute passes, the burned code is dead - the CORRECT code is refused too
    clearLimits(db);
    const dead = await call(env, 'POST', '/api/account/reset-pin', { token: acct.token, body: { code: good, newPin: '4321' } });
    assert.equal(dead.status, 429, 'locked code refuses even the correct value');
    assert.match(dead.json.error, /request a new code/i);
    assert.equal(db.sqlite.prepare('SELECT pin_hash FROM accounts WHERE account_id = ?').get(acct.accountId).pin_hash, null, 'PIN untouched');

    // a fresh code works
    clearLimits(db);
    const req2 = await call(env, 'POST', '/api/account/request-pin-reset', { token: acct.token, body: {} });
    const ok = await call(env, 'POST', '/api/account/reset-pin', { token: acct.token, body: { code: req2.json.devCode, newPin: '4321' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));

    // stored in the SAME format the TV app uses (SHA-256 of "pin:salt") and single use
    const row = db.sqlite.prepare('SELECT pin_hash, pin_salt FROM accounts WHERE account_id = ?').get(acct.accountId);
    assert.ok(row.pin_salt, 'salt stored');
    assert.equal(row.pin_hash, nativeHash('4321', row.pin_salt), 'hash matches the native scheme');
    clearLimits(db);
    const again = await call(env, 'POST', '/api/account/reset-pin', { token: acct.token, body: { code: req2.json.devCode, newPin: '9999' } });
    assert.equal(again.status, 401, 'a used code cannot be reused');
    assert.equal(db.sqlite.prepare('SELECT pin_hash FROM accounts WHERE account_id = ?').get(acct.accountId).pin_hash, row.pin_hash, 'PIN unchanged');
    pass('Failed code attempts counted (5 max), locked code refuses even the right value, fresh code works, hash matches native format, single use.');
  }

  // ---- 6. reset-pin with password: limits & lockout ---------------------------
  console.log('[Test 6] reset-pin by password: per-email and per-IP limits, hourly wrong-password lock...');
  {
    const { db, env } = newEnv();
    const a = await makeAccount(env, db, 'pw@test.com');

    // wrong newPin format is rejected before any proof
    const badPin = await call(env, 'POST', '/api/account/reset-pin', { token: a.token, body: { password: a.password, newPin: '12' } });
    assert.equal(badPin.status, 400);
    clearLimits(db); // the request above (correctly) used up one of the 5 allowed attempts

    // per-email: 5/min, 6th blocked even from a different IP
    for (let i = 1; i <= 5; i++) {
      const r = await call(env, 'POST', '/api/account/reset-pin', { token: a.token, body: { password: 'WrongPassword!', newPin: '4321' } });
      assert.equal(r.status, 403, `wrong password #${i}`);
    }
    const blocked = await call(env, 'POST', '/api/account/reset-pin', { token: a.token, body: { password: 'WrongPassword!', newPin: '4321' }, ip: '198.51.100.99' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.json.error, /Too many PIN reset attempts for this account/);

    // hourly wrong-password lock: 10 failures, then even the right password is refused; email code still available
    for (let round = 0; round < 1; round++) {
      clearLimits(db);
      db.sqlite.prepare("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)")
        .run(`fail:resetpin:${a.accountId}`, 10, Date.now() + 3600e3);
      const locked = await call(env, 'POST', '/api/account/reset-pin', { token: a.token, body: { password: a.password, newPin: '4321' } });
      assert.equal(locked.status, 429, 'locked after 10 wrong passwords');
      const rq = await call(env, 'POST', '/api/account/request-pin-reset', { token: a.token, body: {} });
      const viaCode = await call(env, 'POST', '/api/account/reset-pin', { token: a.token, body: { code: rq.json.devCode, newPin: '4321' } });
      assert.equal(viaCode.status, 200, 'email code path still works during password lock');
    }

    // correct password works
    const { db: db2, env: env2 } = newEnv();
    const b = await makeAccount(env2, db2, 'pw2@test.com');
    const okPw = await call(env2, 'POST', '/api/account/reset-pin', { token: b.token, body: { password: b.password, newPin: '2468' } });
    assert.equal(okPw.status, 200);

    // per-IP: 8/min across different accounts
    const ip = '198.51.100.50';
    const accts = [];
    for (let i = 0; i < 9; i++) accts.push(await makeAccount(env2, db2, `ipr${i}@test.com`));
    clearLimits(db2);
    let last;
    for (let i = 0; i < 9; i++) last = await call(env2, 'POST', '/api/account/reset-pin', { token: accts[i].token, body: { password: 'nope', newPin: '1111' }, ip });
    assert.equal(last.status, 429);
    assert.match(last.json.error, /Too many PIN reset attempts\. Please wait/);
    pass('reset-pin password path: per-email, per-IP and hourly-failure limits enforced; code path stays available.');
  }

  // ---- 7. /api/account/pin re-auth -------------------------------------------
  console.log('[Test 7] /api/account/pin: first PIN allowed; changing needs current PIN or password...');
  {
    const { db, env } = newEnv();
    const a = await makeAccount(env, db, 'sync@test.com');
    const saltA = crypto.randomUUID();
    const hashA = nativeHash('1111', saltA);

    // malformed input
    const bad = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: 'abc', pinSalt: saltA } });
    assert.equal(bad.status, 400);

    // first PIN: no proof needed
    const first = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashA, pinSalt: saltA } });
    assert.equal(first.status, 200, JSON.stringify(first.json));

    // overwrite with no proof -> refused, PIN unchanged
    const saltB = crypto.randomUUID();
    const hashB = nativeHash('2222', saltB);
    const noProof = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashB, pinSalt: saltB } });
    assert.equal(noProof.status, 403);
    assert.equal(noProof.json.requireReauth, true);
    let row = db.sqlite.prepare('SELECT pin_hash FROM accounts WHERE account_id = ?').get(a.accountId);
    assert.equal(row.pin_hash, hashA, 'a bare session cannot overwrite the PIN');

    // wrong current PIN -> refused
    const wrong = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashB, pinSalt: saltB, currentPin: '9999' } });
    assert.equal(wrong.status, 403);
    // wrong password -> refused
    const wrongPw = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashB, pinSalt: saltB, password: 'nope' } });
    assert.equal(wrongPw.status, 403);
    assert.equal(db.sqlite.prepare('SELECT pin_hash FROM accounts WHERE account_id = ?').get(a.accountId).pin_hash, hashA);

    // correct current PIN -> changed
    const okPin = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashB, pinSalt: saltB, currentPin: '1111' } });
    assert.equal(okPin.status, 200, JSON.stringify(okPin.json));
    row = db.sqlite.prepare('SELECT pin_hash, pin_salt FROM accounts WHERE account_id = ?').get(a.accountId);
    assert.equal(row.pin_hash, hashB);
    assert.equal(row.pin_salt, saltB);

    // correct account password also works
    const saltC = crypto.randomUUID();
    const hashC = nativeHash('3333', saltC);
    const okPw = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashC, pinSalt: saltC, password: a.password } });
    assert.equal(okPw.status, 200);

    // lockout: 5 wrong proofs -> 429, even the right PIN is refused afterwards
    clearLimits(db);
    for (let i = 0; i < 5; i++) {
      const r = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashA, pinSalt: saltA, currentPin: '0000' } });
      assert.equal(r.status, 403);
    }
    const locked = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hashA, pinSalt: saltA, currentPin: '3333' } });
    assert.equal(locked.status, 429);
    assert.match(locked.json.error, /Too many incorrect attempts/);
    assert.equal(db.sqlite.prepare('SELECT pin_hash FROM accounts WHERE account_id = ?').get(a.accountId).pin_hash, hashC, 'PIN untouched while locked');

    // per-IP limit (10/min)
    clearLimits(db);
    const ip = '192.0.2.44';
    let lastIp;
    for (let i = 0; i < 11; i++) lastIp = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: 'x' }, ip });
    assert.equal(lastIp.status, 429);
    pass('PIN overwrite needs current PIN or account password; wrong proofs counted and locked; per-IP limit applies.');
  }

  // ---- 8. second TV: hash + salt come back and verify -------------------------
  console.log('[Test 8] Second TV: login returns pinHash + pinSalt and the PIN verifies there...');
  {
    const { db, env } = newEnv();
    const a = await makeAccount(env, db, 'tv2@test.com');
    const salt = crypto.randomUUID();
    const hash = nativeHash('7531', salt);
    await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: hash, pinSalt: salt } });
    clearLimits(db);

    const login = await call(env, 'POST', '/api/auth/login', { body: { email: a.email, password: a.password } });
    assert.equal(login.status, 200);
    assert.equal(login.json.pinHash, hash);
    assert.equal(login.json.pinSalt, salt, 'salt must travel with the hash');
    // what the second TV does (SHA-256 of pin:salt) must equal the restored hash
    assert.equal(nativeHash('7531', login.json.pinSalt), login.json.pinHash, 'correct PIN verifies on the second TV');
    assert.notEqual(nativeHash('7532', login.json.pinSalt), login.json.pinHash, 'wrong PIN does not');

    // /api/auth/me never leaks the hash to a bare session
    const me = await call(env, 'GET', '/api/auth/me', { token: login.json.token });
    assert.equal(JSON.stringify(me.json).includes(hash), false, '/api/auth/me must not expose the PIN hash');
    pass('Login restores hash + salt; PIN verifies on a second device; /api/auth/me does not leak it.');
  }

  // ---- 9. fail-closed when the limiter table is missing ----------
  console.log('[Test 9] If rate_limits is missing: auth & PIN routes fail CLOSED (503)...');
  {
    const { db, env } = newEnv();
    const a = await makeAccount(env, db, 'broken@test.com');
    db.sqlite.exec('DROP TABLE rate_limits');
    const s1 = await call(env, 'POST', '/api/account/reset-pin', { token: a.token, body: { password: a.password, newPin: '4321' } });
    assert.equal(s1.status, 503, 'reset-pin refuses rather than allow unlimited guessing');
    const s2 = await call(env, 'POST', '/api/account/pin', { token: a.token, body: { pinHash: 'a'.repeat(64), pinSalt: crypto.randomUUID() } });
    assert.equal(s2.status, 503);
    const s3 = await call(env, 'POST', '/api/account/request-pin-reset', { token: a.token, body: {} });
    assert.equal(s3.status, 503);
    const login = await call(env, 'POST', '/api/auth/login', { body: { email: a.email, password: a.password } });
    assert.equal(login.status, 503, 'login also fails closed (503) when rate_limits is broken');
    pass('Missing rate_limits fails closed loudly across PIN and auth routes (503).');
  }

  // ---- 10. verification codes are still 6 digits and verify flow intact -------
  console.log('[Test 10] Sign-up codes: 6 digits, crypto-generated, flow intact...');
  {
    assert.equal(/Math\.random/.test(WORKER_SRC), false, 'worker must not use Math.random for codes');
    const { db, env } = newEnv();
    for (let i = 0; i < 20; i++) {
      const s = await call(env, 'POST', '/api/auth/signup', { body: { email: `c${i}@test.com`, password: 'AccountPass123!' } });
      assert.match(s.json.devCode, /^[1-9]\d{5}$/);
    }
    pass('Codes are 6-digit, from the crypto RNG; no Math.random left in the Worker.');
  }

  console.log('====================================================');
  console.log(`  ALL ROUND 2 ASSERTIONS PASSED (${passed}/10)`);
  console.log('====================================================');
}

run().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
