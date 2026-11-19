import assert from 'node:assert/strict';
import worker from '../cloud-sync/src/worker.js';

// Simple in-memory SQLite/D1 mock for Cloudflare D1
function createMockD1() {
  const tables = {
    accounts: [],
    email_codes: [],
    sessions: [],
    profiles: [],
    rate_limits: [],
    playlists: []
  };

  return {
    tables,
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args) {
          return {
            async first() {
              if (normalized.includes('FROM accounts WHERE email =')) {
                const email = args[0];
                return tables.accounts.find(u => u.email === email) || null;
              }
              if (normalized.includes('FROM accounts WHERE account_id =')) {
                const id = args[0];
                return tables.accounts.find(u => u.account_id === id) || null;
              }
              if (normalized.startsWith('INSERT INTO rate_limits')) {
                const [key, resetAt, now] = [args[0], args[1], args[2]];
                const existing = tables.rate_limits.find(r => r.key === key);
                if (!existing) {
                  tables.rate_limits.push({ key, count: 1, reset_at: resetAt });
                  return { count: 1 };
                }
                if (existing.reset_at < now) {
                  existing.count = 1;
                  existing.reset_at = resetAt;
                } else {
                  existing.count++;
                }
                return { count: existing.count };
              }
              if (normalized.includes('FROM email_codes WHERE email =')) {
                const email = args[0];
                if (normalized.includes('AND code =')) {
                  return tables.email_codes.find(c => c.email === email && c.code === args[1] && !c.is_used) || null;
                }
                const matches = tables.email_codes.filter(c => c.email === email && !c.is_used && c.purpose === 'verify_email');
                return matches.length ? matches[matches.length - 1] : null;
              }
              if (normalized.includes('FROM rate_limits WHERE key =')) {
                const key = args[0];
                return tables.rate_limits.find(r => r.key === key) || null;
              }
              if (normalized.includes('FROM sessions s') && normalized.includes('token_hash =')) {
                const tokenHash = args[0];
                const s = tables.sessions.find(x => x.token_hash === tokenHash);
                if (!s) return null;
                const a = tables.accounts.find(x => x.account_id === s.account_id);
                return a ? { session_id: s.session_id, account_id: a.account_id, expires_at: s.expires_at, email: a.email, is_verified: a.is_verified } : null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (normalized.startsWith('INSERT INTO rate_limits')) {
                const [key, resetAt] = [args[0], args[1]];
                const existing = tables.rate_limits.find(r => r.key === key);
                if (existing) {
                  existing.count = 1;
                  existing.reset_at = resetAt;
                } else {
                  tables.rate_limits.push({ key, count: 1, reset_at: resetAt });
                }
              } else if (normalized.startsWith('UPDATE rate_limits SET count = count + 1 WHERE key =')) {
                const key = args[0];
                const existing = tables.rate_limits.find(r => r.key === key);
                if (existing) existing.count++;
              } else if (normalized.startsWith('UPDATE accounts SET pin_hash =')) {
                const [pinHash, pinSalt, updatedAt, accountId] = args;
                const a = tables.accounts.find(x => x.account_id === accountId);
                if (a) { a.pin_hash = pinHash; a.pin_salt = pinSalt; a.updated_at = updatedAt; }
              } else if (normalized.startsWith('INSERT INTO playlists')) {
                tables.playlists.push({
                  playlist_id: args[0],
                  account_id: args[1],
                  name: args[2],
                  server_url: args[3],
                  username: args[4],
                  password_enc: args[5]
                });
              } else if (normalized.startsWith('INSERT INTO accounts')) {
                tables.accounts.push({
                  account_id: args[0],
                  email: args[1],
                  password_hash: args[2],
                  salt: args[3],
                  display_name: args[4],
                  is_verified: args[5],
                  created_at: args[6],
                  updated_at: args[7]
                });
              } else if (normalized.startsWith('INSERT INTO email_codes')) {
                tables.email_codes.push({
                  code_id: args[0],
                  email: args[1],
                  code: args[2],
                  purpose: 'verify_email',
                  attempts: 0,
                  is_used: 0,
                  expires_at: args[3],
                  created_at: args[4]
                });
              } else if (normalized.startsWith('INSERT INTO sessions')) {
                tables.sessions.push({
                  session_id: args[0],
                  account_id: args[1],
                  token_hash: args[2],
                  expires_at: args[3],
                  created_at: args[4]
                });
              } else if (normalized.startsWith('INSERT INTO profiles')) {
                tables.profiles.push({
                  profile_id: args[0],
                  account_id: args[1],
                  display_name: args[2]
                });
              } else if (normalized.startsWith('UPDATE accounts SET is_verified = 1')) {
                const acc = tables.accounts.find(u => u.email === args[1]);
                if (acc) acc.is_verified = 1;
              } else if (normalized.startsWith('DELETE FROM sessions WHERE account_id =')) {
                for (let i = tables.sessions.length - 1; i >= 0; i--) {
                  if (tables.sessions[i].account_id === args[0]) tables.sessions.splice(i, 1);
                }
              } else if (normalized.startsWith('UPDATE email_codes SET attempts = attempts + 1')) {
                const c = tables.email_codes.find(x => x.code_id === args[0]);
                if (c) c.attempts = (c.attempts || 0) + 1;
              } else if (normalized.startsWith('UPDATE email_codes SET is_used = 1')) {
                if (normalized.includes('WHERE email =')) {
                  tables.email_codes.forEach(x => { if (x.email === args[0] && x.purpose === 'verify_email') x.is_used = 1; });
                } else {
                  const c = tables.email_codes.find(x => x.code_id === args[0] && !x.is_used);
                  if (c) { c.is_used = 1; return { success: true, meta: { changes: 1 } }; }
                  return { success: true, meta: { changes: 0 } };
                }
              }
              return { success: true };
            }
          };
        }
      };
    }
  };
}

