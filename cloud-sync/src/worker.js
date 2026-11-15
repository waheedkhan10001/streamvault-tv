/**
 * ====================================================================
 * StreamVault TV — Cloud Sync & Universal Account Engine
 * Cloudflare Worker + Cloudflare D1 Serverless Database
 * ====================================================================
 */

// Rate limiting via D1 table (key, count, reset_at).
// Returns 'ok' | 'limited' | 'error'. With consume=false it only looks at the
// counter and never increments it (used to check a failure counter first).
async function rateLimit(db, key, maxRequests, windowSeconds, consume = true) {
  if (!db) return 'error';
  const now = Date.now();
  try {
    const record = await db.prepare(
      `SELECT count, reset_at FROM rate_limits WHERE key = ?`
    ).bind(key).first();

    if (!record || now > record.reset_at) {
      if (!consume) return 'ok';
      const resetAt = now + windowSeconds * 1000;
      await db.prepare(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = ?`
      ).bind(key, resetAt, resetAt).run();
      return 'ok';
    }

    if (record.count >= maxRequests) {
      return 'limited';
    }

    if (consume) {
      await db.prepare(
        `UPDATE rate_limits SET count = count + 1 WHERE key = ?`
      ).bind(key).run();
    }
    return 'ok';
  } catch (err) {
    console.error('[RateLimit Error]', err);
    return 'error';
  }
}

// Standard limiter used by the sign-up / login / verify routes.
// Fails OPEN: if the rate_limits table is unavailable the request is allowed.
async function checkRateLimit(db, key, maxRequests = 15, windowSeconds = 60) {
  return (await rateLimit(db, key, maxRequests, windowSeconds)) !== 'limited';
}

// Strict limiter used on every PIN / password-guessable route.
// Fails CLOSED: if the limiter itself is broken (for example the migration was
// not run), the route refuses with 503 instead of allowing unlimited guessing.
// Returns a Response when the request must stop, or null when it may continue.
async function enforceLimit(db, key, maxRequests, windowSeconds, message, corsHeaders, consume = true) {
  const state = await rateLimit(db, key, maxRequests, windowSeconds, consume);
  if (state === 'ok') return null;
  if (state === 'limited') return errorResponse(message, 429, corsHeaders);
  return errorResponse('Service temporarily unavailable. Please try again later.', 503, corsHeaders);
}

// Counts one failed attempt against a key (starts a fresh window if needed).
async function recordFailure(db, key, windowSeconds) {
  await rateLimit(db, key, Number.MAX_SAFE_INTEGER, windowSeconds, true);
}

// --------------------------------------------------------------------
// Small security helpers (codes, constant-time compare, PIN hashing)
// --------------------------------------------------------------------

// 6-digit code from the crypto RNG (rejection sampling, so no modulo bias).
function generateSixDigitCode() {
  const limit = Math.floor(0x100000000 / 900000) * 900000;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(100000 + (buf[0] % 900000));
}

function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '';
  return `${name.slice(0, 1)}***@${domain}`;
}

// The TV app stores the Master PIN as SHA-256("<pin>:<salt>") in lowercase hex
// (see PreferencesManager.hashPin). The Worker uses the identical scheme so a
// PIN created on one TV verifies on another once hash AND salt are restored.
const PIN_RE = /^\d{4}$/;
const PIN_HASH_RE = /^[0-9a-f]{64}$/;
const PIN_SALT_RE = /^[A-Za-z0-9-]{8,64}$/;

async function hashPinWithSalt(pin, salt) {
  return sha256(`${pin}:${salt}`);
}

// Security: Standard CORS Headers
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json'
  };
}

function jsonResponse(data, status = 200, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

function errorResponse(message, status = 400, corsHeaders) {
  return new Response(JSON.stringify({ error: message, success: false }), {
    status,
    headers: corsHeaders
  });
}

// --------------------------------------------------------------------
// Cryptographic Helpers (PBKDF2, AES-GCM, SHA-256)
// --------------------------------------------------------------------

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(str) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return bytesToHex(digest);
}

// PBKDF2 Password Hashing (100,000 iterations, SHA-256)
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  const hashHex = bytesToHex(derived);
  const finalSaltHex = bytesToHex(salt);
  return `pbkdf2:100000:${finalSaltHex}:${hashHex}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split(':');
  if (parts.length === 4 && parts[0] === 'pbkdf2') {
    const iterations = parseInt(parts[1], 10);
    const saltHex = parts[2];
    const expectedHashHex = parts[3];
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: hexToBytes(saltHex),
        iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );
    const actualHashHex = bytesToHex(derived);
    return actualHashHex === expectedHashHex;
  }
  // Legacy SHA-256 fallback migration
  if (parts.length === 2) {
    const saltHex = parts[0];
    const expected = parts[1];
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(password + ':' + saltHex));
    return bytesToHex(hashBuf) === expected;
  }
  return false;
}

// AES-GCM-256 for encrypting IPTV passwords at rest
async function getEncryptionKey(env) {
  const secret = env.AES_SECRET || env.ENCRYPTION_KEY;
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('Server encryption secret missing (AES_SECRET required)');
  }
  const enc = new TextEncoder();
  const rawKey = await crypto.subtle.digest('SHA-256', enc.encode(secret.trim()));
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptData(plainText, env) {
  if (!plainText) return '';
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plainText)
  );
  return `${bytesToHex(iv)}:${bytesToHex(cipher)}`;
}

async function decryptData(cipherString, env) {
  if (!cipherString || !cipherString.includes(':')) return '';
  try {
    const [ivHex, cipherHex] = cipherString.split(':');
    const key = await getEncryptionKey(env);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(ivHex) },
      key,
      hexToBytes(cipherHex)
    );
    return new TextDecoder().decode(decrypted);
  } catch (_) {
    return '';
  }
}

// Generate crypto-random session token (32 bytes = 64 hex chars)
function generateSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

// --------------------------------------------------------------------
// Authentication Middleware (Bearer Session Token)
// --------------------------------------------------------------------

async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  if (!token || token.length < 32) return null;

  const tokenHash = await sha256(token);
  const now = Date.now();

  const session = await env.DB.prepare(
    `SELECT s.session_id, s.account_id, s.expires_at, a.email, a.is_verified
     FROM sessions s
     JOIN accounts a ON s.account_id = a.account_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, now).first();

  if (!session) return null;
  return {
    accountId: session.account_id,
    sessionId: session.session_id,
    email: session.email,
    isVerified: session.is_verified === 1,
    token
  };
}

// --------------------------------------------------------------------
// Brevo Transactional Email Integration (Send-Only, No Contact Lists)
// --------------------------------------------------------------------

// Default sender: the domain authenticated in Brevo (tv.truehats.com).
// Override with the BREVO_SENDER_EMAIL / BREVO_SENDER_NAME Worker variables.
const DEFAULT_SENDER_EMAIL = 'noreply@tv.truehats.com';
const DEFAULT_SENDER_NAME = 'StreamVault TV';

// purpose: 'verify_email' (sign-up / resend) or 'reset_pin' (Master PIN reset)
async function sendVerificationEmail(email, code, env, purpose = 'verify_email') {
  const brevoApiKey = env.BREVO_API_KEY;
  const resendApiKey = env.RESEND_API_KEY;

  const senderEmail = env.BREVO_SENDER_EMAIL || env.EMAIL_FROM_ADDRESS || DEFAULT_SENDER_EMAIL;
  const senderName = env.BREVO_SENDER_NAME || env.EMAIL_FROM_NAME || DEFAULT_SENDER_NAME;
  const isPinReset = purpose === 'reset_pin';
  const subject = isPinReset
    ? `${code} is your StreamVault TV PIN reset code`
    : `${code} is your StreamVault TV verification code`;
  const subtitle = isPinReset ? 'Master PIN Reset' : 'Standalone Cloud Account Verification';
  const instruction = isPinReset
    ? 'Enter this 6-digit code on your TV to reset your Master PIN:'
    : 'Enter this 6-digit code on your TV or mobile pairing screen:';

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; background: #090714; color: #FFFFFF; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #A78BFA; font-size: 24px; margin: 0 0 8px;">StreamVault TV</h1>
        <p style="color: #94A3B8; font-size: 14px; margin: 0;">${subtitle}</p>
      </div>
      <div style="background: #15102A; border: 1px solid #2E2356; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px;">
        <p style="color: #E2E8F0; font-size: 14px; margin-top: 0;">${instruction}</p>
        <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #8B5CF6; margin: 16px 0;">${code}</div>
        <p style="color: #64748B; font-size: 12px; margin-bottom: 0;">Valid for 10 minutes. Never share this code.</p>
      </div>
      <p style="color: #64748B; font-size: 11px; text-align: center; margin: 0;">If you didn't request this code, you can safely ignore this email.</p>
    </div>
  `;

  // 1. Primary: Brevo Transactional Email API (send-only, no contact list addition)
  if (brevoApiKey) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoApiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          sender: {
            name: senderName,
            email: senderEmail
          },
          to: [
            { email: email }
          ],
          subject: subject,
          htmlContent: htmlContent
        })
      });
      return { sent: res.ok, status: res.status, provider: 'brevo' };
    } catch (err) {
      console.error('[Brevo Email Error]', err);
      return { sent: false, error: err.message, provider: 'brevo' };
    }
  }

  // 2. Fallback: Resend API if legacy secret is configured
  if (resendApiKey) {
    try {
      const fromAddr = env.EMAIL_FROM || `${senderName} <${senderEmail}>`;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromAddr,
          to: email,
          subject: subject,
          html: htmlContent
        })
      });
      return { sent: res.ok, status: res.status, provider: 'resend' };
    } catch (err) {
      console.error('[Resend Email Error]', err);
      return { sent: false, error: err.message, provider: 'resend' };
    }
  }

  console.warn(`[StreamVault Auth] Neither BREVO_API_KEY nor RESEND_API_KEY configured. Verification code for ${email}: ${code}`);
  return { sent: false, note: 'No email service API key configured in Worker secrets' };
}

// --------------------------------------------------------------------
// Worker Request Router
// --------------------------------------------------------------------


