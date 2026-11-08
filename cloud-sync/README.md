# StreamVault TV Cloud Sync Engine (Cloudflare Workers + D1)

Zero-cost, ultra-low latency (<20ms) serverless synchronization engine for StreamVault TV.

## Architecture & Features
- **TV Link Code Pairing**: Generates a 6-digit TV code (`SV-XXXX`) and QR code for zero-friction phone login.
- **Cross-TV Multi-Profile Sync**: Watch history, resume timestamps, watchlist bookmarks, and star ratings sync seamlessly across unlimited TVs.
- **IPTV Credential Auto-Provisioning**: Logging into a new TV automatically configures IPTV server URL and credentials without typing passwords via TV remote.
- **Embedded Mobile Web Pairing**: User visits `https://<worker>.workers.dev/link` on their phone to claim codes in 1 tap.

## 1-Minute Cloudflare Deployment
1. Authenticate with Cloudflare:
   ```bash
   npx wrangler login
   ```
2. Create Cloudflare D1 Database:
   ```bash
   npx wrangler d1 create streamvault-db
   ```
3. Update `wrangler.toml` with the printed `database_id`.
4. Apply Database Schema:
   ```bash
   npx wrangler d1 execute streamvault-db --file=./schema.sql
   ```
5. Deploy to Cloudflare Global Edge:
   ```bash
   npx wrangler deploy
   ```
