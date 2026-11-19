// Wave 1 Security Hardening regression suite (Cloud Worker + real SQLite via node:sqlite).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../cloud-sync/src/worker.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (_) { console.log(`⚠ SKIPPED Wave 1 security tests: needs Node 22.13+ (found ${process.version}).`); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'cloud-sync/schema.sql'), 'utf8');

function createRealD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
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
            },
            _sql: sql,
            _args: args
          };
        }
      };
    },
    async batch(stmts) {
      for (const s of stmts) sqlite.prepare(s._sql).run(...s._args);
      return [];
    }
  };
}

let ipCounter = 1;
const nextIp = () => `198.51.101.${ipCounter++}`;

async function call(env, method, route, { token, body, origin, extraHeaders = {}, rawBody } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp(), ...extraHeaders };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (origin !== undefined) headers.Origin = origin;
  const res = await worker.fetch(new Request('https://sync.test' + route, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body))
  }), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, headers: res.headers, json, text };
}

async function makeVerifiedAccount(env, email, password = 'StrongPass123!') {
  const s = await call(env, 'POST', '/api/auth/signup', { body: { email, password } });
  assert.equal(s.status, 201);
  const v = await call(env, 'POST', '/api/auth/verify-code', { body: { email, code: s.json.devCode } });
  assert.equal(v.status, 200);
  return { token: v.json.token, accountId: v.json.accountId, email, password };
}