// ---- Shared TMDB cache: keep only the fields the TV uses, so 60,000 titles fit comfortably in the database ----
const TMDB_DETAIL_APPEND = 'credits,external_ids,release_dates,content_ratings';
function slimTmdbDetail(text) {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object' || !o.id) return text;
    const credits = o.credits || {};
    return JSON.stringify({
      id: o.id,
      overview: o.overview || '',
      vote_average: o.vote_average,
      vote_count: o.vote_count,
      runtime: o.runtime,
      episode_run_time: o.episode_run_time,
      release_date: o.release_date,
      first_air_date: o.first_air_date,
      original_language: o.original_language,
      genres: (o.genres || []).map((g) => ({ id: g.id, name: g.name })),
      poster_path: o.poster_path,
      backdrop_path: o.backdrop_path,
      imdb_id: o.imdb_id || (o.external_ids && o.external_ids.imdb_id) || '',
      credits: {
        cast: (credits.cast || []).slice(0, 8).map((c) => ({ name: c.name })),
        crew: (credits.crew || []).filter((c) => c.job === 'Director').slice(0, 2).map((c) => ({ name: c.name, job: 'Director' }))
      },
      release_dates: {
        results: ((o.release_dates && o.release_dates.results) || [])
          .filter((r) => r.iso_3166_1 === 'US')
          .map((r) => ({ iso_3166_1: 'US', release_dates: (r.release_dates || []).map((d) => ({ certification: d.certification || '' })) }))
      },
      content_ratings: {
        results: ((o.content_ratings && o.content_ratings.results) || [])
          .filter((r) => r.iso_3166_1 === 'US')
          .map((r) => ({ iso_3166_1: 'US', rating: r.rating || '' }))
      }
    });
  } catch (_) {
    return text;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
    const corsHeaders = getCorsHeaders(request);

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Mobile & Web TV Link Portal
      if (pathname === '/' || pathname === '/link') {
        const codeParam = url.searchParams.get('code') || '';
        return new Response(renderWebPairingUi(codeParam), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
        });
      }

      // ================================================================
      // AUTH ENDPOINTS (Public / Verification)
      // ================================================================

      // A. Sign Up (PBKDF2 + Email Verification Code)
      if (method === 'POST' && pathname === '/api/auth/signup') {
        if (!await checkRateLimit(env.DB, `ip:signup:${clientIp}`, 5, 60)) {
          return errorResponse('Too many sign-up attempts. Please wait 1 minute.', 429, corsHeaders);
        }
        const { email, password, displayName = 'Account Owner' } = await request.json().catch(() => ({}));
        if (!email || !password) {
          return errorResponse('Email and password are required', 400, corsHeaders);
        }
        const cleanEmail = email.trim().toLowerCase();
        if (cleanEmail.length < 5 || !cleanEmail.includes('@')) {
          return errorResponse('Please enter a valid email address', 400, corsHeaders);
        }
        if (password.length < 6) {
          return errorResponse('Password must be at least 6 characters', 400, corsHeaders);
        }
        if (!await checkRateLimit(env.DB, `email:signup:${cleanEmail}`, 3, 60)) {
          return errorResponse('Too many sign-up attempts for this email. Please wait 1 minute.', 429, corsHeaders);
        }

        // Check if account already exists
        const existing = await env.DB.prepare('SELECT account_id, is_verified FROM accounts WHERE email = ?').bind(cleanEmail).first();
        const accountId = existing ? existing.account_id : crypto.randomUUID();
        const now = Date.now();

        if (existing && existing.is_verified === 1) {
          return errorResponse('An account with this email already exists. Please sign in.', 409, corsHeaders);
        }

        // Compute PBKDF2 hash (100k iterations)
        const passwordHash = await hashPassword(password);

        if (!existing) {
          await env.DB.prepare(
            `INSERT INTO accounts (account_id, email, password_hash, is_verified, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?)`
          ).bind(accountId, cleanEmail, passwordHash, now, now).run();

          // Create primary profile (cannot be deleted)
          const profileId = 'prof_' + crypto.randomUUID().substring(0, 8);
          await env.DB.prepare(
            `INSERT INTO profiles (profile_id, account_id, display_name, avatar_color, theme, is_kids, is_primary, created_at, updated_at)
             VALUES (?, ?, ?, '#8B5CF6', 'StreamVault Purple', 0, 1, ?, ?)`
          ).bind(profileId, accountId, displayName.trim() || 'Account Owner', now, now).run();
        } else {
          // Update password if unverified re-attempt
          await env.DB.prepare(
            `UPDATE accounts SET password_hash = ?, updated_at = ? WHERE account_id = ?`
          ).bind(passwordHash, now, accountId).run();
        }

        // Generate 6-digit confirmation code (crypto RNG)
        const codeStr = generateSixDigitCode();
        const codeId = crypto.randomUUID();
        const expiresAt = now + 10 * 60 * 1000; // 10 minutes

        // A new code replaces any earlier one: older unused codes stop working
        await env.DB.prepare(
          `UPDATE email_codes SET is_used = 1 WHERE email = ? AND purpose = 'verify_email' AND is_used = 0`
        ).bind(cleanEmail).run();
        await env.DB.prepare(
          `INSERT INTO email_codes (code_id, email, code, purpose, attempts, is_used, expires_at, created_at)
           VALUES (?, ?, ?, 'verify_email', 0, 0, ?, ?)`
        ).bind(codeId, cleanEmail, codeStr, expiresAt, now).run();

        // Send email via Brevo transactional email
        const emailResult = await sendVerificationEmail(cleanEmail, codeStr, env);

        const isDevMode = env.DEV_MODE === true || env.DEV_MODE === 'true' || env.DEV_MODE === '1';

        const signupResponse = {
          success: true,
          requireVerification: true,
          email: cleanEmail,
          message: 'Verification code sent to your email'
        };
        if (isDevMode) {
          signupResponse.devCode = codeStr;
        }

        return jsonResponse(signupResponse, 201, corsHeaders);
      }

      // B. Verify Email Code
      if (method === 'POST' && pathname === '/api/auth/verify-code') {
        if (!await checkRateLimit(env.DB, `ip:verify:${clientIp}`, 10, 60)) {
          return errorResponse('Too many verification attempts. Please wait 1 minute.', 429, corsHeaders);
        }
        const { email, code } = await request.json().catch(() => ({}));
        if (!email || !code) return errorResponse('Email and code are required', 400, corsHeaders);
        const cleanEmail = email.trim().toLowerCase();
        const cleanCode = String(code).trim();
        if (!await checkRateLimit(env.DB, `email:verify:${cleanEmail}`, 5, 60)) {
          return errorResponse('Too many verification attempts for this email. Please wait 1 minute.', 429, corsHeaders);
        }
        const now = Date.now();

        // Only sign-up codes work here. PIN-reset codes (purpose 'reset_pin') must
        // never be usable as a sign-in code.
        const codeRecord = await env.DB.prepare(
          `SELECT code_id, attempts, is_used, expires_at
           FROM email_codes
           WHERE email = ? AND code = ? AND is_used = 0 AND purpose = 'verify_email'
           ORDER BY created_at DESC LIMIT 1`
        ).bind(cleanEmail, cleanCode).first();

        if (!codeRecord) {
          // Increment attempts on recent sign-up codes for this email
          await env.DB.prepare(
            `UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND is_used = 0 AND purpose = 'verify_email'`
          ).bind(cleanEmail).run();
          return errorResponse('Invalid or expired verification code', 401, corsHeaders);
        }

        if (codeRecord.attempts >= 5) {
          return errorResponse('Too many failed attempts. Please request a new verification code.', 429, corsHeaders);
        }
        if (now > codeRecord.expires_at) {
          return errorResponse('Verification code has expired. Please request a new code.', 400, corsHeaders);
        }

        // Mark code as used & verify account
        await env.DB.prepare(`UPDATE email_codes SET is_used = 1 WHERE code_id = ?`).bind(codeRecord.code_id).run();
        await env.DB.prepare(`UPDATE accounts SET is_verified = 1, updated_at = ? WHERE email = ?`).bind(now, cleanEmail).run();

        const account = await env.DB.prepare(`SELECT account_id, pin_hash, pin_salt FROM accounts WHERE email = ?`).bind(cleanEmail).first();

        // Issue 32-byte crypto session token
        const rawToken = generateSessionToken();
        const tokenHash = await sha256(rawToken);
        const sessionId = crypto.randomUUID();
        const sessionExpires = now + 30 * 86400 * 1000; // 30 days

        await env.DB.prepare(
          `INSERT INTO sessions (session_id, account_id, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(sessionId, account.account_id, tokenHash, sessionExpires, now).run();

        const profiles = await env.DB.prepare(
          `SELECT profile_id, display_name, avatar_color, theme, is_kids, is_primary FROM profiles WHERE account_id = ?`
        ).bind(account.account_id).all();

        return jsonResponse({
          success: true,
          message: 'Email verified successfully',
          accountId: account.account_id,
          token: rawToken,
          email: cleanEmail,
          pinHash: (account && account.pin_hash) || '',
          pinSalt: (account && account.pin_salt) || '',
          profiles: profiles.results || []
        }, 200, corsHeaders);
      }

      // B.1 Resend Email Verification Code
      if (method === 'POST' && pathname === '/api/auth/resend-code') {
        if (!await checkRateLimit(env.DB, `ip:resend:${clientIp}`, 5, 60)) {
          return errorResponse('Too many requests. Please wait 1 minute.', 429, corsHeaders);
        }
        const { email } = await request.json().catch(() => ({}));
        if (!email) return errorResponse('Email is required', 400, corsHeaders);
        const cleanEmail = email.trim().toLowerCase();
        if (cleanEmail.length < 5 || !cleanEmail.includes('@')) {
          return errorResponse('Please enter a valid email address', 400, corsHeaders);
        }

        if (!await checkRateLimit(env.DB, `email:resend:${cleanEmail}`, 3, 60)) {
          return errorResponse('Too many resend attempts for this email. Please wait 1 minute.', 429, corsHeaders);
        }

        const account = await env.DB.prepare(
          `SELECT account_id, is_verified FROM accounts WHERE email = ?`
        ).bind(cleanEmail).first();

        if (!account) {
          return errorResponse('No account found with this email. Please sign up.', 404, corsHeaders);
        }

        if (account.is_verified === 1) {
          return errorResponse('Account is already verified. Please sign in.', 400, corsHeaders);
        }

        const now = Date.now();
        const codeStr = generateSixDigitCode();
        const codeId = crypto.randomUUID();
        const expiresAt = now + 10 * 60 * 1000; // 10 minutes

        // A new code replaces any earlier one: older unused codes stop working
        await env.DB.prepare(
          `UPDATE email_codes SET is_used = 1 WHERE email = ? AND purpose = 'verify_email' AND is_used = 0`
        ).bind(cleanEmail).run();
        await env.DB.prepare(
          `INSERT INTO email_codes (code_id, email, code, purpose, attempts, is_used, expires_at, created_at)
           VALUES (?, ?, ?, 'verify_email', 0, 0, ?, ?)`
        ).bind(codeId, cleanEmail, codeStr, expiresAt, now).run();

        await sendVerificationEmail(cleanEmail, codeStr, env);

        const isDevMode = env.DEV_MODE === true || env.DEV_MODE === 'true' || env.DEV_MODE === '1';
        const resData = {
          success: true,
          email: cleanEmail,
          message: 'Verification code resent successfully'
        };
        if (isDevMode) {
          resData.devCode = codeStr;
        }

        return jsonResponse(resData, 200, corsHeaders);
      }

      // C. Sign In (PBKDF2 Check + Session Issue)
      if (method === 'POST' && pathname === '/api/auth/login') {
        if (!await checkRateLimit(env.DB, `ip:login:${clientIp}`, 8, 60)) {
          return errorResponse('Too many login attempts. Please wait 1 minute.', 429, corsHeaders);
        }
        const { email, password } = await request.json().catch(() => ({}));
        if (!email || !password) return errorResponse('Email and password are required', 400, corsHeaders);

        const cleanEmail = email.trim().toLowerCase();
        if (!await checkRateLimit(env.DB, `email:login:${cleanEmail}`, 5, 60)) {
          return errorResponse('Too many login attempts for this email. Please wait 1 minute.', 429, corsHeaders);
        }
        const account = await env.DB.prepare(
          `SELECT account_id, email, password_hash, pin_hash, pin_salt, is_verified FROM accounts WHERE email = ?`
        ).bind(cleanEmail).first();

        if (!account) return errorResponse('Invalid email or password', 401, corsHeaders);

        const isValid = await verifyPassword(password, account.password_hash);
        if (!isValid) return errorResponse('Invalid email or password', 401, corsHeaders);

        const now = Date.now();
        // Issue 32-byte session token
        const rawToken = generateSessionToken();
        const tokenHash = await sha256(rawToken);
        const sessionId = crypto.randomUUID();
        const sessionExpires = now + 30 * 86400 * 1000;

        await env.DB.prepare(
          `INSERT INTO sessions (session_id, account_id, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(sessionId, account.account_id, tokenHash, sessionExpires, now).run();

        // Load profiles & playlists
        const profiles = await env.DB.prepare(
          `SELECT profile_id, display_name, avatar_color, theme, is_kids, is_primary FROM profiles WHERE account_id = ?`
        ).bind(account.account_id).all();

        const playlists = await env.DB.prepare(
          `SELECT playlist_id, name, server_url, username, is_enabled, status, last_sync_at FROM playlists WHERE account_id = ? AND removed_at IS NULL`
        ).bind(account.account_id).all();

        return jsonResponse({
          success: true,
          token: rawToken,
          accountId: account.account_id,
          email: account.email,
          isVerified: account.is_verified === 1,
          pinHash: account.pin_hash || '',
          pinSalt: account.pin_salt || '',
          profiles: profiles.results || [],
          playlists: playlists.results || []
        }, 200, corsHeaders);
      }

      // C.1 Validate Session / Get Authenticated Account
      if (method === 'GET' && pathname === '/api/auth/me') {
        const auth = await authenticate(request, env);
        if (!auth) {
          return jsonResponse({ error: 'Unauthorized', authenticated: false }, 401, corsHeaders);
        }
        return jsonResponse({
          ok: true,
          authenticated: true,
          account: {
            accountId: auth.accountId,
            email: auth.email,
            isVerified: auth.isVerified,
            displayName: auth.email.split('@')[0]
          }
        }, 200, corsHeaders);
      }

      // D. Sign Out (Revoke Session Token)
      if (method === 'POST' && pathname === '/api/auth/signout') {
        const auth = await authenticate(request, env);
        if (auth) {
          await env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(auth.sessionId).run();
        }
        return jsonResponse({ success: true, message: 'Signed out' }, 200, corsHeaders);
      }

      // ================================================================
      // PAIRING CODES (TV ↔ Mobile QR Link Flow)
      // ================================================================

      // A. TV Requests Live 6-Digit Pairing Code (e.g. SV-XXXX)
      if (method === 'POST' && pathname === '/api/auth/request-code') {
        const limitedReq = await enforceLimit(env.DB, `ip:reqcode:${clientIp}`, 20, 60,
          'Too many pairing requests. Please wait a minute.', corsHeaders);
        if (limitedReq) return limitedReq;
        const now = Date.now();
        // Generate random 4-character suffix using non-confusing chars
        const charset = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
        let suffix = '';
        const randBytes = crypto.getRandomValues(new Uint8Array(4));
        for (let i = 0; i < 4; i++) {
          suffix += charset[randBytes[i] % charset.length];
        }
        const code = `SV-${suffix}`;
        const expiresAt = now + 10 * 60 * 1000;

        await env.DB.prepare(
          `INSERT INTO pairing_codes (code, status, attempts, created_at, expires_at)
           VALUES (?, 'pending', 0, ?, ?)`
        ).bind(code, now, expiresAt).run();

        const pairingUrl = `https://${url.host}/link?code=${code}`;
        return jsonResponse({
          success: true,
          code,
          expiresInSeconds: 600,
          pairingUrl,
          qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pairingUrl)}`
        }, 200, corsHeaders);
      }

      // B. Mobile User Claims TV Code (Must be authenticated)
      if (method === 'POST' && pathname === '/api/auth/claim-code') {
        const auth = await authenticate(request, env);
        if (!auth) return errorResponse('Authentication required to link device', 401, corsHeaders);

        const limitedClaim = await enforceLimit(env.DB, `acct:claimcode:${auth.accountId}`, 10, 60,
          'Too many attempts. Please wait a minute.', corsHeaders);
        if (limitedClaim) return limitedClaim;
        const { code } = await request.json().catch(() => ({}));
        if (!code) return errorResponse('Pairing code is required', 400, corsHeaders);

        const cleanCode = String(code).trim().toUpperCase();
        const now = Date.now();

        const record = await env.DB.prepare(
          `SELECT code, status, expires_at FROM pairing_codes WHERE code = ?`
        ).bind(cleanCode).first();

        if (!record || record.status !== 'pending' || now > record.expires_at) {
          return errorResponse('Code is invalid, expired, or already used', 400, corsHeaders);
        }

        // Generate one-time 32-byte exchange token
        const exchangeToken = generateSessionToken();

        await env.DB.prepare(
          `UPDATE pairing_codes
           SET account_id = ?, exchange_token = ?, status = 'claimed'
           WHERE code = ?`
        ).bind(auth.accountId, exchangeToken, cleanCode).run();

        return jsonResponse({
          success: true,
          message: 'TV successfully paired! Your TV will log in automatically.'
        }, 200, corsHeaders);
      }

      // C. TV Polls Code Status (Zero password leakage)
      if (method === 'GET' && pathname === '/api/auth/poll-code') {
        const codeParam = url.searchParams.get('code') || '';
        if (!codeParam) return errorResponse('Code parameter required', 400, corsHeaders);
        // Only checks the counter, never writes: the TV asks every 3 seconds and each write used up the daily allowance.
        const limitedPoll = await enforceLimit(env.DB, `ip:pollcode:${clientIp}`, 60, 60,
          'Too many requests. Please wait a minute.', corsHeaders, false);
        if (limitedPoll) return limitedPoll;

        const cleanCode = codeParam.trim().toUpperCase();
        const now = Date.now();

        const record = await env.DB.prepare(
          `SELECT status, exchange_token, expires_at FROM pairing_codes WHERE code = ?`
        ).bind(cleanCode).first();

        if (!record || now > record.expires_at) {
          // Only unknown/expired codes count against the limit (this is what a code-guessing attempt looks like).
          // A TV waiting on its own live code is not counted, so waiting does not write to the database.
          await rateLimit(env.DB, `ip:pollcode:${clientIp}`, 60, 60, true);
          return jsonResponse({ status: 'expired' }, 200, corsHeaders);
        }

        if (record.status === 'claimed' && record.exchange_token) {
          // Never return passwords here! Only the single-use exchange token.
          return jsonResponse({
            status: 'paired',
            exchangeToken: record.exchange_token
          }, 200, corsHeaders);
        }

        return jsonResponse({ status: 'pending' }, 200, corsHeaders);
      }

      // D. TV Exchanges Token for Permanent Session & Credentials
      if (method === 'POST' && pathname === '/api/auth/pair-exchange') {
        const { code, exchangeToken } = await request.json().catch(() => ({}));
        if (!code || !exchangeToken) return errorResponse('Code and exchange token required', 400, corsHeaders);

        const cleanCode = String(code).trim().toUpperCase();
        const now = Date.now();

        const record = await env.DB.prepare(
          `SELECT account_id, exchange_token, status, expires_at
           FROM pairing_codes WHERE code = ?`
        ).bind(cleanCode).first();

        if (!record || record.status !== 'claimed' || record.exchange_token !== exchangeToken || now > record.expires_at) {
          return errorResponse('Invalid or expired exchange token', 403, corsHeaders);
        }

        // Invalidate exchange token immediately (single use)
        await env.DB.prepare(`UPDATE pairing_codes SET status = 'exchanged', exchange_token = NULL WHERE code = ?`).bind(cleanCode).run();

        // Issue new session token for the TV
        const rawToken = generateSessionToken();
        const tokenHash = await sha256(rawToken);
        const sessionId = crypto.randomUUID();
        const sessionExpires = now + 30 * 86400 * 1000;

        await env.DB.prepare(
          `INSERT INTO sessions (session_id, account_id, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(sessionId, record.account_id, tokenHash, sessionExpires, now).run();

        const account = await env.DB.prepare(`SELECT email, pin_hash, pin_salt FROM accounts WHERE account_id = ?`).bind(record.account_id).first();
        const profiles = await env.DB.prepare(`SELECT profile_id, display_name, avatar_color, theme, is_kids, is_primary FROM profiles WHERE account_id = ?`).bind(record.account_id).all();

        // Decrypt playlists for the paired TV
        const playlists = await env.DB.prepare(`SELECT playlist_id, name, server_url, username, password_enc, is_enabled, status FROM playlists WHERE account_id = ? AND removed_at IS NULL`).bind(record.account_id).all();
        const decryptedPlaylists = [];
        for (const p of (playlists.results || [])) {
          const pass = await decryptData(p.password_enc, env);
          decryptedPlaylists.push({
            playlistId: p.playlist_id,
            name: p.name,
            serverUrl: p.server_url,
            username: p.username,
            password: pass,
            isEnabled: p.is_enabled === 1,
            status: p.status
          });
        }

        return jsonResponse({
          success: true,
          token: rawToken,
          accountId: record.account_id,
          email: account ? account.email : '',
          pinHash: (account && account.pin_hash) || '',
          pinSalt: (account && account.pin_salt) || '',
          profiles: profiles.results || [],
          playlists: decryptedPlaylists
        }, 200, corsHeaders);
      }

      // NOTE: /api/account/reset-pin and /api/account/request-pin-reset live in the
      // authenticated section below. A signed-in session is required for both, so
      // there is no public route where passwords or reset codes can be guessed.

      // ================================================================
      // AUTHENTICATED ENDPOINTS (Requires Bearer Session Token)
      // Every endpoint below verifies ownership via auth.accountId (Fixes S2)
      // ================================================================

      const auth = await authenticate(request, env);
      if (!auth) {
        return errorResponse('Unauthorized: Valid Bearer session token required', 401, corsHeaders);
      }

      // ----------------------------------------------------------------
      // MASTER PIN (parental control) — cloud copy so a second TV can restore it.
      // The cloud holds the salted hash + salt, never the PIN itself.
      // ----------------------------------------------------------------

      // Sync / Update Master PIN (hash + salt).
      //  - First PIN for the account: any signed-in session may store it.
      //  - Changing an existing PIN: caller must prove who they are by sending
      //    `currentPin` (the current 4-digit PIN) or `password` (account password).
      if (method === 'POST' && pathname === '/api/account/pin') {
        const blocked = await enforceLimit(env.DB, `ip:accpin:${clientIp}`, 10, 60,
          'Too many requests. Please wait 1 minute.', corsHeaders);
        if (blocked) return blocked;

        // Stop early if this account already failed too many proofs recently.
        const failKey = `fail:accpin:${auth.accountId}`;
        const locked = await enforceLimit(env.DB, failKey, 5, 900,
          'Too many incorrect attempts. Please wait 15 minutes.', corsHeaders, false);
        if (locked) return locked;

        const { pinHash, pinSalt, currentPin, password } = await request.json().catch(() => ({}));
        const cleanHash = typeof pinHash === 'string' ? pinHash.trim().toLowerCase() : '';
        const cleanSalt = typeof pinSalt === 'string' ? pinSalt.trim() : '';
        if (!PIN_HASH_RE.test(cleanHash) || !PIN_SALT_RE.test(cleanSalt)) {
          return errorResponse('A valid pinHash and pinSalt are required', 400, corsHeaders);
        }

        const row = await env.DB.prepare(
          `SELECT password_hash, pin_hash, pin_salt FROM accounts WHERE account_id = ?`
        ).bind(auth.accountId).first();
        if (!row) return errorResponse('Account not found', 404, corsHeaders);

        if (row.pin_hash) {
          let proven = false;
          if (typeof password === 'string' && password) {
            proven = await verifyPassword(password, row.password_hash);
          } else if (typeof currentPin === 'string' && PIN_RE.test(currentPin.trim()) && row.pin_salt) {
            const check = await hashPinWithSalt(currentPin.trim(), row.pin_salt);
            proven = safeEqual(check, row.pin_hash);
          } else {
            return jsonResponse({
              success: false,
              requireReauth: true,
              error: 'Re-authentication required: send the current PIN or the account password'
            }, 403, corsHeaders);
          }
          if (!proven) {
            await recordFailure(env.DB, failKey, 900);
            return jsonResponse({
              success: false,
              requireReauth: true,
              error: 'Incorrect current PIN or account password'
            }, 403, corsHeaders);
          }
        }

        await env.DB.prepare(
          `UPDATE accounts SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE account_id = ?`
        ).bind(cleanHash, cleanSalt, Date.now(), auth.accountId).run();
        return jsonResponse({ success: true, message: 'PIN synced' }, 200, corsHeaders);
      }

      // Request a 6-digit email code to reset the Master PIN.
      // Works for signed-in, email-verified accounts only; the code always goes to
      // the account's own email address, never to an address supplied by the caller.
      if (method === 'POST' && pathname === '/api/account/request-pin-reset') {
        const blockedIp = await enforceLimit(env.DB, `ip:pinresetcode:${clientIp}`, 5, 60,
          'Too many requests. Please wait 1 minute.', corsHeaders);
        if (blockedIp) return blockedIp;
        const blockedMin = await enforceLimit(env.DB, `email:pinresetcode:${auth.email}`, 3, 60,
          'Too many reset-code requests for this account. Please wait 1 minute.', corsHeaders);
        if (blockedMin) return blockedMin;
        const blockedHour = await enforceLimit(env.DB, `email:pinresetcode:hour:${auth.email}`, 5, 3600,
          'Too many reset-code requests for this account. Please try again in an hour.', corsHeaders);
        if (blockedHour) return blockedHour;

        if (!auth.isVerified) {
          return errorResponse('Please verify your email address before resetting the PIN.', 400, corsHeaders);
        }

        const now = Date.now();
        const codeStr = generateSixDigitCode();
        // Only one live reset code at a time (keeps the guessing space small).
        await env.DB.prepare(
          `UPDATE email_codes SET is_used = 1 WHERE email = ? AND purpose = 'reset_pin' AND is_used = 0`
        ).bind(auth.email).run();
        await env.DB.prepare(
          `INSERT INTO email_codes (code_id, email, code, purpose, attempts, is_used, expires_at, created_at)
           VALUES (?, ?, ?, 'reset_pin', 0, 0, ?, ?)`
        ).bind(crypto.randomUUID(), auth.email, codeStr, now + 10 * 60 * 1000, now).run();

        const emailResult = await sendVerificationEmail(auth.email, codeStr, env, 'reset_pin');
        const isDevMode = env.DEV_MODE === true || env.DEV_MODE === 'true' || env.DEV_MODE === '1';
        if (!emailResult.sent && !isDevMode) {
          return errorResponse('Could not send the email right now. Please try again shortly.', 502, corsHeaders);
        }

        const resData = {
          success: true,
          sentTo: maskEmail(auth.email),
          message: 'PIN reset code sent to your account email'
        };
        if (isDevMode) resData.devCode = codeStr;
        return jsonResponse(resData, 200, corsHeaders);
      }

      // Reset the Master PIN using the ACCOUNT password or a 6-digit email code.
      // (IPTV credentials are never accepted.) Body: { password | code, newPin }
      if (method === 'POST' && pathname === '/api/account/reset-pin') {
        const blockedIp = await enforceLimit(env.DB, `ip:resetpin:${clientIp}`, 8, 60,
          'Too many PIN reset attempts. Please wait 1 minute.', corsHeaders);
        if (blockedIp) return blockedIp;
        const blockedEmail = await enforceLimit(env.DB, `email:resetpin:${auth.email}`, 5, 60,
          'Too many PIN reset attempts for this account. Please wait 1 minute.', corsHeaders);
        if (blockedEmail) return blockedEmail;

        const { password, code, newPin, newPinHash, newPinSalt } = await request.json().catch(() => ({}));

        // New PIN material: plain 4-digit PIN (Worker salts it) or a ready hash+salt.
        let saveHash = '';
        let saveSalt = '';
        if (typeof newPin === 'string' && PIN_RE.test(newPin.trim())) {
          saveSalt = crypto.randomUUID();
          saveHash = await hashPinWithSalt(newPin.trim(), saveSalt);
        } else if (typeof newPinHash === 'string' && typeof newPinSalt === 'string'
                   && PIN_HASH_RE.test(newPinHash.trim().toLowerCase()) && PIN_SALT_RE.test(newPinSalt.trim())) {
          saveHash = newPinHash.trim().toLowerCase();
          saveSalt = newPinSalt.trim();
        } else {
          return errorResponse('New PIN must be exactly 4 digits', 400, corsHeaders);
        }

        const account = await env.DB.prepare(
          `SELECT account_id, email, password_hash FROM accounts WHERE account_id = ?`
        ).bind(auth.accountId).first();
        if (!account) return errorResponse('Account not found', 404, corsHeaders);

        if (typeof password === 'string' && password) {
          // Slow-drip guessing guard: 10 wrong passwords per hour per account.
          // (The email-code path below stays available while this is locked.)
          const pwFailKey = `fail:resetpin:${account.account_id}`;
          const pwLocked = await enforceLimit(env.DB, pwFailKey, 10, 3600,
            'Too many incorrect passwords. Use an email code instead, or wait an hour.', corsHeaders, false);
          if (pwLocked) return pwLocked;
          const ok = await verifyPassword(password, account.password_hash);
          if (!ok) {
            await recordFailure(env.DB, pwFailKey, 3600);
            return errorResponse('Incorrect account password', 403, corsHeaders);
          }
        } else if (typeof code === 'string' && code.trim()) {
          const record = await env.DB.prepare(
            `SELECT code_id, code, attempts, expires_at FROM email_codes
             WHERE email = ? AND purpose = 'reset_pin' AND is_used = 0
             ORDER BY created_at DESC LIMIT 1`
          ).bind(account.email).first();
          if (!record || Date.now() > record.expires_at) {
            return errorResponse('Invalid or expired 6-digit verification code', 401, corsHeaders);
          }
          if (record.attempts >= 5) {
            return errorResponse('Too many incorrect codes. Please request a new code.', 429, corsHeaders);
          }
          if (!safeEqual(record.code, code.trim())) {
            await env.DB.prepare(
              `UPDATE email_codes SET attempts = attempts + 1 WHERE code_id = ?`
            ).bind(record.code_id).run();
            return errorResponse('Invalid or expired 6-digit verification code', 401, corsHeaders);
          }
          await env.DB.prepare(`UPDATE email_codes SET is_used = 1 WHERE code_id = ?`).bind(record.code_id).run();
        } else {
          return errorResponse('Account password or 6-digit email code required', 400, corsHeaders);
        }

        await env.DB.prepare(
          `UPDATE accounts SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE account_id = ?`
        ).bind(saveHash, saveSalt, Date.now(), account.account_id).run();
        return jsonResponse({ success: true, message: 'Master PIN reset successfully verified' }, 200, corsHeaders);
      }

      // ----------------------------------------------------------------
      // IPTV PLAYLIST MANAGEMENT (Many per account, replaceable)
      // ----------------------------------------------------------------

      // List Playlists
      if (method === 'GET' && pathname === '/api/playlists') {
        const rows = await env.DB.prepare(
          `SELECT playlist_id, name, server_url, username, password_enc, is_enabled, status, last_sync_at, created_at, updated_at
           FROM playlists
           WHERE account_id = ? AND removed_at IS NULL
           ORDER BY created_at ASC`
        ).bind(auth.accountId).all();

        const playlists = [];
        for (const r of (rows.results || [])) {
          const pass = await decryptData(r.password_enc, env);
          playlists.push({
            playlistId: r.playlist_id,
            name: r.name,
            serverUrl: r.server_url,
            username: r.username,
            password: pass,
            isEnabled: r.is_enabled === 1,
            status: r.status,
            lastSyncAt: r.last_sync_at,
            createdAt: r.created_at,
            updatedAt: r.updated_at
          });
        }
        return jsonResponse({ success: true, playlists }, 200, corsHeaders);
      }

      // Add Playlist
      if (method === 'POST' && pathname === '/api/playlists') {
        const { name, serverUrl, username, password } = await request.json().catch(() => ({}));
        if (!serverUrl || !username || !password) {
          return errorResponse('Server URL, username, and password are required', 400, corsHeaders);
        }
        if (!env.AES_SECRET && !env.ENCRYPTION_KEY) {
          return errorResponse('Server encryption configuration error (AES_SECRET missing)', 500, corsHeaders);
        }
        let passEnc;
        try {
          passEnc = await encryptData(password, env);
        } catch (err) {
          return errorResponse('Server encryption configuration error (AES_SECRET missing)', 500, corsHeaders);
        }
        const now = Date.now();
        const playlistId = 'pl_' + crypto.randomUUID().substring(0, 10);

        await env.DB.prepare(
          `INSERT INTO playlists (playlist_id, account_id, name, server_url, username, password_enc, is_enabled, status, last_sync_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'ready', 0, ?, ?)`
        ).bind(playlistId, auth.accountId, (name || 'My IPTV').trim(), serverUrl.trim(), username.trim(), passEnc, now, now).run();

        return jsonResponse({
          success: true,
          playlist: {
            playlistId,
            name: (name || 'My IPTV').trim(),
            serverUrl: serverUrl.trim(),
            username: username.trim(),
            isEnabled: true,
            status: 'ready'
          }
        }, 201, corsHeaders);
      }

      // Update Playlist
      if (method === 'PUT' && pathname.startsWith('/api/playlists/')) {
        const playlistId = pathname.replace('/api/playlists/', '').trim();
        const { name, serverUrl, username, password, isEnabled, status } = await request.json().catch(() => ({}));
        const now = Date.now();

        const existing = await env.DB.prepare(
          `SELECT playlist_id, password_enc FROM playlists WHERE playlist_id = ? AND account_id = ?`
        ).bind(playlistId, auth.accountId).first();

        if (!existing) return errorResponse('Playlist not found', 404, corsHeaders);

        let passEnc = existing.password_enc;
        if (password && password.trim().length > 0) {
          if (!env.AES_SECRET && !env.ENCRYPTION_KEY) {
            return errorResponse('Server encryption configuration error (AES_SECRET missing)', 500, corsHeaders);
          }
          try {
            passEnc = await encryptData(password.trim(), env);
          } catch (err) {
            return errorResponse('Server encryption configuration error (AES_SECRET missing)', 500, corsHeaders);
          }
        }

        await env.DB.prepare(
          `UPDATE playlists
           SET name = COALESCE(?, name),
               server_url = COALESCE(?, server_url),
               username = COALESCE(?, username),
               password_enc = ?,
               is_enabled = COALESCE(?, is_enabled),
               status = COALESCE(?, status),
               updated_at = ?
           WHERE playlist_id = ? AND account_id = ?`
        ).bind(
          name ? name.trim() : null,
          serverUrl ? serverUrl.trim() : null,
          username ? username.trim() : null,
          passEnc,
          isEnabled !== undefined ? (isEnabled ? 1 : 0) : null,
          status || null,
          now,
          playlistId,
          auth.accountId
        ).run();

        return jsonResponse({ success: true, message: 'Playlist updated' }, 200, corsHeaders);
      }

      // Delete Playlist (Soft delete: keeps profile data 100% safe!)
      if (method === 'DELETE' && pathname.startsWith('/api/playlists/')) {
        const playlistId = pathname.replace('/api/playlists/', '').trim();
        const now = Date.now();
        await env.DB.prepare(
          `UPDATE playlists SET is_enabled = 0, removed_at = ?, updated_at = ?
           WHERE playlist_id = ? AND account_id = ?`
        ).bind(now, now, playlistId, auth.accountId).run();

        return jsonResponse({ success: true, message: 'Playlist removed' }, 200, corsHeaders);
      }

      // ----------------------------------------------------------------
      // CATALOG SYNC (Batched, Idempotent, 14-day Soft Delete)
      // ----------------------------------------------------------------

      // A. Batch Sync Items from TV App
      if (method === 'POST' && pathname === '/api/catalog/sync-batch') {
        const { items, playlistId } = await request.json().catch(() => ({}));
        if (!Array.isArray(items) || items.length === 0) {
          return errorResponse('Items array required', 400, corsHeaders);
        }

        const now = Date.now();
        const stmts = [];

        for (const it of items) {
          if (!it.dedupKey) continue;
          const itemId = `${auth.accountId}:${it.dedupKey}`;
          stmts.push(
            env.DB.prepare(
              `INSERT INTO catalog_items (
                item_id, account_id, playlist_id, dedup_key, media_type, title, clean_title,
                year, tmdb_id, overview, poster_path, backdrop_path, rating, runtime_mins,
                genres_json, versions_json, episodes_json, is_adult, is_removed, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
              ON CONFLICT(item_id) DO UPDATE SET
                playlist_id = excluded.playlist_id,
                title = excluded.title,
                clean_title = excluded.clean_title,
                year = excluded.year,
                tmdb_id = excluded.tmdb_id,
                overview = excluded.overview,
                poster_path = excluded.poster_path,
                backdrop_path = excluded.backdrop_path,
                rating = excluded.rating,
                runtime_mins = excluded.runtime_mins,
                genres_json = excluded.genres_json,
                versions_json = excluded.versions_json,
                episodes_json = excluded.episodes_json,
                is_adult = excluded.is_adult,
                is_removed = 0,
                removed_at = NULL,
                updated_at = excluded.updated_at`
            ).bind(
              itemId, auth.accountId, playlistId || null, it.dedupKey, it.mediaType || 'MOVIE',
              it.title || 'Untitled', it.cleanTitle || it.title || 'Untitled',
              it.year || null, it.tmdbId || null, it.overview || null,
              it.posterPath || null, it.backdropPath || null,
              it.rating || 0, it.runtimeMins || 0,
              JSON.stringify(it.genres || []),
              JSON.stringify(it.versions || []),
              JSON.stringify(it.episodes || []),
              it.isAdult ? 1 : 0,
              now, now
            )
          );
        }

        if (stmts.length > 0) {
          // Execute batch (max 100 per transaction)
          await env.DB.batch(stmts);
        }

        return jsonResponse({ success: true, count: stmts.length }, 200, corsHeaders);
      }

      // B. Pull Catalog Items (Delta Sync via updated_since)
      if (method === 'GET' && pathname === '/api/catalog/pull') {
        const updatedSince = parseInt(url.searchParams.get('updated_since') || '0', 10);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
        // Paging continues from where the last page ended (updated_at + item_id), so a page never re-reads the pages before it.
        // (The old ?offset= form still works for older apps.)
        const legacyOffset = url.searchParams.has('offset') && !url.searchParams.has('after_item');
        const offset = legacyOffset ? (parseInt(url.searchParams.get('offset') || '0', 10) || 0) : 0;
        const afterUpdated = parseInt(url.searchParams.get('after_updated') || String(updatedSince), 10) || 0;
        const afterItem = url.searchParams.get('after_item') || '';
        const firstPage = !url.searchParams.has('after_item') && offset === 0;

        const rows = legacyOffset
          ? await env.DB.prepare(
              `SELECT item_id, playlist_id, dedup_key, media_type, title, clean_title, year, tmdb_id,
                      overview, poster_path, backdrop_path, rating, runtime_mins, genres_json,
                      versions_json, episodes_json, is_adult, is_removed, removed_at, updated_at
               FROM catalog_items
               WHERE account_id = ? AND updated_at > ?
               ORDER BY updated_at ASC, item_id ASC
               LIMIT ? OFFSET ?`
            ).bind(auth.accountId, updatedSince, limit, offset).all()
          : await env.DB.prepare(
              `SELECT item_id, playlist_id, dedup_key, media_type, title, clean_title, year, tmdb_id,
                      overview, poster_path, backdrop_path, rating, runtime_mins, genres_json,
                      versions_json, episodes_json, is_adult, is_removed, removed_at, updated_at
               FROM catalog_items
               WHERE account_id = ? AND updated_at >= ? AND (updated_at > ? OR item_id > ?) AND updated_at > ?
               ORDER BY updated_at ASC, item_id ASC
               LIMIT ?`
            ).bind(auth.accountId, afterUpdated, afterUpdated, afterItem, updatedSince, limit).all();

        // The total is only counted once (first page); later pages do not re-count the whole account.
        const countRow = firstPage
          ? await env.DB.prepare(
              `SELECT COUNT(*) as total FROM catalog_items WHERE account_id = ? AND updated_at > ?`
            ).bind(auth.accountId, updatedSince).first()
          : null;

        const items = (rows.results || []).map(r => ({
          itemId: r.item_id,
          playlistId: r.playlist_id,
          dedupKey: r.dedup_key,
          mediaType: r.media_type,
          title: r.title,
          cleanTitle: r.clean_title,
          year: r.year,
          tmdbId: r.tmdb_id,
          overview: r.overview,
          posterPath: r.poster_path,
          backdropPath: r.backdrop_path,
          rating: r.rating,
          runtimeMins: r.runtime_mins,
          genres: JSON.parse(r.genres_json || '[]'),
          versions: JSON.parse(r.versions_json || '[]'),
          episodes: JSON.parse(r.episodes_json || '[]'),
          isAdult: r.is_adult === 1,
          isRemoved: r.is_removed === 1,
          removedAt: r.removed_at,
          updatedAt: r.updated_at
        }));

        const total = (countRow && countRow.total) || 0;
        const last = items.length ? items[items.length - 1] : null;
        return jsonResponse({
          success: true,
          items,
          total,
          hasMore: items.length === limit,
          nextAfterUpdated: last ? last.updatedAt : afterUpdated,
          nextAfterItem: last ? last.itemId : afterItem
        }, 200, corsHeaders);
      }

      // C. Mark Removed Titles (14-day Soft Delete)
      if (method === 'POST' && pathname === '/api/catalog/mark-removed') {
        const { dedupKeys } = await request.json().catch(() => ({}));
        if (!Array.isArray(dedupKeys) || dedupKeys.length === 0) {
          return errorResponse('dedupKeys array required', 400, corsHeaders);
        }
        const now = Date.now();
        const stmts = dedupKeys.map(k =>
          env.DB.prepare(
            `UPDATE catalog_items
             SET is_removed = 1, removed_at = ?, updated_at = ?
             WHERE item_id = ? AND account_id = ?`
          ).bind(now, now, `${auth.accountId}:${k}`, auth.accountId)
        );
        await env.DB.batch(stmts);
        return jsonResponse({ success: true, count: stmts.length }, 200, corsHeaders);
      }

      // D. Purge Titles Removed > 14 Days Ago (Zero profile data loss!)
      if (method === 'POST' && pathname === '/api/catalog/purge-expired') {
        const fourteenDaysAgo = Date.now() - 14 * 86400 * 1000;
        const res = await env.DB.prepare(
          `DELETE FROM catalog_items
           WHERE account_id = ? AND is_removed = 1 AND removed_at < ?`
        ).bind(auth.accountId, fourteenDaysAgo).run();
        return jsonResponse({ success: true, purged: res.meta?.changes || 0 }, 200, corsHeaders);
      }

      // ----------------------------------------------------------------
      // ENRICHMENTS PACK (R2): signed-in users only. Small manifest + big file with Range (resume) support.
      // ----------------------------------------------------------------

      if (method === 'GET' && (pathname === '/api/pack/latest' || pathname === '/api/pack/file')) {
        const auth = await authenticate(request, env);
        if (!auth) return errorResponse('Unauthorized', 401, corsHeaders);
        if (!env.PACKS) return errorResponse('Pack storage is not configured', 503, corsHeaders);

        const latestObj = await env.PACKS.get('packs/latest.json');
        if (!latestObj) return errorResponse('No pack published yet', 404, corsHeaders);
        let manifest;
        try { manifest = JSON.parse(await latestObj.text()); } catch (_) { return errorResponse('Pack manifest is unreadable', 500, corsHeaders); }
        if (!manifest || typeof manifest.key !== 'string' || !manifest.key.startsWith('packs/')) {
          return errorResponse('Pack manifest is invalid', 500, corsHeaders);
        }

        if (pathname === '/api/pack/latest') {
          return jsonResponse({ success: true, pack: manifest }, 200, corsHeaders);
        }

        // /api/pack/file : stream the pack named in the manifest; "Range: bytes=START-" resumes a download.
        const head = await env.PACKS.head(manifest.key);
        if (!head) return errorResponse('Pack file not found', 404, corsHeaders);
        const total = head.size;
        const baseHeaders = {
          ...corsHeaders,
          'Content-Type': 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'ETag': head.httpEtag,
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag'
        };
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
          let start = m && m[1] !== '' ? Number(m[1]) : NaN;
          let end = m && m[2] !== '' ? Number(m[2]) : total - 1;
          if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, total - Number(m[2])); end = total - 1; } // suffix range
          if (!m || !Number.isFinite(start) || start >= total || end < start) {
            return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` } });
          }
          end = Math.min(end, total - 1);
          const part = await env.PACKS.get(manifest.key, { range: { offset: start, length: end - start + 1 } });
          if (!part) return errorResponse('Pack file not found', 404, corsHeaders);
          return new Response(part.body, {
            status: 206,
            headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }
          });
        }
        const whole = await env.PACKS.get(manifest.key);
        if (!whole) return errorResponse('Pack file not found', 404, corsHeaders);
        return new Response(whole.body, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(total) } });
      }

      // ----------------------------------------------------------------
      // SHARED TMDB PROXY & CACHE (Proxy TMDB so key is not in APK)
      // ----------------------------------------------------------------

      // Many cached titles in one call (cache only: never calls TMDB). Used by a TV that is signing in.
      if (method === 'POST' && pathname === '/api/tmdb/batch') {
        const body = await request.json().catch(() => ({}));
        const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
        const qs = new URLSearchParams({ append_to_response: TMDB_DETAIL_APPEND }).toString();
        const keyToName = new Map();
        for (const it of items) {
          const type = it && it.type;
          const id = Number(it && it.id);
          if ((type === 'movie' || type === 'tv') && Number.isInteger(id) && id > 0) keyToName.set(`${type}/${id}:${qs}`, `${type}:${id}`);
        }
        const results = {};
        const keys = [...keyToName.keys()];
        const now = Date.now();
        for (let i = 0; i < keys.length; i += 50) {
          const part = keys.slice(i, i + 50);
          const rows = await env.DB.prepare(
            `SELECT cache_key, response_json FROM tmdb_cache WHERE cache_key IN (${part.map(() => '?').join(',')}) AND expires_at > ?`
          ).bind(...part, now).all();
          for (const row of rows.results || []) {
            try { results[keyToName.get(row.cache_key)] = JSON.parse(slimTmdbDetail(row.response_json)); } catch (_) {}
          }
        }
        return jsonResponse({ success: true, results, requested: keys.length, found: Object.keys(results).length }, 200, corsHeaders);
      }

      if (method === 'GET' && pathname.startsWith('/api/tmdb/')) {
        const subPath = pathname.replace('/api/tmdb/', '');
        // No built-in fallback key: the key is a Worker secret and must be configured.
        const apiKey = env.TMDB_API_KEY;
        if (!apiKey) {
          return errorResponse('TMDB_API_KEY is not configured on the server', 500, corsHeaders);
        }
        const now = Date.now();

        // 1. Check shared cache
        const cacheKey = `${subPath}:${url.searchParams.toString()}`;
        const cached = await env.DB.prepare(
          `SELECT response_json FROM tmdb_cache WHERE cache_key = ? AND expires_at > ?`
        ).bind(cacheKey, now).first();

        if (cached && cached.response_json) {
          return new Response(cached.response_json, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json; charset=utf-8',
              'X-Cache': 'HIT',
              'Cache-Control': 'public, max-age=86400'
            }
          });
        }

        // 2. Fetch from TMDB API
        const tmdbUrl = new URL(`https://api.themoviedb.org/3/${subPath}`);
        for (const [k, v] of url.searchParams.entries()) {
          tmdbUrl.searchParams.set(k, v);
        }
        tmdbUrl.searchParams.set('api_key', apiKey);

        const tmdbRes = await fetch(tmdbUrl.toString(), {
          headers: { 'Accept': 'application/json' }
        });
        const resText = await tmdbRes.text();

        const isDetail = /^(movie|tv)\/\d+$/.test(subPath);
        const toStore = (tmdbRes.ok && isDetail) ? slimTmdbDetail(resText) : resText;
        // Only title details are stored (a new TV can reuse them). Searches are not: only this account asks, and each stored row spends the daily write allowance.
        if (tmdbRes.ok && isDetail) {
          // Titles change rarely: details are kept 90 days, searches 7 days
          const expiresAt = now + (isDetail ? 90 : 7) * 86400 * 1000;
          await env.DB.prepare(
            `INSERT INTO tmdb_cache (cache_key, endpoint, response_json, expires_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at`
          ).bind(cacheKey, subPath, toStore, expiresAt, now).run();
        }

        return new Response(toStore, {
          status: tmdbRes.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json; charset=utf-8',
            'X-Cache': 'MISS'
          }
        });
      }

      // ----------------------------------------------------------------
      // USER PROFILES & PERSONAL DATA (Decoupled & Permanent)
      // ----------------------------------------------------------------

      // List Profiles
      if (method === 'GET' && pathname === '/api/profiles') {
        const rows = await env.DB.prepare(
          `SELECT profile_id, display_name, avatar_color, theme, is_kids, is_primary
           FROM profiles WHERE account_id = ? ORDER BY is_primary DESC, created_at ASC`
        ).bind(auth.accountId).all();
        return jsonResponse({ success: true, profiles: rows.results || [] }, 200, corsHeaders);
      }

      // Create Secondary Profile (Max 5 profiles per account)
      if (method === 'POST' && pathname === '/api/profiles/create') {
        const { displayName, avatarColor = '#8B5CF6', theme = 'StreamVault Purple', isKids = false } = await request.json().catch(() => ({}));
        if (!displayName || !displayName.trim()) return errorResponse('Profile display name required', 400, corsHeaders);

        const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM profiles WHERE account_id = ?`).bind(auth.accountId).first();
        if (countRow && countRow.count >= 5) {
          return errorResponse('Maximum 5 profiles allowed', 400, corsHeaders);
        }

        const profileId = 'prof_' + crypto.randomUUID().substring(0, 8);
        const now = Date.now();

        await env.DB.prepare(
          `INSERT INTO profiles (profile_id, account_id, display_name, avatar_color, theme, is_kids, is_primary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).bind(profileId, auth.accountId, displayName.trim(), avatarColor, theme, isKids ? 1 : 0, now, now).run();

        return jsonResponse({
          success: true,
          profile: {
            profileId,
            displayName: displayName.trim(),
            avatarColor,
            theme,
            isKids: !!isKids,
            isPrimary: false
          }
        }, 201, corsHeaders);
      }

      // Update Profile (Name, Theme, Color, Kids Mode)
      if (method === 'POST' && pathname === '/api/profiles/update') {
        const { profileId, displayName, avatarColor, theme, isKids } = await request.json().catch(() => ({}));
        if (!profileId) return errorResponse('Profile ID required', 400, corsHeaders);

        const profile = await env.DB.prepare(
          `SELECT profile_id, display_name, avatar_color, theme, is_kids, is_primary FROM profiles WHERE profile_id = ? AND account_id = ?`
        ).bind(profileId, auth.accountId).first();

        if (!profile) return errorResponse('Profile not found', 404, corsHeaders);

        const now = Date.now();
        const newName = (displayName && displayName.trim()) || profile.display_name;
        const newColor = avatarColor || profile.avatar_color;
        const newTheme = theme || profile.theme;
        const newKids = typeof isKids === 'boolean' ? (isKids ? 1 : 0) : profile.is_kids;

        await env.DB.prepare(
          `UPDATE profiles SET display_name = ?, avatar_color = ?, theme = ?, is_kids = ?, updated_at = ? WHERE profile_id = ? AND account_id = ?`
        ).bind(newName, newColor, newTheme, newKids, now, profileId, auth.accountId).run();

        return jsonResponse({
          success: true,
          profile: {
            profileId,
            displayName: newName,
            avatarColor: newColor,
            theme: newTheme,
            isKids: newKids === 1,
            isPrimary: profile.is_primary === 1
          }
        }, 200, corsHeaders);
      }

      // Switch Profile
      if (method === 'POST' && pathname === '/api/profiles/switch') {
        const { profileId } = await request.json().catch(() => ({}));
        if (!profileId) return errorResponse('Profile ID required', 400, corsHeaders);

        const profile = await env.DB.prepare(
          `SELECT profile_id, display_name, avatar_color, theme, is_kids, is_primary FROM profiles WHERE profile_id = ? AND account_id = ?`
        ).bind(profileId, auth.accountId).first();

        if (!profile) return errorResponse('Profile not found', 404, corsHeaders);

        return jsonResponse({
          success: true,
          activeProfileId: profileId,
          profile: {
            profileId: profile.profile_id,
            displayName: profile.display_name,
            avatarColor: profile.avatar_color,
            theme: profile.theme,
            isKids: profile.is_kids === 1,
            isPrimary: profile.is_primary === 1
          }
        }, 200, corsHeaders);
      }

      // Delete Secondary Profile (Guards primary profile!)
      if (method === 'POST' && pathname === '/api/profiles/delete') {
        const { profileId } = await request.json().catch(() => ({}));
        if (!profileId) return errorResponse('Profile ID required', 400, corsHeaders);

        const profile = await env.DB.prepare(
          `SELECT profile_id, is_primary FROM profiles WHERE profile_id = ? AND account_id = ?`
        ).bind(profileId, auth.accountId).first();

        if (!profile) return errorResponse('Profile not found', 404, corsHeaders);
        if (profile.is_primary === 1) {
          return errorResponse('Primary account profile cannot be deleted', 403, corsHeaders);
        }

        await env.DB.prepare(`DELETE FROM profiles WHERE profile_id = ? AND account_id = ?`).bind(profileId, auth.accountId).run();
        await env.DB.prepare(`DELETE FROM profile_data WHERE profile_id = ? AND account_id = ?`).bind(profileId, auth.accountId).run();

        return jsonResponse({ success: true, message: 'Profile deleted' }, 200, corsHeaders);
      }

      // Push Profile Data (Watchlist, Resume Progress, Ratings, Searches)
      if (method === 'POST' && pathname === '/api/sync/push') {
        const { profileId, dataType, items } = await request.json().catch(() => ({}));
        if (!profileId || !dataType || !Array.isArray(items)) {
          return errorResponse('profileId, dataType, and items array required', 400, corsHeaders);
        }
        const now = Date.now();
        // The TV makes its own profile ids; the cloud only knows the ones it was told about. A push for an unknown profile
        // used to fail on the profile link (HTTP 500) and stay "pending" forever, so the profile is registered first.
        const known = await env.DB.prepare(`SELECT profile_id FROM profiles WHERE profile_id = ? AND account_id = ?`).bind(profileId, auth.accountId).first();
        if (!known) {
          const owned = await env.DB.prepare(`SELECT 1 AS x FROM profiles WHERE profile_id = ?`).bind(profileId).first();
          if (owned) return errorResponse('Profile belongs to another account', 403, corsHeaders);
          await env.DB.prepare(
            `INSERT OR IGNORE INTO profiles (profile_id, account_id, display_name, is_kids, is_primary, created_at, updated_at) VALUES (?, ?, 'TV profile', 0, 0, ?, ?)`
          ).bind(profileId, auth.accountId, now, now).run();
        }
        const stmts = items.map(it =>
          env.DB.prepare(
            `INSERT INTO profile_data (profile_id, account_id, data_type, item_key, data_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id, data_type, item_key) DO UPDATE SET
               data_json = excluded.data_json,
               updated_at = excluded.updated_at`
          ).bind(profileId, auth.accountId, dataType, it.itemKey || 'list', JSON.stringify(it.data || it), it.updatedAt || now)
        );

        if (stmts.length > 0) {
          await env.DB.batch(stmts);
        }
        return jsonResponse({ success: true, count: stmts.length }, 200, corsHeaders);
      }

      // Pull Profile Data (Delta Sync)
      if (method === 'GET' && pathname === '/api/sync/pull') {
        const profileId = url.searchParams.get('profile_id');
        const dataType = url.searchParams.get('data_type');
        const updatedSince = parseInt(url.searchParams.get('updated_since') || '0', 10);

        let query = `SELECT profile_id, data_type, item_key, data_json, updated_at FROM profile_data WHERE account_id = ? AND updated_at > ?`;
        const params = [auth.accountId, updatedSince];

        if (profileId) {
          query += ` AND profile_id = ?`;
          params.push(profileId);
        }
        if (dataType) {
          query += ` AND data_type = ?`;
          params.push(dataType);
        }

        const rows = await env.DB.prepare(query).bind(...params).all();
        const results = (rows.results || []).map(r => ({
          profileId: r.profile_id,
          dataType: r.data_type,
          itemKey: r.item_key,
          data: JSON.parse(r.data_json || '{}'),
          updatedAt: r.updated_at
        }));

        return jsonResponse({ success: true, items: results }, 200, corsHeaders);
      }

      return errorResponse('Endpoint not found', 404, corsHeaders);
    } catch (err) {
      console.error('[Worker Fatal Error]', err);
      // Safe, unrevealing error message (Fixes S2/Security)
      return errorResponse('An internal server error occurred', 500, corsHeaders);
    }
  }
};

