# StreamVault TV Cloud Engine (Cloudflare Workers + D1)

Serverless backend for standalone StreamVault TV accounts, multi-playlist sync, shared TMDB caching, and cross-device profile synchronization.

## Architecture
- **Standalone Accounts**: User accounts with email + password (PBKDF2 100k iterations with per-user salt).
- **Email Verification**: 6-digit confirmation codes sent via Resend free tier (single-use, 10-minute expiry, attempt-limited).
- **Session Tokens**: Crypto-random 32-byte tokens stored hashed with SHA-256 and revoked on sign-out.
- **TV Pairing Codes**: Crypto-random single-use codes (`SV-XXXX`) with one-time exchange tokens (no password leakage).
- **IPTV Playlists**: Many playlists per account, encrypted at rest via AES-256-GCM.
- **Enriched Catalog Cache**: Batched sync from TV to D1; 14-day soft delete for removed titles; user profile data is permanently preserved.
- **Shared TMDB Proxy**: Caches metadata queries in D1 `tmdb_cache` to shield API rate limits.

---

## Setting Up Worker Secrets (Step-by-Step)

### Step 1: Resend Free Tier (Email Verification)
1. Go to [resend.com](https://resend.com) and create a free account (100 emails/day free forever, no credit card required).
2. Click **API Keys** -> **Create API Key** and copy it (`re_...`).
3. Set the key in your Cloudflare Worker:
   ```bash
   cd cloud-sync
   npx wrangler secret put RESEND_API_KEY
   # Paste your re_... key when prompted
   ```

### Step 2: AES Encryption Secret & TMDB Proxy
Set the encryption key for IPTV passwords stored at rest and TMDB API key:
```bash
npx wrangler secret put AES_SECRET
# Enter a 32+ character random string

npx wrangler secret put TMDB_API_KEY
# Enter your TMDB API key
```

---

## Deploying to Cloudflare

1. Apply the D1 Schema:
   ```bash
   npx wrangler d1 execute streamvault-db --file=./schema.sql
   ```
2. Deploy the Worker:
   ```bash
   npx wrangler deploy
   ```
