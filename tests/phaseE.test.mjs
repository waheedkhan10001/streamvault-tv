import assert from 'node:assert/strict';
import worker from '../cloud-sync/src/worker.js';

// Simple in-memory SQLite/D1 mock for Cloudflare D1
function createMockD1() {
  const tables = {
    accounts: [],
    email_codes: [],
    sessions: [],
    profiles: []
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
              if (normalized.includes('FROM email_codes WHERE email =')) {
                const [email, code] = args;
                return tables.email_codes.find(c => c.email === email && c.code === code && !c.is_used) || null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (normalized.startsWith('INSERT INTO accounts')) {
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
              } else if (normalized.startsWith('UPDATE email_codes SET is_used = 1')) {
                const c = tables.email_codes.find(x => x.code_id === args[0]);
                if (c) c.is_used = 1;
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
  console.log('[Test 5] Asserting Brevo defaults sender to noreply@streamvault.tv if unspecified...');
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
      assert.equal(brevoCall.body.sender.email, 'noreply@streamvault.tv', 'Default sender email must be noreply@streamvault.tv');
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

  console.log('====================================================');
  console.log('  ALL PHASE E ASSERTIONS PASSED (6/6)');
  console.log('====================================================');
}

runPhaseETests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