// --------------------------------------------------------------------
// Web TV Link Portal HTML (Rendered on Phone / Browser)
// --------------------------------------------------------------------

// Accepts only a well-formed TV code (SV-XXXX); anything else is dropped so it can never reach the page.
function cleanTvCode(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return /^SV-[23456789A-HJKLMNP-Z]{4}$/.test(c) ? c : '';
}

function renderWebPairingUi(initialCode = '') {
  const safeCode = cleanTvCode(initialCode);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Link your TV — StreamVault</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background: #090714; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #130E26; border: 1.5px solid #281F4B; border-radius: 16px; width: 100%; max-width: 420px; padding: 26px; box-shadow: 0 20px 50px rgba(0,0,0,.6); }
    h1 { color: #A78BFA; font-size: 24px; font-weight: 800; text-align: center; }
    h2 { font-size: 19px; margin-bottom: 6px; text-align: center; }
    p.sub { color: #94A3B8; font-size: 14px; line-height: 1.45; text-align: center; margin-bottom: 18px; }
    .chip { display: block; margin: 12px auto 18px; width: fit-content; background: #0A0716; border: 1.5px solid #4C1D95; border-radius: 999px; padding: 6px 16px; font-size: 14px; color: #CBD5E1; }
    .chip b { color: #fff; letter-spacing: 2px; font-size: 16px; }
    .tabs { display: flex; gap: 6px; background: #0A0716; padding: 4px; border-radius: 10px; margin-bottom: 18px; }
    .tabs button { flex: 1; padding: 10px; font-size: 14px; font-weight: 600; border: 0; background: transparent; color: #94A3B8; border-radius: 7px; cursor: pointer; }
    .tabs button.on { background: #7C3AED; color: #fff; }
    label { display: block; font-size: 12.5px; font-weight: 600; color: #CBD5E1; margin: 12px 0 6px; }
    input { width: 100%; padding: 13px 14px; background: #0A0716; border: 1.5px solid #281F4B; border-radius: 8px; font-size: 16px; color: #fff; outline: none; }
    input:focus { border-color: #7C3AED; }
    input.big { text-align: center; font-size: 24px; letter-spacing: 6px; }
    .btn { width: 100%; margin-top: 18px; padding: 14px; font-size: 15px; font-weight: 700; border: 0; border-radius: 10px; background: #7C3AED; color: #fff; cursor: pointer; }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn.ghost { background: transparent; border: 1.5px solid #281F4B; color: #CBD5E1; margin-top: 10px; }
    .link { background: none; border: 0; color: #A78BFA; font-size: 13.5px; cursor: pointer; text-decoration: underline; }
    .row { text-align: center; margin-top: 14px; }
    .err { background: #3B0A14; border: 1px solid #7F1D2D; color: #FECACA; font-size: 13.5px; padding: 10px 12px; border-radius: 8px; margin-top: 14px; }
    .note { background: #1B1236; border: 1px solid #3B2A73; color: #DDD6FE; font-size: 13.5px; line-height: 1.45; padding: 10px 12px; border-radius: 8px; margin-bottom: 4px; }
    .ok { text-align: center; }
    .tick { width: 72px; height: 72px; border-radius: 50%; background: #16A34A; display: flex; align-items: center; justify-content: center; font-size: 40px; margin: 6px auto 16px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
<div class="card">
  <h1>StreamVault</h1>

  <!-- Step 1: type the code from the TV (skipped when the QR already carried it) -->
  <section id="viewCode" hidden>
    <h2>Link your TV</h2>
    <p class="sub">Enter the code shown on your TV screen. It looks like <b>SV-AB12</b>.</p>
    <label for="tvCode">Code on your TV</label>
    <input id="tvCode" class="big" maxlength="7" autocomplete="off" autocapitalize="characters" placeholder="SV-XXXX">
    <button class="btn" id="btnCode">Continue</button>
    <div class="err" id="errCode" hidden></div>
  </section>

  <!-- Step 2: sign in or create an account -->
  <section id="viewAuth" hidden>
    <h2 id="authTitle">Sign in to link your TV</h2>
    <span class="chip">TV code <b class="tvCodeText"></b></span>
    <div class="tabs">
      <button id="tabIn" class="on" type="button">Sign in</button>
      <button id="tabUp" type="button">Create account</button>
    </div>
    <form id="formIn" novalidate>
      <label for="inEmail">Email</label>
      <input id="inEmail" type="email" autocomplete="email" inputmode="email">
      <label for="inPass">Password</label>
      <input id="inPass" type="password" autocomplete="current-password">
      <button class="btn" id="btnIn" type="submit">Sign in &amp; link TV</button>
    </form>
    <form id="formUp" novalidate hidden>
      <label for="upName">Your name</label>
      <input id="upName" autocomplete="name">
      <label for="upEmail">Email</label>
      <input id="upEmail" type="email" autocomplete="email" inputmode="email">
      <label for="upPass">Password (at least 6 characters)</label>
      <input id="upPass" type="password" autocomplete="new-password">
      <button class="btn" id="btnUp" type="submit">Create account</button>
    </form>
    <div class="err" id="errAuth" hidden></div>
    <div class="row"><button class="link" id="btnOtherCode" type="button">Wrong TV code?</button></div>
  </section>

  <!-- Step 3: email verification (only for new accounts) -->
  <section id="viewVerify" hidden>
    <h2>Check your email</h2>
    <p class="sub">We sent a 6-digit code to <b id="verifyEmail"></b>.</p>
    <div class="note">This is <b>not</b> the code on your TV. Type the 6 digits from the email here.</div>
    <label for="verCode">6-digit email code</label>
    <input id="verCode" class="big" maxlength="6" inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
    <button class="btn" id="btnVerify">Verify &amp; link TV</button>
    <div class="err" id="errVerify" hidden></div>
    <div class="row"><button class="link" id="btnResend" type="button">Send the code again</button> · <button class="link" id="btnBackAuth" type="button">Change email</button></div>
  </section>

  <!-- Already signed in on this phone: one tap -->
  <section id="viewConfirm" hidden>
    <h2>Link this TV?</h2>
    <span class="chip">TV code <b class="tvCodeText"></b></span>
    <p class="sub">Your TV will be signed in as <b id="confirmEmail"></b>.</p>
    <button class="btn" id="btnConfirm">Yes, link my TV</button>
    <button class="btn ghost" id="btnSwitch">Use a different account</button>
    <div class="err" id="errConfirm" hidden></div>
  </section>

  <!-- Finished -->
  <section id="viewDone" class="ok" hidden>
    <div class="tick">✓</div>
    <h2>Your TV is linked</h2>
    <p class="sub">Look at your TV — it signs in by itself in a few seconds.<br>You can close this page.</p>
  </section>
</div>

<script>
(function () {
  var INITIAL = ${JSON.stringify(safeCode)};
  var tvCode = INITIAL;
  var pendingEmail = '';
  var pendingPassword = '';
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['viewCode', 'viewAuth', 'viewVerify', 'viewConfirm', 'viewDone'];

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function show(id) {
    VIEWS.forEach(function (v) { $(v).hidden = (v !== id); });
    Array.prototype.forEach.call(document.querySelectorAll('.tvCodeText'), function (el) { el.textContent = tvCode; });
    ['errCode', 'errAuth', 'errVerify', 'errConfirm'].forEach(function (e) { $(e).hidden = true; });
  }
  function fail(id, msg) { var el = $(id); el.textContent = msg; el.hidden = false; }
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? 'Please wait…' : label; }

  function api(path, method, body, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); })
      .catch(function () { return { status: 0, data: { error: 'No internet connection. Please try again.' } }; });
  }
  function errText(res) { return (res.data && (res.data.error || res.data.message)) || 'Something went wrong. Please try again.'; }

  // Tell the server this phone's account owns the TV code. This is the ONLY place the TV gets linked.
  function linkTv(token, errId) {
    return api('/api/auth/claim-code', 'POST', { code: tvCode }, token).then(function (res) {
      if (res.status === 200 && res.data.success) { show('viewDone'); return true; }
      if (res.status === 401) { store('sv_web_token', null); show('viewAuth'); fail('errAuth', 'Please sign in again.'); return false; }
      if (res.status === 400) { tvCode = ''; show('viewCode'); fail('errCode', 'That TV code has expired or was already used. Look at your TV for the new code.'); return false; }
      fail(errId, errText(res)); return false;
    });
  }

  function afterSignedIn(token, email) {
    store('sv_web_token', token);
    store('sv_web_email', email);
    return linkTv(token, 'errAuth');
  }

  function start() {
    var token = load('sv_web_token');
    if (!tvCode) { show('viewCode'); return; }
    if (!token) { show('viewAuth'); return; }
    api('/api/auth/me', 'GET', null, token).then(function (res) {
      if (res.status === 200 && res.data.authenticated) {
        $('confirmEmail').textContent = (res.data.account && res.data.account.email) || load('sv_web_email') || 'your account';
        show('viewConfirm');
      } else { store('sv_web_token', null); show('viewAuth'); }
    });
  }

  // ---- Step 1
  function submitCode() {
    var c = $('tvCode').value.trim().toUpperCase();
    if (/^[23456789A-HJKLMNP-Z]{4}$/.test(c)) c = 'SV-' + c;
    if (!/^SV-[23456789A-HJKLMNP-Z]{4}$/.test(c)) { fail('errCode', 'Type the code exactly as shown on your TV, like SV-AB12.'); return; }
    tvCode = c; start();
  }
  $('btnCode').onclick = submitCode;
  $('tvCode').onkeydown = function (e) { if (e.key === 'Enter') submitCode(); };
  $('btnOtherCode').onclick = function () { tvCode = ''; $('tvCode').value = ''; show('viewCode'); };

  // ---- Step 2
  function setMode(up) {
    $('tabIn').className = up ? '' : 'on'; $('tabUp').className = up ? 'on' : '';
    $('formIn').hidden = up; $('formUp').hidden = !up;
    $('authTitle').textContent = up ? 'Create your account' : 'Sign in to link your TV';
    $('errAuth').hidden = true;
  }
  $('tabIn').onclick = function () { setMode(false); };
  $('tabUp').onclick = function () { setMode(true); };

  $('formIn').onsubmit = function (e) {
    e.preventDefault();
    var email = $('inEmail').value.trim(), pass = $('inPass').value;
    if (!email || !pass) { fail('errAuth', 'Enter your email and password.'); return; }
    busy($('btnIn'), true);
    api('/api/auth/login', 'POST', { email: email, password: pass }).then(function (res) {
      busy($('btnIn'), false, 'Sign in & link TV');
      if (res.status !== 200 || !res.data.token) { fail('errAuth', errText(res)); return; }
      if (res.data.isVerified === false) {            // never finished email verification: do that first
        pendingEmail = email; pendingPassword = pass;
        api('/api/auth/resend-code', 'POST', { email: email }).then(function () { gotoVerify(email); });
        return;
      }
      afterSignedIn(res.data.token, res.data.email || email);
    });
  };

  $('formUp').onsubmit = function (e) {
    e.preventDefault();
    var name = $('upName').value.trim(), email = $('upEmail').value.trim(), pass = $('upPass').value;
    if (!email || pass.length < 6) { fail('errAuth', 'Enter a valid email and a password of at least 6 characters.'); return; }
    busy($('btnUp'), true);
    api('/api/auth/signup', 'POST', { email: email, password: pass, displayName: name || 'Account Owner' }).then(function (res) {
      busy($('btnUp'), false, 'Create account');
      if (res.status !== 201 && res.status !== 200) { fail('errAuth', errText(res)); return; }
      pendingEmail = email; pendingPassword = pass;
      if (res.data.requireVerification) gotoVerify(email);
      else api('/api/auth/login', 'POST', { email: email, password: pass }).then(function (l) { if (l.data.token) afterSignedIn(l.data.token, email); else fail('errAuth', errText(l)); });
    });
  };

  // ---- Step 3
  var resendTimer = null;
  function gotoVerify(email) {
    $('verifyEmail').textContent = email; $('verCode').value = '';
    show('viewVerify');
    cooldown();
  }
  function cooldown() {
    var left = 30, b = $('btnResend'); b.disabled = true;
    clearInterval(resendTimer);
    resendTimer = setInterval(function () {
      left--; if (left <= 0) { clearInterval(resendTimer); b.disabled = false; b.textContent = 'Send the code again'; }
      else b.textContent = 'Send the code again (' + left + 's)';
    }, 1000);
    b.textContent = 'Send the code again (30s)';
  }
  $('btnResend').onclick = function () {
    api('/api/auth/resend-code', 'POST', { email: pendingEmail }).then(function (res) {
      if (res.status === 200) { fail('errVerify', 'A new code was sent.'); $('errVerify').style.background = '#0F2A1A'; $('errVerify').style.borderColor = '#166534'; $('errVerify').style.color = '#BBF7D0'; cooldown(); }
      else { $('errVerify').removeAttribute('style'); fail('errVerify', errText(res)); }
    });
  };
  $('btnBackAuth').onclick = function () { clearInterval(resendTimer); setMode(true); show('viewAuth'); };
  function submitVerify() {
    var c = $('verCode').value.replace(/\\D/g, '');
    $('errVerify').removeAttribute('style');
    if (c.length !== 6) { fail('errVerify', 'Type the 6 digits from the email.'); return; }
    busy($('btnVerify'), true);
    api('/api/auth/verify-code', 'POST', { email: pendingEmail, code: c }).then(function (res) {
      busy($('btnVerify'), false, 'Verify & link TV');
      if (res.status !== 200 || !res.data.token) { fail('errVerify', errText(res)); return; }
      pendingPassword = '';
      afterSignedIn(res.data.token, pendingEmail).then(function (okLinked) { if (!okLinked && !$('viewVerify').hidden) fail('errVerify', 'Verified, but linking failed. Please try again.'); });
    });
  }
  $('btnVerify').onclick = submitVerify;
  $('verCode').onkeydown = function (e) { if (e.key === 'Enter') submitVerify(); };

  // ---- Already signed in
  $('btnConfirm').onclick = function () {
    busy($('btnConfirm'), true);
    linkTv(load('sv_web_token'), 'errConfirm').then(function () { busy($('btnConfirm'), false, 'Yes, link my TV'); });
  };
  $('btnSwitch').onclick = function () {
    var t = load('sv_web_token');
    if (t) api('/api/auth/signout', 'POST', null, t);
    store('sv_web_token', null); setMode(false); show('viewAuth');
  };

  start();
})();
</script>
</body>
</html>`;
}
