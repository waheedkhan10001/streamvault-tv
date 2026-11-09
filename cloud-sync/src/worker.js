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
        const { email, password, displayName = 'Account Owner', iptvServer = '', iptvUser = '', iptvPass = '', playlistName = 'Aadiflix TV' } = await request.json().catch(() => ({}));
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

        if (row.password_hash) {
          const parts = row.password_hash.split(':');
          if (parts.length === 2) {
            const [salt, expectedHash] = parts;
            const actualHash = await hashPassword(password, salt);
            if (actualHash !== expectedHash) {
              return new Response(JSON.stringify({ error: 'Incorrect password. Please try again.' }), { status: 401, headers: corsHeaders });
            }
          }
        }

        // Fetch profiles & sync data
        const { results: profiles } = await env.DB.prepare(
          'SELECT * FROM profiles WHERE account_id = ?'
        ).bind(row.account_id).all();

        const { results: syncData } = await env.DB.prepare(
          `SELECT s.* FROM user_sync_data s JOIN profiles p ON s.profile_id = p.profile_id WHERE p.account_id = ?`
        ).bind(row.account_id).all();

        const account = {
          accountId: row.account_id,
          email: row.email,
          iptvServerUrl: row.iptv_server_url || '',
          iptvUsername: row.iptv_username || '',
          iptvPassword: row.iptv_password || '',
          playlistName: row.playlist_name || 'StreamVault IPTV'
        };

        return new Response(JSON.stringify({
          success: true,
          message: 'Signed in successfully',
          account,
          profiles: profiles || [],
          syncData: syncData || []
        }), { headers: corsHeaders });
      }

      // 4. Update IPTV Credentials in Cloud Account
      if (method === 'POST' && pathname === '/api/account/update-credentials') {
        const { accountId, iptvServerUrl, iptvUsername, iptvPassword, playlistName } = await request.json().catch(() => ({}));
        if (!accountId) {
          return new Response(JSON.stringify({ error: 'Missing accountId' }), { status: 400, headers: corsHeaders });
        }

        if (env.DB) {
          await env.DB.prepare(
            `UPDATE accounts SET 
               iptv_server_url = ?,
               iptv_username = ?,
               iptv_password = ?,
               playlist_name = ?,
               updated_at = ?
             WHERE account_id = ?`
          ).bind(iptvServerUrl || '', iptvUsername || '', iptvPassword || '', playlistName || '', Date.now(), accountId).run();
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
            account,
            profiles: profiles || [],
            syncData: syncData || []
          }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ status: 'pending' }), { headers: corsHeaders });
      }

      // 7. Claim TV Link Code (User scans QR or submits form on mobile)
      if (method === 'POST' && pathname === '/api/auth/claim-code') {
        const { code, email, displayName, iptvServer, iptvUser, iptvPass, playlistName } = await request.json().catch(() => ({}));
        if (!code) {
          return new Response(JSON.stringify({ error: 'Missing code' }), { status: 400, headers: corsHeaders });
        }

        const cleanCode = code.trim().toUpperCase();
        const accountId = 'acc_' + (email ? hashStr(email.toLowerCase()) : 'default');
        const now = Date.now();

        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO accounts (account_id, email, iptv_server_url, iptv_username, iptv_password, playlist_name, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
               iptv_server_url = CASE WHEN excluded.iptv_server_url != '' THEN excluded.iptv_server_url ELSE accounts.iptv_server_url END,
               iptv_username = CASE WHEN excluded.iptv_username != '' THEN excluded.iptv_username ELSE accounts.iptv_username END,
               iptv_password = CASE WHEN excluded.iptv_password != '' THEN excluded.iptv_password ELSE accounts.iptv_password END,
               playlist_name = CASE WHEN excluded.playlist_name != '' THEN excluded.playlist_name ELSE accounts.playlist_name END,
               updated_at = excluded.updated_at`
          ).bind(accountId, email || 'user@streamvault.app', iptvServer || '', iptvUser || '', iptvPass || '', playlistName || 'StreamVault IPTV', now).run();

          const profileId = 'prof_' + accountId + '_1';
          await env.DB.prepare(
            `INSERT OR IGNORE INTO profiles (profile_id, account_id, display_name, avatar_color, created_at, updated_at)
             VALUES (?, ?, ?, '#8B5CF6', ?, ?)`
          ).bind(profileId, accountId, displayName || 'Waleed Khan', now, now).run();

          await env.DB.prepare(
            `UPDATE tv_codes SET status = 'claimed', account_id = ? WHERE code = ?`
          ).bind(accountId, cleanCode).run();
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'TV successfully authorized!',
          accountId
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

        let syncData = [];
        if (env.DB) {
          const { results } = await env.DB.prepare(
            `SELECT * FROM user_sync_data WHERE profile_id = ?`
          ).bind(profileId).all();
          syncData = results || [];
        }

        return new Response(JSON.stringify({ success: true, data: syncData }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: 'Endpoint Not Found' }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};

function generateTvCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
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

function renderWebPairingUi(defaultCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>StreamVault TV — Universal Account & Link</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0A0814; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 18px; }
    .card { background: #141026; border: 1px solid #281F4B; border-radius: 18px; padding: 30px 24px; width: 100%; max-width: 440px; box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .logo-badge { width: 36px; height: 36px; border-radius: 9px; background: linear-gradient(135deg, #7C3AED, #4C1D95); display: flex; align-items: center; justify-content: center; }
    .logo-title { font-size: 20px; font-weight: 900; letter-spacing: 0.5px; }
    .tabs { display: flex; background: #0F0B20; border-radius: 10px; padding: 4px; margin-bottom: 22px; }
    .tab-btn { flex: 1; background: transparent; border: none; color: #9CA3AF; padding: 9px 0; font-size: 13.5px; font-weight: 700; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
    .tab-btn.active { background: #7C3AED; color: #FFFFFF; }
    h2 { font-size: 21px; font-weight: 800; margin-bottom: 6px; }
    p { font-size: 13px; color: #9CA3AF; line-height: 1.5; margin-bottom: 20px; }
    .field { margin-bottom: 14px; }
    label { display: block; font-size: 11px; font-weight: 700; color: #C4B5FD; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; background: #0F0B20; border: 1.5px solid #2E2356; border-radius: 10px; padding: 11px 13px; font-size: 14px; color: #FFFFFF; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: #8B5CF6; }
    .code-input { font-size: 22px; font-weight: 800; letter-spacing: 3px; text-align: center; text-transform: uppercase; color: #A78BFA; }
    .btn { width: 100%; background: linear-gradient(135deg, #7C3AED, #6D28D9); border: none; border-radius: 10px; padding: 13px; font-size: 15px; font-weight: 800; color: #FFFFFF; cursor: pointer; box-shadow: 0 6px 20px rgba(124, 58, 237, 0.35); margin-top: 10px; }
    .btn:hover { background: #6D28D9; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .status-msg { margin-top: 14px; font-size: 13px; text-align: center; font-weight: 700; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-badge">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5"><path d="M5 3l14 9-14 9V3z"/></svg>
      </div>
      <div class="logo-title">STREAMVAULT TV</div>
    </div>

    <div class="tabs">
      <button class="tab-btn ${defaultCode ? 'active' : ''}" onclick="switchTab('link')">Link TV Code</button>
      <button class="tab-btn ${!defaultCode ? 'active' : ''}" onclick="switchTab('auth')">Account Sign In</button>
    </div>

    <!-- Section 1: Link TV Code -->
    <div id="linkSection" style="${defaultCode ? '' : 'display:none;'}">
      <h2>Link Your TV</h2>
      <p>Enter the 6-character code shown on your TV screen to sync your watch history, watchlist, and IPTV credentials in seconds.</p>

      <form id="linkForm" onsubmit="submitLink(event)">
        <div class="field">
          <label>TV Pairing Code</label>
          <input id="codeInp" class="code-input" maxlength="7" placeholder="SV-XXXX" value="${defaultCode}" required />
        </div>

        <div class="field">
          <label>Display Name</label>
          <input id="nameInp" placeholder="Waleed Khan" value="Waleed Khan" required />
        </div>

        <div class="field">
          <label>Account Email (For cross-device backup)</label>
          <input id="emailInp" type="email" placeholder="wkhan.10001@gmail.com" value="wkhan.10001@gmail.com" required />
        </div>

        <button type="submit" class="btn" id="submitLinkBtn">Link &amp; Sync TV Now</button>
        <div id="linkStatusMsg" class="status-msg"></div>
      </form>
    </div>

    <!-- Section 2: Account Sign In / Sign Up -->
    <div id="authSection" style="${!defaultCode ? '' : 'display:none;'}">
      <h2 id="authTitle">Sign In to StreamVault</h2>
      <p id="authDesc">Sign in with your email to access all your synced profiles, continue watching, and watchlist across any device.</p>

      <form id="authForm" onsubmit="submitAuth(event)">
        <div class="field">
          <label>Email Address</label>
          <input id="authEmail" type="email" placeholder="you@domain.com" value="wkhan.10001@gmail.com" required />
        </div>

        <div class="field">
          <label>Password</label>
          <input id="authPassword" type="password" placeholder="••••••••" required />
        </div>

        <div id="nameField" class="field" style="display:none;">
          <label>Display Name</label>
          <input id="authDisplayName" placeholder="Waleed Khan" value="Waleed Khan" />
        </div>

        <button type="submit" class="btn" id="submitAuthBtn">Sign In</button>
        <div style="text-align:center; margin-top:14px;">
          <a href="#" id="toggleAuthMode" onclick="toggleMode(event)" style="color:#A78BFA; font-size:12.5px; text-decoration:none;">Don't have an account? Sign Up</a>
        </div>
        <div id="authStatusMsg" class="status-msg"></div>
      </form>
    </div>
  </div>

  <script>
    let isSignUpMode = false;

    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach((b, i) => {
        b.classList.toggle('active', (tab === 'link' && i === 0) || (tab === 'auth' && i === 1));
      });
      document.getElementById('linkSection').style.display = tab === 'link' ? 'block' : 'none';
      document.getElementById('authSection').style.display = tab === 'auth' ? 'block' : 'none';
    }

    function toggleMode(e) {
      e.preventDefault();
      isSignUpMode = !isSignUpMode;
      document.getElementById('authTitle').innerText = isSignUpMode ? 'Create StreamVault Account' : 'Sign In to StreamVault';
      document.getElementById('authDesc').innerText = isSignUpMode ? 'Create your cloud account to sync IPTV, watchlist, and ratings everywhere.' : 'Sign in to access your synced profiles and watch history.';
      document.getElementById('submitAuthBtn').innerText = isSignUpMode ? 'Create Account' : 'Sign In';
      document.getElementById('nameField').style.display = isSignUpMode ? 'block' : 'none';
      document.getElementById('toggleAuthMode').innerText = isSignUpMode ? 'Already have an account? Sign In' : "Don't have an account? Sign Up";
    }

    async function submitLink(e) {
      e.preventDefault();
      const btn = document.getElementById('submitLinkBtn');
      const msg = document.getElementById('linkStatusMsg');
      btn.disabled = true;
      btn.innerText = 'Linking TV...';
      msg.innerText = '';

      try {
        const res = await fetch('/api/auth/claim-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: document.getElementById('codeInp').value,
            displayName: document.getElementById('nameInp').value,
            email: document.getElementById('emailInp').value
          })
        });
        const data = await res.json();
        if (data.success) {
          msg.style.color = '#10B981';
          msg.innerHTML = '&#10004; Success! Your TV is linked. Your watch history, continue watching, and profiles are syncing now.';
          btn.style.display = 'none';
        } else {
          msg.style.color = '#EF4444';
          msg.innerText = data.error || 'Failed to link TV. Please verify the code.';
          btn.disabled = false;
          btn.innerText = 'Link & Sync TV Now';
        }
      } catch (err) {
        msg.style.color = '#EF4444';
        msg.innerText = err.message;
        btn.disabled = false;
        btn.innerText = 'Link & Sync TV Now';
      }
    }

    async function submitAuth(e) {
      e.preventDefault();
      const btn = document.getElementById('submitAuthBtn');
      const msg = document.getElementById('authStatusMsg');
      btn.disabled = true;
      btn.innerText = isSignUpMode ? 'Creating Account...' : 'Signing In...';
      msg.innerText = '';

      const endpoint = isSignUpMode ? '/api/auth/signup' : '/api/auth/login';
      const payload = {
        email: document.getElementById('authEmail').value,
        password: document.getElementById('authPassword').value
      };
      if (isSignUpMode) {
        payload.displayName = document.getElementById('authDisplayName').value;
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
          msg.style.color = '#10B981';
          msg.innerHTML = '&#10004; ' + (isSignUpMode ? 'Account created successfully!' : 'Signed in successfully!') + '<br>Syncing profiles...';
          localStorage.setItem('streamvault_account', JSON.stringify(data.account));
        } else {
          msg.style.color = '#EF4444';
          msg.innerText = data.error || 'Authentication failed.';
        }
      } catch (err) {
        msg.style.color = '#EF4444';
        msg.innerText = err.message;
      } finally {
        btn.disabled = false;
        btn.innerText = isSignUpMode ? 'Create Account' : 'Sign In';
      }
    }
  </script>
</body>
</html>`;
}