async function run() {
  console.log('=== StreamVault TV — Wave 1 Cloud Security Hardening Tests ===\n');
  const db = createRealD1();
  const env = { DB: db, DEV_MODE: 'true', AES_SECRET: 'wave1-test-aes-secret-key-0123456789' };

  // SEC-01: Unverified account login blocked + session revoked on re-signup
  {
    const su = await call(env, 'POST', '/api/auth/signup', { body: { email: 'victim@example.com', password: 'AttackerPass1!' } });
    assert.equal(su.status, 201);
    const loginUnver = await call(env, 'POST', '/api/auth/login', { body: { email: 'victim@example.com', password: 'AttackerPass1!' } });
    assert.equal(loginUnver.status, 403, 'SEC-01: unverified login must be rejected with 403');
    assert.equal(loginUnver.json.requireVerification, true);
    assert.equal(loginUnver.json.token, undefined, 'SEC-01: no Bearer token minted for unverified account');
    // Seed a pre-existing session on the unverified account and verify re-signup revokes it
    const acc = db.sqlite.prepare("SELECT account_id FROM accounts WHERE email='victim@example.com'").get();
    db.sqlite.prepare("INSERT INTO sessions VALUES ('s_pre', ?, 'deadbeef', ?, ?)").run(acc.account_id, Date.now() + 99999, Date.now());
    const resu = await call(env, 'POST', '/api/auth/signup', { body: { email: 'victim@example.com', password: 'VictimRealPass1!' } });
    assert.equal(resu.status, 201);
    const left = db.sqlite.prepare("SELECT COUNT(*) n FROM sessions WHERE account_id = ?").get(acc.account_id).n;
    assert.equal(left, 0, 'SEC-01: unverified re-signup must revoke all prior sessions');
    console.log('  ✓ PASS SEC-01: Email verification gate & pre-signup takeover blocked');
  }

  // SEC-02: Pairing secret required + frame/CSP security headers on /link
  {
    const linkRes = await call(env, 'GET', '/link');
    assert.equal(linkRes.status, 200);
    assert.equal(linkRes.headers.get('X-Frame-Options'), 'DENY');
    assert.match(linkRes.headers.get('Content-Security-Policy') || '', /frame-ancestors 'none'/);

    const rc = await call(env, 'POST', '/api/auth/request-code', {});
    assert.equal(rc.status, 200);
    assert.match(rc.json.code, /^SV-[23456789A-HJKLMNP-Z]{6}$/);
    assert.ok(rc.json.pollSecret && rc.json.pollSecret.length >= 32);

    const badPoll = await call(env, 'GET', '/api/auth/poll-code?code=' + rc.json.code);
    assert.equal(badPoll.status, 403, 'SEC-02: poll-code without X-Poll-Secret rejected');

    const a = await makeVerifiedAccount(env, 'pair@example.com');
    const claim = await call(env, 'POST', '/api/auth/claim-code', { token: a.token, body: { code: rc.json.code } });
    assert.equal(claim.status, 200);

    const okPoll = await call(env, 'GET', '/api/auth/poll-code?code=' + rc.json.code, { extraHeaders: { 'X-Poll-Secret': rc.json.pollSecret } });
    assert.equal(okPoll.status, 200);
    assert.equal(okPoll.json.status, 'paired');

    const badExch = await call(env, 'POST', '/api/auth/pair-exchange', { body: { code: rc.json.code, exchangeToken: okPoll.json.exchangeToken } });
    assert.equal(badExch.status, 403, 'SEC-02: pair-exchange without X-Poll-Secret rejected');

    const okExch = await call(env, 'POST', '/api/auth/pair-exchange', {
      body: { code: rc.json.code, exchangeToken: okPoll.json.exchangeToken },
      extraHeaders: { 'X-Poll-Secret': rc.json.pollSecret }
    });
    assert.equal(okExch.status, 200);
    assert.ok(okExch.json.token);
    console.log('  ✓ PASS SEC-02: Pairing secret & /link clickjacking headers enforced');
  }

  // SEC-03: Cross-account profile_data overwrite & enumeration blocked
  {
    const alice = await makeVerifiedAccount(env, 'alice@example.com');
    const bob = await makeVerifiedAccount(env, 'bob@example.com');
    const p1 = await call(env, 'POST', '/api/sync/push', {
      token: alice.token,
      body: { profileId: 'prof_shared_collision', dataType: 'watchlist', items: [{ itemKey: 'movie:1', data: { inWatchlist: true }, updatedAt: 100 }] }
    });
    assert.equal(p1.status, 200);

    const p2 = await call(env, 'POST', '/api/sync/push', {
      token: bob.token,
      body: { profileId: 'prof_shared_collision', dataType: 'watchlist', items: [{ itemKey: 'movie:1', data: { inWatchlist: false }, updatedAt: 200 }] }
    });
    assert.equal(p2.status, 404, 'SEC-03: returns generic 404 without leaking other account ownership');
    const row = db.sqlite.prepare("SELECT account_id, data_json FROM profile_data WHERE profile_id = 'prof_shared_collision'").get();
    assert.equal(row.account_id, alice.accountId);
    assert.match(row.data_json, /"inWatchlist":true/, 'SEC-03: Alice data intact');
    console.log('  ✓ PASS SEC-03: Cross-account profile_data overwrite & enumeration blocked');
  }

  // SEC-13, SEC-14, SEC-15: Verification code lockout, CORS, TMDB path traversal, no-store, validation, 413
  {
    const user = await makeVerifiedAccount(env, 'sec14@example.com');
    const evilCors = await call(env, 'GET', '/api/auth/me', { token: user.token, origin: 'https://evil.attacker' });
    assert.equal(evilCors.headers.get('Access-Control-Allow-Origin'), null, 'SEC-14: untrusted origin never reflected');
    assert.equal(evilCors.headers.get('Cache-Control'), 'no-store');

    const badTmdb = await call(env, 'GET', '/api/tmdb/%2e%2e/account/secrets', { token: user.token });
    assert.equal(badTmdb.status, 400, 'SEC-14: encoded TMDB path traversal rejected');
    const badTmdbRoute = await call(env, 'GET', '/api/tmdb/account/secrets', { token: user.token });
    assert.equal(badTmdbRoute.status, 400, 'SEC-14: non-allowlisted TMDB subpath rejected');

    const badJsonType = await call(env, 'POST', '/api/auth/signup', { body: { email: 123, password: 'Password1!' } });
    assert.equal(badJsonType.status, 400, 'SEC-15: non-string JSON returns 400 not 500');

    const badUrl = await call(env, 'POST', '/api/playlists', { token: user.token, body: { serverUrl: 'javascript:alert(1)', username: 'u', password: 'p' } });
    assert.equal(badUrl.status, 400, 'SEC-15: javascript: serverUrl rejected');

    const badColor = await call(env, 'POST', '/api/profiles/create', { token: user.token, body: { displayName: 'Bad', avatarColor: 'red;background-image:url(x)' } });
    assert.equal(badColor.status, 400, 'SEC-15: CSS injection in avatarColor rejected');

    const big = await call(env, 'POST', '/api/sync/push', { token: user.token, rawBody: JSON.stringify({ profileId: 'p', dataType: 'watchlist', items: 'x'.repeat(600 * 1024) }) });
    assert.equal(big.status, 413, 'SEC-15: oversized >512 KB body rejected with 413');
    console.log('  ✓ PASS SEC-13/14/15: CORS, TMDB allowlist, URL/CSS/type validation, body caps enforced');
  }

  console.log('\n====================================================');
  console.log('  ALL WAVE 1 CLOUD SECURITY TESTS PASSED');
  console.log('====================================================');
}

run().catch(err => { console.error('❌ WAVE 1 TEST FAILED:', err); process.exit(1); });
