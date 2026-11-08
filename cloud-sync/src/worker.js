/**
 * StreamVault TV Cloud Sync Engine
 * Cloudflare Worker + Cloudflare D1 Serverless Database
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS Headers for TV App and Browser Access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

      // 2. Request TV Link Code (TV calls this)
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

        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(url.origin + '/link?code=' + code)}`;

        return new Response(JSON.stringify({
          success: true,
          code,
          expiresAt,
          qrUrl,
          pairUrl: `${url.origin}/link?code=${code}`
        }), { headers: corsHeaders });
      }

      // 3. Poll TV Link Code Status (TV calls this periodically)
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

      // 4. Claim TV Link Code (User scans QR or submits form on mobile)
      if (method === 'POST' && pathname === '/api/auth/claim-code') {
        const { code, email, displayName, iptvServer, iptvUser, iptvPass, playlistName } = await request.json();
        if (!code) {
          return new Response(JSON.stringify({ error: 'Missing code' }), { status: 400, headers: corsHeaders });
        }

        const cleanCode = code.trim().toUpperCase();
        const accountId = 'acc_' + (email ? hashStr(email) : 'default');
        const now = Date.now();

        if (env.DB) {
          // Upsert account
          await env.DB.prepare(
            `INSERT INTO accounts (account_id, email, iptv_server_url, iptv_username, iptv_password, playlist_name, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
               iptv_server_url = excluded.iptv_server_url,
               iptv_username = excluded.iptv_username,
               iptv_password = excluded.iptv_password,
               playlist_name = excluded.playlist_name,
               updated_at = excluded.updated_at`
          ).bind(accountId, email || 'user@streamvault.app', iptvServer || '', iptvUser || '', iptvPass || '', playlistName || 'StreamVault IPTV', now).run();

          // Create default profile if not exists
          const profileId = 'prof_' + accountId + '_1';
          await env.DB.prepare(
            `INSERT OR IGNORE INTO profiles (profile_id, account_id, display_name, avatar_color, created_at, updated_at)
             VALUES (?, ?, ?, '#7C3AED', ?, ?)`
          ).bind(profileId, accountId, displayName || 'Waleed Khan', now, now).run();

          // Mark TV code as claimed
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

      // 5. Cloud Push Sync (TV pushes local changes: watch progress, watchlist, ratings)
      if (method === 'POST' && pathname === '/api/sync/push') {
        const { accountId, profileId, dataType, payload } = await request.json();
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

      // 6. Cloud Pull Sync (TV pulls latest state for profile)
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

      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
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

function renderWebPairingUi(defaultCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StreamVault TV — Quick Link & Sync</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0A0814; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #141026; border: 1px solid #281F4B; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 420px; box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
    .logo-badge { width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #7C3AED, #4C1D95); display: flex; align-items: center; justify-content: center; }
    .logo-title { font-size: 20px; font-weight: 900; letter-spacing: 0.5px; }
    h2 { font-size: 22px; font-weight: 800; margin-bottom: 8px; }
    p { font-size: 13.5px; color: #9CA3AF; line-height: 1.5; margin-bottom: 24px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 11.5px; font-weight: 700; color: #C4B5FD; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; background: #0F0B20; border: 1.5px solid #2E2356; border-radius: 10px; padding: 12px 14px; font-size: 14px; color: #FFFFFF; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: #8B5CF6; }
    .code-input { font-size: 20px; font-weight: 800; letter-spacing: 3px; text-align: center; text-transform: uppercase; }
    .btn { width: 100%; background: linear-gradient(135deg, #7C3AED, #6D28D9); border: none; border-radius: 10px; padding: 14px; font-size: 15px; font-weight: 800; color: #FFFFFF; cursor: pointer; box-shadow: 0 6px 20px rgba(124, 58, 237, 0.4); margin-top: 8px; }
    .btn:hover { background: #6D28D9; }
    .status-msg { margin-top: 16px; font-size: 13.5px; text-align: center; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-badge">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5"><path d="M5 3l14 9-14 9V3z"/></svg>
      </div>
      <div class="logo-title">STREAMVAULT</div>
    </div>
    <h2>Link New Android TV</h2>
    <p>Enter the 6-character code shown on your TV screen to sync your profile, watchlist, and IPTV credentials in 1 tap.</p>

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
        <label>Email (Optional for backup)</label>
        <input id="emailInp" type="email" placeholder="waleed@streamvault.tv" value="waleed@streamvault.tv" />
      </div>

      <button type="submit" class="btn" id="submitBtn">Link &amp; Sync TV Now</button>
      <div id="statusMsg" class="status-msg"></div>
    </form>
  </div>

  <script>
    async function submitLink(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const msg = document.getElementById('statusMsg');
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
  </script>
</body>
</html>`;
}