async function runPhaseETests() {
  console.log('=== Running StreamVault TV — Phase E Test Suite (Auth Hardening & Brevo) ===\n');

  // --- Test 1: Production Signup NEVER returns devCode when DEV_MODE is unset ---
  console.log('[Test 1] Asserting signup NEVER returns devCode when DEV_MODE is unset...');
  {
    const db = createMockD1();
    const env = {
      DB: db,
      // DEV_MODE is intentionally undefined (production default)
      BREVO_API_KEY: 'xkeysib-mock-test-key-1234567890'
    };

    // Mock Brevo HTTP API
    const interceptedCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      interceptedCalls.push({ url, init });
      return new Response(JSON.stringify({ messageId: '<mock-msg-id@brevo.com>' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const req = new Request('https://sync.streamvault.tv/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.1' },
        body: JSON.stringify({
          email: 'user1@streamvault.tv',
          password: 'Password123!',
          displayName: 'Test User'
        })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 201, 'Signup should succeed with 201 Created');
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.requireVerification, true);
      assert.equal(data.email, 'user1@streamvault.tv');
      assert.equal(data.devCode, undefined, 'devCode must be strictly undefined in production');
      assert.equal('devCode' in data, false, 'devCode property must not exist in response JSON');
      console.log('  ✓ PASS: devCode is strictly omitted in production response.\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- Test 2: Signup NEVER returns devCode even when email API key is completely missing ---
  console.log('[Test 2] Asserting signup NEVER returns devCode when API key is missing and DEV_MODE=false...');
  {
    const db = createMockD1();
    const env = {
      DB: db,
      DEV_MODE: 'false',
      BREVO_API_KEY: undefined,
      RESEND_API_KEY: undefined
    };

    const req = new Request('https://sync.streamvault.tv/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.2' },
      body: JSON.stringify({
        email: 'user2@streamvault.tv',
        password: 'Password123!',
        displayName: 'Test User 2'
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 201);
    const data = await res.json();

    assert.equal(data.devCode, undefined, 'devCode must remain undefined even when API key is missing');
    assert.equal('devCode' in data, false, 'devCode property must not be present in payload');
    console.log('  ✓ PASS: devCode leak is permanently closed even when worker secrets are missing.\n');
  }

  // --- Test 3: DEV_MODE=true returns devCode for testing ---
  console.log('[Test 3] Asserting signup returns devCode ONLY when DEV_MODE=true is explicitly set...');
  {
    const db = createMockD1();
    const env = {
      DB: db,
      DEV_MODE: 'true',
      BREVO_API_KEY: undefined
    };

    const req = new Request('https://sync.streamvault.tv/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.3' },
      body: JSON.stringify({
        email: 'dev@streamvault.tv',
        password: 'Password123!',
        displayName: 'Dev User'
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 201);
    const data = await res.json();

    assert.ok(data.devCode, 'devCode must be provided when DEV_MODE=true');
    assert.match(data.devCode, /^\d{6}$/, 'devCode must be a 6-digit numeric string');
    console.log(`  ✓ PASS: devCode (${data.devCode}) safely returned only when explicit DEV_MODE=true.\n`);
  }

  // --- Test 4: Brevo Transactional Email Integration & Payload Conformance ---
  console.log('[Test 4] Testing Brevo transactional email dispatch and payload structure...');
  {
    const db = createMockD1();
    const env = {
      DB: db,
      BREVO_API_KEY: 'xkeysib-9876543210-secure-key',
      BREVO_SENDER_EMAIL: 'verify@streamvault.tv',
      BREVO_SENDER_NAME: 'StreamVault TV Security'
    };

    let brevoCall = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url.includes('api.brevo.com')) {
        brevoCall = {
          url,
          method: init.method,
          headers: init.headers,
          body: JSON.parse(init.body)
        };
        return new Response(JSON.stringify({ messageId: '<test-brevo-id@streamvault.tv>' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return originalFetch(url, init);
    };

    try {
      const targetEmail = 'alex.subscriber@example.com';
      const req = new Request('https://sync.streamvault.tv/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.4' },
        body: JSON.stringify({
          email: targetEmail,
          password: 'StrongPassword99!',
          displayName: 'Alex S'
        })
      });

      const res = await worker.fetch(req, env);
      assert.equal(res.status, 201);

      // Verify Brevo HTTP call
      assert.ok(brevoCall, 'Brevo transactional email API must be called');
      assert.equal(brevoCall.url, 'https://api.brevo.com/v3/smtp/email', 'Target endpoint must be Brevo v3 SMTP API');
      assert.equal(brevoCall.method, 'POST', 'HTTP method must be POST');
      assert.equal(brevoCall.headers['api-key'], 'xkeysib-9876543210-secure-key', 'api-key header must contain Brevo secret');
      assert.equal(brevoCall.headers['Content-Type'], 'application/json');

      // Verify Brevo payload structure
      const payload = brevoCall.body;
      assert.deepEqual(payload.sender, {
        name: 'StreamVault TV Security',
        email: 'verify@streamvault.tv'
      }, 'Sender name and email match configured Brevo sender');

      assert.deepEqual(payload.to, [{ email: targetEmail }], 'Recipient array matches targeted email');
      assert.match(payload.subject, /\d{6} is your StreamVault TV verification code/, 'Subject line contains 6-digit code');
      assert.ok(payload.htmlContent.includes('StreamVault TV'), 'HTML body branded with StreamVault TV');
      assert.ok(payload.htmlContent.includes('Standalone Cloud Account Verification'), 'HTML body contains subtitle');
      assert.equal(payload.listIds, undefined, 'Must NEVER add recipients to contact lists (send-only transactional)');

      console.log('  ✓ PASS: Brevo transactional payload strictly conforms to Brevo v3 specifications.\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- Test 5: Default Brevo Sender Fallback ---
  console.log('[Test 5] Asserting Brevo defaults sender to noreply@tv.truehats.com if unspecified...');
  {
    const db = createMockD1();
    const env = {
      DB: db,
      BREVO_API_KEY: 'xkeysib-test-default-sender'
      // BREVO_SENDER_EMAIL and BREVO_SENDER_NAME left undefined
    };

    let brevoCall = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url.includes('api.brevo.com')) {
        brevoCall = { body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ messageId: '<test-default@streamvault.tv>' }), { status: 201 });
      }
      return originalFetch(url, init);
    };

    try {
      const req = new Request('https://sync.streamvault.tv/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.5' },
        body: JSON.stringify({
          email: 'default-sender@example.com',
          password: 'Password123!',
          displayName: 'Default Sender Test'
        })
      });

      await worker.fetch(req, env);
      assert.ok(brevoCall);
      assert.equal(brevoCall.body.sender.email, 'noreply@tv.truehats.com', 'Default sender email must be noreply@tv.truehats.com');
      assert.equal(brevoCall.body.sender.name, 'StreamVault TV', 'Default sender name must be StreamVault TV');
      console.log('  ✓ PASS: Brevo sender default fallback verified.\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- Test 6: Verify Code Flow after Brevo Email Dispatch ---
  console.log('[Test 6] Testing full Signup -> Brevo email dispatch -> Verify code completion...');
  {
    const db = createMockD1();
    const env = {
      DB: db,
      BREVO_API_KEY: 'xkeysib-full-flow-test',
      JWT_SECRET: 'jwt-secret-phase-e-test-1234567890'
    };

    let sentCode = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url.includes('api.brevo.com')) {
        const body = JSON.parse(init.body);
        const match = body.subject.match(/(\d{6})/);
        if (match) sentCode = match[1];
        return new Response(JSON.stringify({ messageId: '<msg-123@brevo.com>' }), { status: 201 });
      }
      return originalFetch(url, init);
    };

    try {
      // Step A: Signup
      const signupReq = new Request('https://sync.streamvault.tv/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.6' },
        body: JSON.stringify({
          email: 'verified.user@streamvault.tv',
          password: 'SecurePassword123!',
          displayName: 'Verified User'
        })
      });
      const signupRes = await worker.fetch(signupReq, env);
      assert.equal(signupRes.status, 201);
      assert.ok(sentCode, 'Verification code captured from Brevo dispatch');

      // Step B: Verify with sent code
      const verifyReq = new Request('https://sync.streamvault.tv/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'verified.user@streamvault.tv',
          code: sentCode
        })
      });
      const verifyRes = await worker.fetch(verifyReq, env);
      assert.equal(verifyRes.status, 200, 'Verification must succeed with sent code');
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.success, true);
      assert.ok(verifyData.token, 'Session token issued upon successful verification');
      assert.equal(verifyData.email, 'verified.user@streamvault.tv');

      console.log('  ✓ PASS: Full signup and verification lifecycle succeeded with Brevo code.\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- Test 7: Per-Email Rate Limiting on Signup (max 3 per min) ---
  console.log('[Test 7] Asserting per-email rate limiting on /api/auth/signup (max 3/min)...');
  {
    const db = createMockD1();
    const env = { DB: db, BREVO_API_KEY: 'xkeysib-rate-limit-test', DEV_MODE: 'true' };
    const email = 'rate_signup@streamvault.tv';

    for (let i = 1; i <= 3; i++) {
      const req = new Request('https://sync.streamvault.tv/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.168.10.${i}` },
        body: JSON.stringify({ email, password: 'Password123!', displayName: `User ${i}` })
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 201, `Attempt ${i} within limit should succeed`);
    }

    // 4th attempt from different IP but same email must be rate-limited (HTTP 429)
    const blockedReq = new Request('https://sync.streamvault.tv/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.10.99' },
      body: JSON.stringify({ email, password: 'Password123!', displayName: 'Blocked User' })
    });
    const blockedRes = await worker.fetch(blockedReq, env);
    assert.equal(blockedRes.status, 429, '4th signup for same email must return 429');
    const blockedData = await blockedRes.json();
    assert.match(blockedData.error, /Too many sign-up attempts for this email/i);
    console.log('  ✓ PASS: Per-email rate limiting on signup correctly returns HTTP 429.\n');
  }

  // --- Test 8: Per-Email Rate Limiting on Login (max 5 per min) ---
  console.log('[Test 8] Asserting per-email rate limiting on /api/auth/login (max 5/min)...');
  {
    const db = createMockD1();
    const env = { DB: db };
    const email = 'rate_login@streamvault.tv';

    for (let i = 1; i <= 5; i++) {
      const req = new Request('https://sync.streamvault.tv/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.168.20.${i}` },
        body: JSON.stringify({ email, password: 'WrongPassword!' })
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401, `Attempt ${i} should fail auth with 401`);
    }

    // 6th attempt from different IP but same email must be rate-limited (HTTP 429)
    const blockedReq = new Request('https://sync.streamvault.tv/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.20.99' },
      body: JSON.stringify({ email, password: 'WrongPassword!' })
    });
    const blockedRes = await worker.fetch(blockedReq, env);
    assert.equal(blockedRes.status, 429, '6th login attempt for same email must return 429');
    const blockedData = await blockedRes.json();
    assert.match(blockedData.error, /Too many login attempts for this email/i);
    console.log('  ✓ PASS: Per-email rate limiting on login correctly returns HTTP 429.\n');
  }

  // --- Test 9: Per-Email Rate Limiting on Verify-Code (max 5 per min) ---
  console.log('[Test 9] Asserting per-email rate limiting on /api/auth/verify-code (max 5/min)...');
  {
    const db = createMockD1();
    const env = { DB: db };
    const email = 'rate_verify@streamvault.tv';

    for (let i = 1; i <= 5; i++) {
      const req = new Request('https://sync.streamvault.tv/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.168.30.${i}` },
        body: JSON.stringify({ email, code: '000000' })
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401, `Attempt ${i} should return 401 for bad code`);
    }

    // 6th attempt from different IP but same email must be rate-limited (HTTP 429)
    const blockedReq = new Request('https://sync.streamvault.tv/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.30.99' },
      body: JSON.stringify({ email, code: '000000' })
    });
    const blockedRes = await worker.fetch(blockedReq, env);
    assert.equal(blockedRes.status, 429, '6th verify attempt for same email must return 429');
    const blockedData = await blockedRes.json();
    assert.match(blockedData.error, /Too many verification attempts for this email/i);
    console.log('  ✓ PASS: Per-email rate limiting on verify correctly returns HTTP 429.\n');
  }

  // --- Test 10: /api/auth/resend-code endpoint & rate limits ---
  console.log('[Test 10] Testing /api/auth/resend-code route and behavior...');
  {
    const db = createMockD1();
    const env = { DB: db, BREVO_API_KEY: 'xkeysib-resend-test', DEV_MODE: 'true' };
    const email = 'resend_user@streamvault.tv';

    // 10a. Non-existent account -> 404
    const notFoundReq = new Request('https://sync.streamvault.tv/api/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.40.1' },
      body: JSON.stringify({ email: 'ghost@streamvault.tv' })
    });
    const notFoundRes = await worker.fetch(notFoundReq, env);
    assert.equal(notFoundRes.status, 404, 'Resend for non-existent account must return 404');

    // Setup an unverified account in D1
    db.tables.accounts.push({
      account_id: 'acc_resend_123',
      email: email,
      password_hash: 'mockhash',
      is_verified: 0,
      created_at: Date.now(),
      updated_at: Date.now()
    });

    let resentCode = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url.includes('api.brevo.com')) {
        const body = JSON.parse(init.body);
        const match = body.subject.match(/(\d{6})/);
        if (match) resentCode = match[1];
        return new Response(JSON.stringify({ messageId: '<msg-resend@brevo.com>' }), { status: 201 });
      }
      return originalFetch(url, init);
    };

    try {
      // 10b. Successful resend
      const resendReq = new Request('https://sync.streamvault.tv/api/auth/resend-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.40.2' },
        body: JSON.stringify({ email })
      });
      const resendRes = await worker.fetch(resendReq, env);
      assert.equal(resendRes.status, 200, 'Resend should succeed with 200');
      const resendData = await resendRes.json();
      assert.equal(resendData.success, true);
      assert.ok(resentCode, 'New code was emailed via Brevo');
      assert.equal(resendData.devCode, resentCode, 'devCode returned in DEV_MODE');

      // 10c. Per-email rate limit on resend (max 3/min)
      for (let i = 2; i <= 3; i++) {
        const rReq = new Request('https://sync.streamvault.tv/api/auth/resend-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.168.40.${i + 2}` },
          body: JSON.stringify({ email })
        });
        const rRes = await worker.fetch(rReq, env);
        assert.equal(rRes.status, 200);
      }

      // 4th resend must return 429
      const blockedResendReq = new Request('https://sync.streamvault.tv/api/auth/resend-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.40.99' },
        body: JSON.stringify({ email })
      });
      const blockedResendRes = await worker.fetch(blockedResendReq, env);
      assert.equal(blockedResendRes.status, 429, '4th resend must return 429');
      const blockedResendData = await blockedResendRes.json();
      assert.match(blockedResendData.error, /Too many resend attempts for this email/i);

      // 10d. Already verified account -> 400
      const verifiedEmail = 'already.verified@streamvault.tv';
      db.tables.accounts.push({
        account_id: 'acc_verified_123',
        email: verifiedEmail,
        password_hash: 'mockhash',
        is_verified: 1,
        created_at: Date.now(),
        updated_at: Date.now()
      });
      const verifiedReq = new Request('https://sync.streamvault.tv/api/auth/resend-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.168.40.80' },
        body: JSON.stringify({ email: verifiedEmail })
      });
      const verifiedRes = await worker.fetch(verifiedReq, env);
      assert.equal(verifiedRes.status, 400);
      const verifiedData = await verifiedRes.json();
      assert.match(verifiedData.error, /already verified/i);

      console.log('  ✓ PASS: /api/auth/resend-code route and per-email rate limiting verified.\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- Test 11: /api/probe-versions Implementation & Contract in AppApiRouter.kt ---
  console.log('[Test 11] Verifying /api/probe-versions implementation and logic in AppApiRouter.kt...');
  {
    const fs = await import('node:fs/promises');
    const routerSource = await fs.readFile('app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt', 'utf-8');

    assert.ok(
      routerSource.includes('method == "GET" && path == "/api/probe-versions" -> handleProbeVersions(queryParams)'),
      'AppApiRouter must route /api/probe-versions to handleProbeVersions'
    );
    assert.ok(
      routerSource.includes('fun handleProbeVersions') || routerSource.includes('private fun handleProbeVersions'),
      'AppApiRouter must implement handleProbeVersions'
    );
    assert.ok(
      routerSource.includes('Range') && routerSource.includes('bytes=0-10'),
      'AppApiRouter must use HTTP Range 0-10 for fast size probing'
    );
    assert.ok(
      routerSource.includes('rawTitleMatchesCam'),
      'AppApiRouter must detect CAM rips'
    );
    assert.ok(
      routerSource.includes('formatBytes'),
      'AppApiRouter must format probed byte sizes to human-readable strings'
    );
    console.log('  ✓ PASS: /api/probe-versions correctly implemented in native AppApiRouter.kt.\n');
  }

  // --- Test 12: Jetpack Compose Cleanup & Dependency Elimination ---
  console.log('[Test 12] Verifying removal of unused Jetpack Compose files and dependencies...');
  {
    const fs = await import('node:fs/promises');

    // 12a. Assert legacy Compose UI files are deleted
    let playerScreenExists = true;
    let tvAppExists = true;
    try {
      await fs.access('app/src/main/java/com/streamvault/tv/ui/StreamVaultPlayerScreen.kt');
    } catch {
      playerScreenExists = false;
    }
    try {
      await fs.access('app/src/main/java/com/streamvault/tv/ui/StreamVaultTvApp.kt');
    } catch {
      tvAppExists = false;
    }

    assert.equal(playerScreenExists, false, 'StreamVaultPlayerScreen.kt must be deleted');
    assert.equal(tvAppExists, false, 'StreamVaultTvApp.kt must be deleted');

    // 12b. Assert app/build.gradle.kts has no compose features or dependencies
    const gradleKts = await fs.readFile('app/build.gradle.kts', 'utf-8');
    assert.equal(gradleKts.includes('compose = true'), false, 'compose = true must be removed');
    assert.equal(gradleKts.includes('composeOptions'), false, 'composeOptions block must be removed');
    assert.equal(gradleKts.includes('androidx.compose'), false, 'androidx.compose dependencies must be removed');
    assert.equal(gradleKts.includes('coil-compose'), false, 'coil-compose must be replaced with standard coil');
    assert.ok(gradleKts.includes('io.coil-kt:coil:2.6.0'), 'Standard coil must be included');

    console.log('  ✓ PASS: Compose files deleted and dependencies cleanly purged from app/build.gradle.kts.\n');
  }

  // --- Test 13: Worker AES_SECRET Enforcement & PIN Management ---
  console.log('[Test 13] Verifying Worker AES_SECRET 500 rejection and PIN reset via account auth...');
  {
    const db = createMockD1();
    const crypto = globalThis.crypto;
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const rawToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const tokenBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const tokenHash = Array.from(new Uint8Array(tokenBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    // PBKDF2 hash for password "AccountPass123!"
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const saltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode('AccountPass123!'), { name: 'PBKDF2' }, false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
    const hashHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
    const passHash = `pbkdf2:100000:${saltHex}:${hashHex}`;

    db.tables.accounts.push({
      account_id: 'acc_sec_test',
      email: 'sec_test@streamvault.tv',
      password_hash: passHash,
      is_verified: 1,
      pin_hash: null,
      created_at: Date.now(),
      updated_at: Date.now()
    });

    db.tables.sessions.push({
      session_id: 'sess_1',
      account_id: 'acc_sec_test',
      token_hash: tokenHash,
      expires_at: Date.now() + 86400000,
      created_at: Date.now()
    });

    // 13a. Attempt to add playlist WITHOUT AES_SECRET in env -> Must return 500 and store nothing!
    const envNoSecret = { DB: db };
    const addReqNoSecret = new Request('https://sync.streamvault.tv/api/playlists', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + rawToken
      },
      body: JSON.stringify({
        name: 'Test Playlist',
        serverUrl: 'http://iptv.example.com',
        username: 'testuser',
        password: 'testpass'
      })
    });
    const resNoSecret = await worker.fetch(addReqNoSecret, envNoSecret);
    assert.equal(resNoSecret.status, 500, 'Adding playlist without AES_SECRET must return HTTP 500');
    assert.equal(db.tables.playlists.length, 0, 'No playlist must be stored when AES_SECRET is missing');

    // 13b. Reset PIN with wrong account password -> Must return 403
    const resetReqBad = new Request('https://sync.streamvault.tv/api/account/reset-pin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + rawToken
      },
      body: JSON.stringify({ password: 'WrongPassword!', newPin: '4321' })
    });
    const resBad = await worker.fetch(resetReqBad, envNoSecret);
    assert.equal(resBad.status, 403, 'Reset PIN with wrong password must return 403');

    // 13c. Reset PIN with valid account password -> Must return 200 and update pin_hash
    const resetReqOk = new Request('https://sync.streamvault.tv/api/account/reset-pin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + rawToken
      },
      body: JSON.stringify({ password: 'AccountPass123!', newPin: '4321' })
    });
    const resOk = await worker.fetch(resetReqOk, envNoSecret);
    assert.equal(resOk.status, 200, 'Reset PIN with verified account password must succeed');
    const acc = db.tables.accounts.find(a => a.account_id === 'acc_sec_test');
    assert.ok(acc.pin_hash, 'Account pin_hash must be updated');

    console.log('  ✓ PASS: Worker AES_SECRET 500 rejection and verified account password PIN reset enforced.\n');
  }

  console.log('====================================================');
  console.log('  ALL PHASE E ASSERTIONS PASSED (13/13)');
  console.log('====================================================');
}

runPhaseETests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
