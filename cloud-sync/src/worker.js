/**
 * StreamVault TV Cloud Sync & Universal Account Engine
 * Cloudflare Worker + Cloudflare D1 Serverless Database
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS Headers for TV App, Mobile App, and Browser Access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Web Link & Pairing UI for Mobile / Browser
      if (pathname === '/' || pathname === '/link') {
        const codeParam = url.searchParams.get('code') || '';
        return new Response(renderWebPairingUi(codeParam), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 2. User Sign Up (Email + Password)
      if (method === 'POST' && pathname === '/api/auth/signup') {
        const { email, password, displayName = 'Account Owner', iptvServer = '', iptvUser = '', iptvPass = '', playlistName = 'StreamVault IPTV' } = await request.json().catch(() => ({}));
        if (!email || !password) {
          return new Response(JSON.stringify({ error: 'Email and password are required' }), { status: 400, headers: corsHeaders });
        }

        const cleanEmail = email.trim().toLowerCase();
        if (cleanEmail.length < 5 || !cleanEmail.includes('@')) {
          return new Response(JSON.stringify({ error: 'Please enter a valid email address' }), { status: 400, headers: corsHeaders });
        }
        if (password.length < 6) {
          return new Response(JSON.stringify({ error: 'Password must be at least 6 characters' }), { status: 400, headers: corsHeaders });
        }

        if (!env.DB) {
          return new Response(JSON.stringify({ error: 'Cloud database connection unavailable' }), { status: 503, headers: corsHeaders });
        }

        // Check if account already exists
        const existing = await env.DB.prepare('SELECT account_id FROM accounts WHERE email = ?').bind(cleanEmail).first();
        if (existing) {
          return new Response(JSON.stringify({ error: 'An account with this email already exists. Please sign in instead.' }), { status: 409, headers: corsHeaders });
        }

        const salt = generateSalt();
        const hash = await hashPassword(password, salt);
        const passwordHash = `${salt}:${hash}`;
        const accountId = 'acc_' + hashStr(cleanEmail + Date.now());
        const now = Date.now();

        // Create Account
        await env.DB.prepare(
          `INSERT INTO accounts (account_id, email, password_hash, iptv_server_url, iptv_username, iptv_password, playlist_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(accountId, cleanEmail, passwordHash, iptvServer, iptvUser, iptvPass, playlistName, now, now).run();

        // Create Default Profile
        const profileId = 'prof_' + accountId + '_1';
        await env.DB.prepare(
          `INSERT INTO profiles (profile_id, account_id, display_name, avatar_color, is_kids, created_at, updated_at)
           VALUES (?, ?, ?, '#8B5CF6', 0, ?, ?)`
        ).bind(profileId, accountId, displayName, now, now).run();

        const token = generateAuthToken(accountId, passwordHash);

        const account = {
          accountId,
          email: cleanEmail,
          displayName,
          iptvServerUrl: iptvServer,
          iptvUsername: iptvUser,
          iptvPassword: iptvPass,
          playlistName
        };

        const profiles = [{
          profileId,
          accountId,
          displayName,
          avatarColor: '#8B5CF6',
          isKids: 0
        }];

        return new Response(JSON.stringify({
          success: true,
          message: 'Account created successfully',
          token,
          account,
          profiles,
          syncData: []
        }), { headers: corsHeaders });
      }

      // 3. User Sign In (Email + Password)
      if (method === 'POST' && pathname === '/api/auth/login') {
        const { email, password } = await request.json().catch(() => ({}));
        if (!email || !password) {
          return new Response(JSON.stringify({ error: 'Email and password are required' }), { status: 400, headers: corsHeaders });
        }

        const cleanEmail = email.trim().toLowerCase();
        if (!env.DB) {
          return new Response(JSON.stringify({ error: 'Cloud database connection unavailable' }), { status: 503, headers: corsHeaders });
        }

        const row = await env.DB.prepare(
          'SELECT * FROM accounts WHERE email = ?'
        ).bind(cleanEmail).first();

        if (!row) {
          return new Response(JSON.stringify({ error: 'No account found with this email. Please check spelling or create an account.' }), { status: 404, headers: corsHeaders });
        }

        if (!row.password_hash) {
          return new Response(JSON.stringify({ error: 'No password is set for this account. Please create an account or reset.' }), { status: 401, headers: corsHeaders });
        }

        const parts = row.password_hash.split(':');
        if (parts.length === 2) {
          const [salt, expectedHash] = parts;
          const actualHash = await hashPassword(password, salt);
          if (actualHash !== expectedHash) {
            return new Response(JSON.stringify({ error: 'Incorrect password. Please try again.' }), { status: 401, headers: corsHeaders });
          }
        } else {
          return new Response(JSON.stringify({ error: 'Invalid password format. Please reset your password.' }), { status: 401, headers: corsHeaders });
        }

        // Fetch profiles & sync data
        const { results: profiles } = await env.DB.prepare(
          'SELECT * FROM profiles WHERE account_id = ?'
        ).bind(row.account_id).all();

        const { results: syncData } = await env.DB.prepare(
          `SELECT s.* FROM user_sync_data s JOIN profiles p ON s.profile_id = p.profile_id WHERE p.account_id = ?`
        ).bind(row.account_id).all();

        const token = generateAuthToken(row.account_id, row.password_hash);

        const account = {
          accountId: row.account_id,
          email: row.email,
          displayName: (profiles && profiles[0] && profiles[0].display_name) || row.email.split('@')[0],
          iptvServerUrl: row.iptv_server_url || '',
          iptvUsername: row.iptv_username || '',
          iptvPassword: row.iptv_password || '',
          playlistName: row.playlist_name || 'StreamVault IPTV'
        };

        return new Response(JSON.stringify({
          success: true,
          message: 'Signed in successfully',
          token,
          account,
          profiles: profiles || [],
          syncData: syncData || []
        }), { headers: corsHeaders });
      }

      // 4. Update IPTV Credentials in Cloud Account
      if (method === 'POST' && pathname === '/api/account/update-credentials') {
        const { accountId, token, iptvServerUrl, iptvUsername, iptvPassword, playlistName } = await request.json().catch(() => ({}));
        if (!accountId) {
          return new Response(JSON.stringify({ error: 'Missing accountId' }), { status: 400, headers: corsHeaders });
        }

        if (env.DB) {
          // Optional security check if token provided
          if (token) {
            const acc = await env.DB.prepare('SELECT password_hash FROM accounts WHERE account_id = ?').bind(accountId).first();
            if (acc && generateAuthToken(accountId, acc.password_hash) !== token) {
              return new Response(JSON.stringify({ error: 'Unauthorized: Session invalid' }), { status: 401, headers: corsHeaders });
            }
          }

          await env.DB.prepare(
            `UPDATE accounts SET 
               iptv_server_url = ?,
               iptv_username = ?,
               iptv_password = ?,
               playlist_name = ?,
               updated_at = ?
             WHERE account_id = ?`
          ).bind(iptvServerUrl || '', iptvUsername || '', iptvPassword || '', playlistName || 'StreamVault IPTV', Date.now(), accountId).run();
        }

        return new Response(JSON.stringify({ success: true, message: 'IPTV credentials synced to cloud account' }), { headers: corsHeaders });
      }

      // 5. Request TV Link Code (TV calls this to get SV-XXXX)
      if (method === 'POST' && pathname === '/api/auth/request-code') {
        const { deviceId = 'tv-generic' } = await request.json().catch(() => ({}));
        const code = generateTvCode();
        const now = Date.now();
        const expiresAt = now + 15 * 60 * 1000; // 15 minutes

        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO tv_codes (code, device_id, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)`
          ).bind(code, deviceId, now, expiresAt).run();
        }

        const pairUrl = `${url.origin}/link?code=${code}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(pairUrl)}`;

        return new Response(JSON.stringify({
          success: true,
          code,
          expiresAt,
          qrUrl,
          pairUrl
        }), { headers: corsHeaders });
      }

      // 6. Poll TV Link Code Status (TV calls this every few seconds)
      if (method === 'GET' && pathname === '/api/auth/poll-code') {
        const code = url.searchParams.get('code');
        if (!code) {
          return new Response(JSON.stringify({ error: 'Missing code' }), { status: 400, headers: corsHeaders });
        }

        if (!env.DB) {
          return new Response(JSON.stringify({ status: 'pending' }), { headers: corsHeaders });
        }

        const row = await env.DB.prepare(
          `SELECT * FROM tv_codes WHERE code = ? AND expires_at > ?`
        ).bind(code, Date.now()).first();

        if (!row) {
          return new Response(JSON.stringify({ status: 'expired' }), { headers: corsHeaders });
        }

        if (row.status === 'claimed' && row.account_id) {
          const account = await env.DB.prepare(
            `SELECT * FROM accounts WHERE account_id = ?`
          ).bind(row.account_id).first();

          const { results: profiles } = await env.DB.prepare(
            `SELECT * FROM profiles WHERE account_id = ?`
          ).bind(row.account_id).all();

          const { results: syncData } = await env.DB.prepare(
            `SELECT s.* FROM user_sync_data s JOIN profiles p ON s.profile_id = p.profile_id WHERE p.account_id = ?`
          ).bind(row.account_id).all();

          return new Response(JSON.stringify({
            status: 'claimed',
            accountId: row.account_id,
            account: {
              accountId: account.account_id,
              email: account.email,
              displayName: (profiles && profiles[0] && profiles[0].display_name) || account.email.split('@')[0],
              iptvServerUrl: account.iptv_server_url || '',
              iptvUsername: account.iptv_username || '',
              iptvPassword: account.iptv_password || '',
              playlistName: account.playlist_name || 'StreamVault IPTV'
            },
            profiles: profiles || [],
            syncData: syncData || []
          }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ status: 'pending' }), { headers: corsHeaders });
      }

      // 7. Securely Claim TV Link Code (Only authenticated users can link)
      if (method === 'POST' && pathname === '/api/auth/claim-code') {
        const { code, accountId, token, email, password } = await request.json().catch(() => ({}));
        if (!code) {
          return new Response(JSON.stringify({ error: 'Missing TV pairing code' }), { status: 400, headers: corsHeaders });
        }

        const cleanCode = code.trim().toUpperCase();
        if (!env.DB) {
          return new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: corsHeaders });
        }

        // Verify TV pairing code is valid and pending
        const codeRow = await env.DB.prepare(
          'SELECT * FROM tv_codes WHERE code = ? AND expires_at > ?'
        ).bind(cleanCode, Date.now()).first();

        if (!codeRow) {
          return new Response(JSON.stringify({ error: 'Invalid or expired TV pairing code. Please generate a fresh code on your TV.' }), { status: 404, headers: corsHeaders });
        }

        let verifiedAccountId = null;

        // Path A: Authenticated session token from phone browser
        if (accountId && token) {
          const acc = await env.DB.prepare('SELECT account_id, password_hash FROM accounts WHERE account_id = ?').bind(accountId).first();
          if (acc) {
            const expectedToken = generateAuthToken(acc.account_id, acc.password_hash);
            if (expectedToken === token) {
              verifiedAccountId = acc.account_id;
            }
          }
        }

        // Path B: Credentials directly provided
        if (!verifiedAccountId && email && password) {
          const cleanEmail = email.trim().toLowerCase();
          const acc = await env.DB.prepare('SELECT account_id, password_hash FROM accounts WHERE email = ?').bind(cleanEmail).first();
          if (acc && acc.password_hash) {
            const parts = acc.password_hash.split(':');
            if (parts.length === 2) {
              const [salt, expectedHash] = parts;
              const actualHash = await hashPassword(password, salt);
              if (actualHash === expectedHash) {
                verifiedAccountId = acc.account_id;
              }
            }
          }
        }

        if (!verifiedAccountId) {
          return new Response(JSON.stringify({ error: 'Unauthorized: Invalid credentials or session expired. Please sign in to link this TV.' }), { status: 401, headers: corsHeaders });
        }

        // Mark TV code as claimed by this verified account
        await env.DB.prepare(
          `UPDATE tv_codes SET status = 'claimed', account_id = ? WHERE code = ?`
        ).bind(verifiedAccountId, cleanCode).run();

        return new Response(JSON.stringify({
          success: true,
          message: 'TV successfully authorized and linked!',
          accountId: verifiedAccountId
        }), { headers: corsHeaders });
      }

      // 8. Cloud Push Sync (Watch progress, watchlist, ratings)
      if (method === 'POST' && pathname === '/api/sync/push') {
        const { accountId, profileId, dataType, payload } = await request.json().catch(() => ({}));
        if (!profileId || !dataType) {
          return new Response(JSON.stringify({ error: 'Missing profileId or dataType' }), { status: 400, headers: corsHeaders });
        }

        if (env.DB) {
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO user_sync_data (profile_id, data_type, data_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(profile_id, data_type) DO UPDATE SET
               data_json = excluded.data_json,
               updated_at = excluded.updated_at`
          ).bind(profileId, dataType, JSON.stringify(payload), now).run();
        }

        return new Response(JSON.stringify({ success: true, timestamp: Date.now() }), { headers: corsHeaders });
      }

      // 9. Cloud Pull Sync (Pull latest state for profile)
      if (method === 'GET' && pathname === '/api/sync/pull') {
        const profileId = url.searchParams.get('profileId');
        if (!profileId) {
          return new Response(JSON.stringify({ error: 'Missing profileId' }), { status: 400, headers: corsHeaders });
        }

        if (!env.DB) {
          return new Response(JSON.stringify({ data: null }), { headers: corsHeaders });
        }

        const { results } = await env.DB.prepare(
          `SELECT data_type, data_json, updated_at FROM user_sync_data WHERE profile_id = ?`
        ).bind(profileId).all();

        const syncMap = {};
        for (const row of results || []) {
          try {
            syncMap[row.data_type] = JSON.parse(row.data_json);
          } catch (_) {
            syncMap[row.data_type] = row.data_json;
          }
        }

        return new Response(JSON.stringify({ success: true, syncData: syncMap }), { headers: corsHeaders });
      }

      // 10. Fallback 404
      return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || 'Internal Cloud Sync Error' }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

// -------------------------------------------------------------
// Helper Utilities
// -------------------------------------------------------------

function generateTvCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // exclude 0, 1, I, O to prevent confusion
  let code = 'SV-';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function hashStr(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function generateSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(password + ':' + salt));
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateAuthToken(accountId, passwordHash) {
  return hashStr(accountId + ':' + (passwordHash || 'nohash') + ':sv_token_salt_v1');
}

// -------------------------------------------------------------
// Mobile Pairing & Web Authentication UI (Netflix/YouTube Style)
// -------------------------------------------------------------

function renderWebPairingUi(defaultCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>StreamVault Cloud - Link Your TV</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0A0814; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #141026; border: 1.5px solid #281F4B; border-radius: 20px; padding: 32px 26px; width: 100%; max-width: 440px; box-shadow: 0 20px 50px rgba(0,0,0,0.7); }
    .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
    .logo-badge { width: 38px; height: 38px; border-radius: 10px; background: linear-gradient(135deg, #7C3AED, #4C1D95); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(124,58,237,0.4); }
    .logo-title { font-size: 20px; font-weight: 900; letter-spacing: 0.8px; }
    
    .user-banner { background: #1B1533; border: 1px solid #372A66; border-radius: 12px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .user-info { display: flex; align-items: center; gap: 10px; }
    .user-avatar { width: 34px; height: 34px; border-radius: 50%; background: #7C3AED; color: #FFF; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; }
    .user-email { font-size: 13px; font-weight: 700; color: #FFFFFF; }
    .user-name { font-size: 11px; color: #9CA3AF; }
    .btn-link { background: none; border: none; color: #F87171; font-size: 11.5px; font-weight: 700; cursor: pointer; text-decoration: underline; }
    
    .code-box { background: #0F0B20; border: 2px dashed #4C1D95; border-radius: 14px; padding: 18px 14px; text-align: center; margin-bottom: 22px; }
    .code-input { background: transparent; border: none; font-size: 32px; font-weight: 900; letter-spacing: 4px; text-align: center; text-transform: uppercase; color: #A78BFA; width: 100%; outline: none; }
    
    .tabs { display: flex; background: #0F0B20; border-radius: 10px; padding: 4px; margin-bottom: 20px; }
    .tab-btn { flex: 1; background: transparent; border: none; color: #9CA3AF; padding: 10px 0; font-size: 13.5px; font-weight: 700; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
    .tab-btn.active { background: #7C3AED; color: #FFFFFF; box-shadow: 0 4px 12px rgba(124,58,237,0.3); }
    
    .field { margin-bottom: 15px; }
    label { display: block; font-size: 11px; font-weight: 700; color: #C4B5FD; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; background: #0F0B20; border: 1.5px solid #2E2356; border-radius: 10px; padding: 12px 14px; font-size: 14px; color: #FFFFFF; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: #8B5CF6; }
    
    .btn { width: 100%; background: linear-gradient(135deg, #7C3AED, #6D28D9); border: none; border-radius: 10px; padding: 14px; font-size: 15px; font-weight: 800; color: #FFFFFF; cursor: pointer; box-shadow: 0 6px 20px rgba(124, 58, 237, 0.35); margin-top: 6px; }
    .btn:hover { background: #6D28D9; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .status-msg { margin-top: 15px; font-size: 13px; text-align: center; font-weight: 700; line-height: 1.45; }
    
    .drawer-toggle { margin-top: 20px; padding-top: 16px; border-top: 1px solid #281F4B; text-align: center; }
    .drawer-btn { background: none; border: none; color: #A78BFA; font-size: 12.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .drawer-panel { display: none; margin-top: 14px; background: #0E0A1E; border: 1px solid #281F4B; border-radius: 12px; padding: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-badge">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5"><path d="M5 3l14 9-14 9V3z"/></svg>
      </div>
      <div class="logo-title">STREAMVAULT CLOUD</div>
    </div>

    <!-- VIEW A: Authenticated / Known Session on Phone -->
    <div id="viewAuthenticated" style="display:none;">
      <div class="user-banner">
        <div class="user-info">
          <div class="user-avatar" id="authAvatar">W</div>
          <div>
            <div class="user-email" id="authEmailDisplay">user@example.com</div>
            <div class="user-name" id="authNameDisplay">Account Owner</div>
          </div>
        </div>
        <button class="btn-link" onclick="signOutMobile()">Switch</button>
      </div>

      <div style="font-size:18px; font-weight:800; margin-bottom:6px;">Link This TV</div>
      <p style="font-size:13px; color:#9CA3AF; margin-bottom:16px;">Confirm the pairing code shown on your TV screen to unlock your account.</p>

      <div class="code-box">
        <div style="font-size:11px; font-weight:800; color:#9CA3AF; text-transform:uppercase; margin-bottom:4px;">TV Pairing Code</div>
        <input id="activeTvCode" class="code-input" maxlength="7" placeholder="SV-XXXX" value="${defaultCode}" />
      </div>

      <button id="btnAuthorizeTv" class="btn" onclick="authorizeTvWithSession()">Authorize This TV Now</button>
      <div id="authStatusMsg" class="status-msg"></div>

      <!-- Collapsible IPTV Vault -->
      <div class="drawer-toggle">
        <button class="drawer-btn" onclick="toggleIptvDrawer()">
          <span>⚙ Manage IPTV Credentials</span>
          <span id="drawerArrow">▼</span>
        </button>
        <div id="iptvDrawerPanel" class="drawer-panel">
          <div style="font-size:12px; color:#9CA3AF; margin-bottom:12px; text-align:left;">Changes sync instantly to all linked TVs.</div>
          <div class="field" style="text-align:left;">
            <label>Server URL</label>
            <input id="iptvServerUrlInp" placeholder="http://provider.com:8080" />
          </div>
          <div class="field" style="text-align:left;">
            <label>Username</label>
            <input id="iptvUserInp" placeholder="Username" />
          </div>
          <div class="field" style="text-align:left;">
            <label>Password</label>
            <input id="iptvPassInp" type="password" placeholder="Password" />
          </div>
          <button class="btn" style="padding:10px; font-size:13px;" onclick="saveIptvCredentials()">Save &amp; Sync to TV</button>
          <div id="iptvSaveMsg" class="status-msg" style="margin-top:8px;"></div>
        </div>
      </div>
    </div>

    <!-- VIEW B: Unauthenticated (Sign In / Register) -->
    <div id="viewUnauthenticated" style="display:none;">
      <div id="tvCodePrompt" style="background:#1B1533; border:1px solid #372A66; border-radius:12px; padding:12px 14px; margin-bottom:18px; display:flex; align-items:center; gap:10px;">
        <span style="font-size:18px;">📺</span>
        <div style="font-size:12.5px; color:#D1D5DB; line-height:1.4;">
          Authorizing TV: <strong id="codePromptValue" style="color:#A78BFA; letter-spacing:1px;">${defaultCode || 'New TV'}</strong><br>
          Sign in or create an account to link.
        </div>
      </div>

      <div class="tabs">
        <button id="tabBtnSignIn" class="tab-btn active" onclick="switchAuthTab('login')">Sign In</button>
        <button id="tabBtnSignUp" class="tab-btn" onclick="switchAuthTab('signup')">Create Account</button>
      </div>

      <form id="publicAuthForm" onsubmit="handlePublicAuth(event)">
        <div id="displayNameField" class="field" style="display:none;">
          <label>Your Name</label>
          <input id="inpDisplayName" placeholder="e.g. Waleed Khan" />
        </div>

        <div class="field">
          <label>Email Address</label>
          <input id="inpEmail" type="email" placeholder="name@domain.com" required />
        </div>

        <div class="field">
          <label>Password</label>
          <input id="inpPassword" type="password" placeholder="••••••••" required />
        </div>

        <button type="submit" id="btnSubmitPublic" class="btn">Sign In &amp; Authorize TV</button>
        <div id="publicStatusMsg" class="status-msg"></div>
      </form>
    </div>

  </div>

  <script>
    const INITIAL_CODE = "${defaultCode}";
    let activeTab = 'login';

    function initMobile() {
      const sessionRaw = localStorage.getItem('sv_session');
      if (sessionRaw) {
        try {
          const session = JSON.parse(sessionRaw);
          if (session && session.accountId && session.token) {
            showAuthenticatedView(session);
            return;
          }
        } catch (_) {}
      }
      showUnauthenticatedView();
    }

    function showAuthenticatedView(session) {
      document.getElementById('viewUnauthenticated').style.display = 'none';
      document.getElementById('viewAuthenticated').style.display = 'block';

      const email = session.email || 'user@streamvault.app';
      const name = session.displayName || email.split('@')[0];
      document.getElementById('authEmailDisplay').innerText = email;
      document.getElementById('authNameDisplay').innerText = name;
      document.getElementById('authAvatar').innerText = (name[0] || 'U').toUpperCase();

      if (session.iptvServerUrl) document.getElementById('iptvServerUrlInp').value = session.iptvServerUrl;
      if (session.iptvUsername) document.getElementById('iptvUserInp').value = session.iptvUsername;
      if (session.iptvPassword) document.getElementById('iptvPassInp').value = session.iptvPassword;

      if (INITIAL_CODE) {
        document.getElementById('activeTvCode').value = INITIAL_CODE;
      }
    }

    function showUnauthenticatedView() {
      document.getElementById('viewAuthenticated').style.display = 'none';
      document.getElementById('viewUnauthenticated').style.display = 'block';
      if (!INITIAL_CODE) {
        document.getElementById('tvCodePrompt').style.display = 'none';
      }
    }

    function switchAuthTab(tab) {
      activeTab = tab;
      const isSignUp = tab === 'signup';
      document.getElementById('tabBtnSignIn').className = 'tab-btn ' + (!isSignUp ? 'active' : '');
      document.getElementById('tabBtnSignUp').className = 'tab-btn ' + (isSignUp ? 'active' : '');
      document.getElementById('displayNameField').style.display = isSignUp ? 'block' : 'none';
      document.getElementById('btnSubmitPublic').innerText = isSignUp ? 'Create Account & Authorize' : 'Sign In & Authorize';
      document.getElementById('publicStatusMsg').innerText = '';
    }

    async function handlePublicAuth(e) {
      e.preventDefault();
      const btn = document.getElementById('btnSubmitPublic');
      const msg = document.getElementById('publicStatusMsg');
      btn.disabled = true;
      msg.innerText = '';

      const isSignUp = activeTab === 'signup';
      const email = document.getElementById('inpEmail').value.trim();
      const password = document.getElementById('inpPassword').value;
      const displayName = document.getElementById('inpDisplayName').value.trim();

      try {
        const endpoint = isSignUp ? '/api/auth/signup' : '/api/auth/login';
        const payload = { email, password };
        if (isSignUp && displayName) payload.displayName = displayName;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!data.success) {
          throw new Error(data.error || 'Authentication failed. Please verify credentials.');
        }

        // Save session locally
        const session = {
          accountId: data.account.accountId,
          email: data.account.email,
          displayName: data.account.displayName,
          token: data.token,
          iptvServerUrl: data.account.iptvServerUrl || '',
          iptvUsername: data.account.iptvUsername || '',
          iptvPassword: data.account.iptvPassword || '',
          playlistName: data.account.playlistName || ''
        };
        localStorage.setItem('sv_session', JSON.stringify(session));

        // If a TV code was present, automatically link it right now!
        const codeToLink = INITIAL_CODE || '';
        if (codeToLink) {
          msg.style.color = '#A78BFA';
          msg.innerText = 'Account verified! Linking TV (' + codeToLink + ')...';

          const claimRes = await fetch('/api/auth/claim-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: codeToLink,
              accountId: session.accountId,
              token: session.token
            })
          });
          const claimData = await claimRes.json();
          if (claimData.success) {
            msg.style.color = '#10B981';
            msg.innerHTML = '&#10004; TV Authorized Successfully!<br>StreamVault TV is now unlocking on your TV screen.';
            setTimeout(() => showAuthenticatedView(session), 1800);
            return;
          }
        }

        showAuthenticatedView(session);
      } catch (err) {
        msg.style.color = '#EF4444';
        msg.innerText = err.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function authorizeTvWithSession() {
      const btn = document.getElementById('btnAuthorizeTv');
      const msg = document.getElementById('authStatusMsg');
      const code = document.getElementById('activeTvCode').value.trim().toUpperCase();

      if (!code || code.length < 5) {
        msg.style.color = '#EF4444';
        msg.innerText = 'Please enter a valid 6-character TV pairing code (e.g. SV-XXXX).';
        return;
      }

      const session = JSON.parse(localStorage.getItem('sv_session') || '{}');
      if (!session.accountId || !session.token) {
        signOutMobile();
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Authorizing TV...';
      msg.innerText = '';

      try {
        const res = await fetch('/api/auth/claim-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            accountId: session.accountId,
            token: session.token
          })
        });
        const data = await res.json();
        if (data.success) {
          msg.style.color = '#10B981';
          msg.innerHTML = '&#10004; TV Authorized Successfully!<br>StreamVault TV is now unlocking on your TV screen.';
          btn.innerText = '✓ TV Linked';
        } else {
          msg.style.color = '#EF4444';
          msg.innerText = data.error || 'Failed to authorize TV code. Please verify the code.';
          btn.disabled = false;
          btn.innerText = 'Authorize This TV Now';
        }
      } catch (err) {
        msg.style.color = '#EF4444';
        msg.innerText = err.message;
        btn.disabled = false;
        btn.innerText = 'Authorize This TV Now';
      }
    }

    function signOutMobile() {
      localStorage.removeItem('sv_session');
      showUnauthenticatedView();
    }

    function toggleIptvDrawer() {
      const panel = document.getElementById('iptvDrawerPanel');
      const arrow = document.getElementById('drawerArrow');
      const isOpen = panel.style.display === 'block';
      panel.style.display = isOpen ? 'none' : 'block';
      arrow.innerText = isOpen ? '▼' : '▲';
    }

    async function saveIptvCredentials() {
      const session = JSON.parse(localStorage.getItem('sv_session') || '{}');
      const msg = document.getElementById('iptvSaveMsg');
      msg.innerText = 'Saving...';
      msg.style.color = '#A78BFA';

      const iptvServerUrl = document.getElementById('iptvServerUrlInp').value.trim();
      const iptvUsername = document.getElementById('iptvUserInp').value.trim();
      const iptvPassword = document.getElementById('iptvPassInp').value.trim();

      try {
        const res = await fetch('/api/account/update-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: session.accountId,
            token: session.token,
            iptvServerUrl,
            iptvUsername,
            iptvPassword,
            playlistName: 'StreamVault IPTV'
          })
        });
        const data = await res.json();
        if (data.success) {
          session.iptvServerUrl = iptvServerUrl;
          session.iptvUsername = iptvUsername;
          session.iptvPassword = iptvPassword;
          localStorage.setItem('sv_session', JSON.stringify(session));
          msg.style.color = '#10B981';
          msg.innerText = '✓ Saved! Synced to your cloud account.';
        } else {
          msg.style.color = '#EF4444';
          msg.innerText = data.error || 'Failed to update credentials.';
        }
      } catch (err) {
        msg.style.color = '#EF4444';
        msg.innerText = err.message;
      }
    }

    window.addEventListener('DOMContentLoaded', initMobile);
  </script>
</body>
</html>`;
}
