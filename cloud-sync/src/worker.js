/**
 * ====================================================================
 * StreamVault TV — Cloud Sync & Universal Account Engine
 * Cloudflare Worker + Cloudflare D1 Serverless Database
 * ====================================================================
 */

// Rate limiting in-memory bucket (Worker isolate lifetime)
const RATE_LIMIT_MAP = new Map();
function checkRateLimit(ip, bucket, maxRequests = 15, windowSeconds = 60) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const record = RATE_LIMIT_MAP.get(key) || { count: 0, resetAt: now + windowSeconds * 1000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowSeconds * 1000;
  }
  record.count++;
  RATE_LIMIT_MAP.set(key, record);
  return record.count <= maxRequests;
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
  const secret = env.AES_SECRET || env.ENCRYPTION_KEY || 'sv_default_secure_vault_key_2026';
  const enc = new TextEncoder();
  const rawKey = await crypto.subtle.digest('SHA-256', enc.encode(secret));
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
// Resend Email Integration
// --------------------------------------------------------------------

async function sendVerificationEmail(email, code, env) {
  if (!env.RESEND_API_KEY) {
    console.warn(`[StreamVault Auth] RESEND_API_KEY not configured. Verification code for ${email}: ${code}`);
    return { sent: false, note: 'RESEND_API_KEY not set in Worker secrets' };
  }
  try {
    const fromAddr = env.EMAIL_FROM || 'StreamVault TV <onboarding@resend.dev>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddr,
        to: email,
        subject: `${code} is your StreamVault TV verification code`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; background: #090714; color: #FFFFFF; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #A78BFA; font-size: 24px; margin: 0 0 8px;">StreamVault TV</h1>
              <p style="color: #94A3B8; font-size: 14px; margin: 0;">Standalone Cloud Account Verification</p>
            </div>
            <div style="background: #15102A; border: 1px solid #2E2356; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px;">
              <p style="color: #E2E8F0; font-size: 14px; margin-top: 0;">Enter this 6-digit code on your TV or mobile pairing screen:</p>
              <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #8B5CF6; margin: 16px 0;">${code}</div>
              <p style="color: #64748B; font-size: 12px; margin-bottom: 0;">Valid for 10 minutes. Never share this code.</p>
            </div>
            <p style="color: #64748B; font-size: 11px; text-align: center; margin: 0;">If you didn't request this code, you can safely ignore this email.</p>
          </div>
        `
      })
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    console.error('[Resend Error]', err);
    return { sent: false, error: err.message };
  }
}

// --------------------------------------------------------------------
// Worker Request Router
// --------------------------------------------------------------------

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
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // ================================================================
      // AUTH ENDPOINTS (Public / Verification)
      // ================================================================

      // A. Sign Up (PBKDF2 + Email Verification Code)
      if (method === 'POST' && pathname === '/api/auth/signup') {
        if (!checkRateLimit(clientIp, 'signup', 5, 60)) {
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

        // Generate 6-digit confirmation code
        const codeNum = Math.floor(100000 + Math.random() * 900000);
        const codeStr = String(codeNum);
        const codeId = crypto.randomUUID();
        const expiresAt = now + 10 * 60 * 1000; // 10 minutes

        await env.DB.prepare(
          `INSERT INTO email_codes (code_id, email, code, purpose, attempts, is_used, expires_at, created_at)
           VALUES (?, ?, ?, 'verify_email', 0, 0, ?, ?)`
        ).bind(codeId, cleanEmail, codeStr, expiresAt, now).run();

        // Send email via Resend
        const emailResult = await sendVerificationEmail(cleanEmail, codeStr, env);

        return jsonResponse({
          success: true,
          requireVerification: true,
          email: cleanEmail,
          message: 'Verification code sent to your email',
          devCode: !env.RESEND_API_KEY ? codeStr : undefined // Helps local setup before RESEND_API_KEY secret is populated
        }, 201, corsHeaders);
      }

      // B. Verify Email Code
      if (method === 'POST' && pathname === '/api/auth/verify-code') {
        if (!checkRateLimit(clientIp, 'verify', 10, 60)) {
          return errorResponse('Too many verification attempts. Please wait 1 minute.', 429, corsHeaders);
        }
        const { email, code } = await request.json().catch(() => ({}));
        if (!email || !code) return errorResponse('Email and code are required', 400, corsHeaders);
        const cleanEmail = email.trim().toLowerCase();
        const cleanCode = String(code).trim();
        const now = Date.now();

        const codeRecord = await env.DB.prepare(
          `SELECT code_id, attempts, is_used, expires_at
           FROM email_codes
           WHERE email = ? AND code = ? AND is_used = 0
           ORDER BY created_at DESC LIMIT 1`
        ).bind(cleanEmail, cleanCode).first();

        if (!codeRecord) {
          // Increment attempts on recent codes for this email
          await env.DB.prepare(
            `UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND is_used = 0`
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

        const account = await env.DB.prepare(`SELECT account_id FROM accounts WHERE email = ?`).bind(cleanEmail).first();

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
          profiles: profiles.results || []
        }, 200, corsHeaders);
      }

      // C. Sign In (PBKDF2 Check + Session Issue)
      if (method === 'POST' && pathname === '/api/auth/login') {
        if (!checkRateLimit(clientIp, 'login', 8, 60)) {
          return errorResponse('Too many login attempts. Please wait 1 minute.', 429, corsHeaders);
        }
        const { email, password } = await request.json().catch(() => ({}));
        if (!email || !password) return errorResponse('Email and password are required', 400, corsHeaders);

        const cleanEmail = email.trim().toLowerCase();
        const account = await env.DB.prepare(
          `SELECT account_id, email, password_hash, is_verified FROM accounts WHERE email = ?`
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

        const cleanCode = codeParam.trim().toUpperCase();
        const now = Date.now();

        const record = await env.DB.prepare(
          `SELECT status, exchange_token, expires_at FROM pairing_codes WHERE code = ?`
        ).bind(cleanCode).first();

        if (!record || now > record.expires_at) {
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

        const account = await env.DB.prepare(`SELECT email FROM accounts WHERE account_id = ?`).bind(record.account_id).first();
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
          profiles: profiles.results || [],
          playlists: decryptedPlaylists
        }, 200, corsHeaders);
      }

      // ================================================================
      // AUTHENTICATED ENDPOINTS (Requires Bearer Session Token)
      // Every endpoint below verifies ownership via auth.accountId (Fixes S2)
      // ================================================================

      const auth = await authenticate(request, env);
      if (!auth) {
        return errorResponse('Unauthorized: Valid Bearer session token required', 401, corsHeaders);
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
        const now = Date.now();
        const playlistId = 'pl_' + crypto.randomUUID().substring(0, 10);
        const passEnc = await encryptData(password, env);

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
          passEnc = await encryptData(password.trim(), env);
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
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        const rows = await env.DB.prepare(
          `SELECT item_id, playlist_id, dedup_key, media_type, title, clean_title, year, tmdb_id,
                  overview, poster_path, backdrop_path, rating, runtime_mins, genres_json,
                  versions_json, episodes_json, is_adult, is_removed, removed_at, updated_at
           FROM catalog_items
           WHERE account_id = ? AND updated_at > ?
           ORDER BY updated_at ASC
           LIMIT ? OFFSET ?`
        ).bind(auth.accountId, updatedSince, limit, offset).all();

        const countRow = await env.DB.prepare(
          `SELECT COUNT(*) as total FROM catalog_items WHERE account_id = ? AND updated_at > ?`
        ).bind(auth.accountId, updatedSince).first();

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
        return jsonResponse({
          success: true,
          items,
          total,
          hasMore: offset + items.length < total
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
             WHERE account_id = ? AND dedup_key = ?`
          ).bind(now, now, auth.accountId, k)
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
      // SHARED TMDB PROXY & CACHE (Proxy TMDB so key is not in APK)
      // ----------------------------------------------------------------

      if (method === 'GET' && pathname.startsWith('/api/tmdb/')) {
        const subPath = pathname.replace('/api/tmdb/', '');
        const apiKey = env.TMDB_API_KEY || '8265bd1679663a7ea12ac168da84d2e8'; // Fallback community read key
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

        if (tmdbRes.ok) {
          // Cache response for 7 days
          const expiresAt = now + 7 * 86400 * 1000;
          await env.DB.prepare(
            `INSERT INTO tmdb_cache (cache_key, endpoint, response_json, expires_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at`
          ).bind(cacheKey, subPath, resText, expiresAt, now).run();
        }

        return new Response(resText, {
          status: tmdbRes.status,
          headers: {
            ...corsHeaders,
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

function renderWebPairingUi(initialCode = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>StreamVault TV — Account & TV Link</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background: #090714; color: #FFFFFF; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #130E26; border: 1.5px solid #281F4B; border-radius: 16px; width: 100%; max-width: 440px; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo h1 { color: #A78BFA; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .logo p { color: #94A3B8; font-size: 13.5px; margin-top: 4px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 20px; background: #0A0716; padding: 4px; border-radius: 10px; border: 1px solid #1E1638; }
    .tab-btn { flex: 1; padding: 8px 12px; font-size: 12.5px; font-weight: 600; border: none; background: transparent; color: #94A3B8; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
    .tab-btn.active { background: #7C3AED; color: #FFFFFF; }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: #CBD5E1; margin-bottom: 6px; }
    .form-group input { width: 100%; padding: 12px 14px; background: #0A0716; border: 1.5px solid #281F4B; border-radius: 8px; font-size: 14px; color: #FFFFFF; outline: none; transition: border-color 0.2s; }
    .form-group input:focus { border-color: #7C3AED; }
    .btn { width: 100%; padding: 13px; font-size: 14.5px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; background: #7C3AED; color: #FFFFFF; transition: opacity 0.2s; margin-top: 8px; }
    .btn:hover { opacity: 0.92; }
    .code-box { text-align: center; letter-spacing: 6px; font-size: 24px; font-weight: 800; text-transform: uppercase; }
    .toast { display: none; padding: 12px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; font-weight: 500; }
    .toast.error { display: block; background: rgba(239,68,68,0.15); border: 1px solid #EF4444; color: #FCA5A5; }
    .toast.success { display: block; background: rgba(16,185,129,0.15); border: 1px solid #10B981; color: #6EE7B7; }
    .logged-box { background: #1B1438; border: 1px solid #3B2D6B; border-radius: 10px; padding: 16px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center; }
    .logged-email { font-size: 13.5px; font-weight: 600; color: #E2E8F0; }
    .btn-link-sm { font-size: 12px; color: #A78BFA; background: none; border: none; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <h1>StreamVault TV</h1>
      <p>Cloud TV Link & Account Portal</p>
    </div>

    <div id="toast" class="toast"></div>

    <div id="loggedHeader" style="display: none;" class="logged-box">
      <div>
        <div style="font-size: 11px; color: #94A3B8;">Signed in as</div>
        <div id="loggedEmailText" class="logged-email"></div>
      </div>
      <button class="btn-link-sm" onclick="signOut()">Sign Out</button>
    </div>

    <div id="authTabs" class="tabs">
      <button id="tabBtnPair" class="tab-btn active" onclick="switchTab('pair')">Link TV</button>
      <button id="tabBtnSignIn" class="tab-btn" onclick="switchTab('signin')">Sign In</button>
      <button id="tabBtnSignUp" class="tab-btn" onclick="switchTab('signup')">Sign Up</button>
    </div>

    <!-- 1. Pair TV Code Tab -->
    <div id="panePair">
      <div class="form-group">
        <label>Enter 6-Character TV Code</label>
        <input id="inpTvCode" type="text" class="code-box" maxlength="7" placeholder="SV-XXXX" value="${initialCode}">
      </div>
      <button class="btn" onclick="handleClaimCode()">🔗 Link TV Screen</button>
    </div>

    <!-- 2. Sign In Tab -->
    <div id="paneSignIn" style="display: none;">
      <div class="form-group">
        <label>Email Address</label>
        <input id="inpLoginEmail" type="email" placeholder="name@example.com">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input id="inpLoginPass" type="password" placeholder="••••••••">
      </div>
      <button class="btn" onclick="handleLogin()">Sign In</button>
    </div>

    <!-- 3. Sign Up Tab -->
    <div id="paneSignUp" style="display: none;">
      <div class="form-group">
        <label>Display Name</label>
        <input id="inpRegName" type="text" placeholder="Waleed Khan">
      </div>
      <div class="form-group">
        <label>Email Address</label>
        <input id="inpRegEmail" type="email" placeholder="name@example.com">
      </div>
      <div class="form-group">
        <label>Password (min 6 chars)</label>
        <input id="inpRegPass" type="password" placeholder="••••••••">
      </div>
      <button class="btn" onclick="handleSignUp()">Create Account</button>
    </div>

    <!-- 4. Verify Code Pane -->
    <div id="paneVerify" style="display: none;">
      <p style="font-size: 13px; color: #CBD5E1; margin-bottom: 12px; text-align: center;">We emailed a 6-digit verification code to <b id="verifyEmailTarget"></b></p>
      <div class="form-group">
        <label>Enter 6-Digit Email Code</label>
        <input id="inpVerifyCode" type="text" class="code-box" maxlength="6" placeholder="123456">
      </div>
      <button class="btn" onclick="handleVerify()">Confirm Code</button>
    </div>
  </div>

  <script>
    function showToast(msg, isError = true) {
      const t = document.getElementById('toast');
      t.className = isError ? 'toast error' : 'toast success';
      t.innerText = msg;
    }

    function switchTab(tab) {
      document.getElementById('panePair').style.display = tab === 'pair' ? 'block' : 'none';
      document.getElementById('paneSignIn').style.display = tab === 'signin' ? 'block' : 'none';
      document.getElementById('paneSignUp').style.display = tab === 'signup' ? 'block' : 'none';
      document.getElementById('paneVerify').style.display = 'none';

      document.getElementById('tabBtnPair').className = tab === 'pair' ? 'tab-btn active' : 'tab-btn';
      document.getElementById('tabBtnSignIn').className = tab === 'signin' ? 'tab-btn active' : 'tab-btn';
      document.getElementById('tabBtnSignUp').className = tab === 'signup' ? 'tab-btn active' : 'tab-btn';
    }

    function checkAuthState() {
      const token = localStorage.getItem('sv_auth_token');
      const email = localStorage.getItem('sv_auth_email');
      if (token && email) {
        document.getElementById('loggedHeader').style.display = 'flex';
        document.getElementById('loggedEmailText').innerText = email;
        document.getElementById('tabBtnSignIn').style.display = 'none';
        document.getElementById('tabBtnSignUp').style.display = 'none';
        switchTab('pair');
      } else {
        document.getElementById('loggedHeader').style.display = 'none';
        document.getElementById('tabBtnSignIn').style.display = 'block';
        document.getElementById('tabBtnSignUp').style.display = 'block';
      }
    }

    async function handleLogin() {
      const email = document.getElementById('inpLoginEmail').value.trim();
      const password = document.getElementById('inpLoginPass').value;
      if (!email || !password) return showToast('Please enter email and password');
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Login failed');
        localStorage.setItem('sv_auth_token', data.token);
        localStorage.setItem('sv_auth_email', data.email);
        localStorage.setItem('sv_account_id', data.accountId);
        checkAuthState();
        showToast('Signed in successfully!', false);
      } catch (e) {
        showToast('Network error during login');
      }
    }

    let pendingEmail = '';
    async function handleSignUp() {
      const displayName = document.getElementById('inpRegName').value.trim();
      const email = document.getElementById('inpRegEmail').value.trim();
      const password = document.getElementById('inpRegPass').value;
      if (!email || !password) return showToast('Please enter all required fields');
      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, email, password })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Sign up failed');
        pendingEmail = email;
        document.getElementById('verifyEmailTarget').innerText = email;
        document.getElementById('paneSignUp').style.display = 'none';
        document.getElementById('paneVerify').style.display = 'block';
        if (data.devCode) {
          showToast('Verification code sent! (Dev test code: ' + data.devCode + ')', false);
        } else {
          showToast('Verification code sent to your email!', false);
        }
      } catch (e) {
        showToast('Network error during sign up');
      }
    }

    async function handleVerify() {
      const code = document.getElementById('inpVerifyCode').value.trim();
      if (!code) return showToast('Please enter 6-digit code');
      try {
        const res = await fetch('/api/auth/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingEmail, code })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Verification failed');
        localStorage.setItem('sv_auth_token', data.token);
        localStorage.setItem('sv_auth_email', data.email);
        localStorage.setItem('sv_account_id', data.accountId);
        checkAuthState();
        showToast('Email verified and signed in!', false);
      } catch (e) {
        showToast('Network error during verification');
      }
    }

    async function handleClaimCode() {
      const token = localStorage.getItem('sv_auth_token');
      if (!token) {
        showToast('Please Sign In or Create an Account first to link your TV');
        switchTab('signin');
        return;
      }
      const code = document.getElementById('inpTvCode').value.trim();
      if (!code) return showToast('Please enter the 6-character code shown on TV');
      try {
        const res = await fetch('/api/auth/claim-code', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed to link TV');
        showToast('🎉 ' + data.message, false);
      } catch (e) {
        showToast('Network error linking TV code');
      }
    }

    function signOut() {
      const token = localStorage.getItem('sv_auth_token');
      if (token) {
        fetch('/api/auth/signout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token }
        }).catch(() => {});
      }
      localStorage.clear();
      checkAuthState();
      showToast('Signed out successfully', false);
    }

    checkAuthState();
  </script>
</body>
</html>`;
}
