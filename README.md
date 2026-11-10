# StreamVault TV — Standalone Android TV IPTV Client (v2.7.0)

Custom, ultra-smooth, premium Android TV client built specifically for **TCL 55P635 (Android TV 11, API 30, 2GB RAM)** with zero PC dependency, local-first Room/SQLite storage, and cross-device Cloudflare D1 synchronization.

---

## 🌟 Key Features

### 1. Completely Standalone Architecture (No PC Required)
- **Local-First SQLite Engine**: Downloads, parses, and enriches IPTV playlists directly on the TV using an in-app Kotlin/Room engine (`AppApiRouter.kt`).
- **Cloudflare D1 Multi-Device Sync**: Cross-syncs watch progress, resume bookmarks, watchlists, ratings, and IPTV playlists across all your TVs and phones via Cloudflare Workers (`cloud-sync/`).
- **Zero-Typing Phone QR Sign-In**: Scan the bedside QR code on the TV screen with your phone camera (`/link?code=SV-XXXX`) to pair and sign in instantly without typing on the TV remote.
- **Email Verification Codes**: Secure sign-up confirmed with 6-digit verification codes sent via Resend.

### 2. Multi-Playlist Management & Data Isolation
- **Accounts**: Own sign-in credentials, multi-playlist configurations, and enriched catalog backups.
- **IPTV Playlists**: Replaceable content sources (Xtream Codes / M3U). Changing or replacing IPTV credentials never loses enrichment or profile data (keyed by universal TMDB ID / canonical title hash, never provider stream IDs).
- **Profiles**: Isolated personal data (Continue Watching, 5-star ratings, watchlist, watched status, search history, and UI themes: Purple, Netflix Red, Disney Blue, Prime Cyan). Primary profile is permanent.
- **14-Day Provider Shield**: Titles removed by the provider are soft-deleted and retained for 14 days before purging, preserving watch progress and bookmarks.

### 3. Background TMDB Enrichment
- **100% Background Enrichment**: Enriches movies and TV series with high-res posters, backdrop artwork, plot synopses, cast/director, runtime, and IMDb/TMDB ratings.
- **1-Connection IPTV Protection**: Automatically pauses all background playlist/TMDB requests while a video is playing to protect single-connection IPTV subscriptions from provider throttling.
- **Cloud TMDB Cache**: Worker caches TMDB responses in Cloudflare D1 to accelerate enrichment across devices.

### 4. Leanback 1080p Cinema Experience & Audio/Subtitle Drawer
- **ExoPlayer Media3**: Hardware-accelerated playback with VLC User-Agent spoofing, HTTP 302 redirect support, and 5.1 multi-channel audio passthrough.
- **In-Player Quick Drawer (Remote ▲ DPAD-UP)**: Translucent 2-column drawer for instant real-time switching of audio streams (English 5.1, Hindi Stereo) and embedded/online subtitles (`.srt`).
- **Zero-Lag Spatial Navigation**: O(1) sibling spatial navigation tailored for TV remotes with zero vertical auto-scrolling at 960×540 physical viewport.
- **Parental Controls & Adult Vault**: Salted SHA-256 PIN hashing with attempt limiting (5 failed attempts → 60s lockout).

---

## 🚀 Installation & Deployment

### Method 1: Wi-Fi Direct Push to TCL 55P635 (No USB Stick Required)
1. On your TCL TV, enable **Developer Options -> Network Debugging** (`Settings -> Device Preferences -> About -> click Build 7 times`).
2. Run [`Push-To-TCL-TV.bat`](./Push-To-TCL-TV.bat), enter your TV's Wi-Fi IP address, and it will install and launch **`StreamVault-TV.apk`** directly on your TV.

### Method 2: GitHub Actions Automated CI/CD
Every push or pull request to `main` or `standalone-accounts` automatically builds both Debug and Release APKs via [`.github/workflows/build-apk.yml`](./.github/workflows/build-apk.yml).

### Method 3: Local Command-Line Build
```powershell
# Build release APK with R8 minification and signing
.\gradlew assembleRelease
```
The optimized release APK is generated at `app/build/outputs/apk/release/app-release.apk` (~3.9 MB).

---

## 🛠 Cloudflare Worker Deployment (`cloud-sync/`)

To deploy your own cloud sync backend:
```bash
cd cloud-sync
# 1. Initialize D1 database schema
npx wrangler d1 execute streamvault-d1 --file=schema.sql --remote

# 2. Configure Worker secrets
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put IPTV_ENCRYPTION_KEY

# 3. Deploy worker
npx wrangler deploy
```

---

## 📂 Project Architecture

```
streamvault-tv/
├── .github/workflows/
│   └── build-apk.yml             # Automated GitHub Actions APK build workflow
├── app/                          # Native Android TV application
│   ├── src/main/assets/
│   │   └── tv-ui.html            # Single source of truth for 1080p Leanback UI
│   ├── src/main/java/com/streamvault/tv/
│   │   ├── MainActivity.kt       # ExoPlayer, WebView bridge, remote key handling
│   │   ├── data/
│   │   │   ├── AppApiRouter.kt   # In-app local API engine (Room SQLite CRUD)
│   │   │   ├── AppDatabase.kt    # Room database definition
│   │   │   ├── CatalogSyncEngine.kt # TMDB enrichment & IPTV download engine
│   │   │   ├── PreferencesManager.kt # Atomic credentials & preferences storage
│   │   │   └── TitleParser.kt    # Non-Latin Unicode title normalization & dedup
│   │   ├── playback/             # Media3 ExoPlayer integration
│   │   └── service/              # Subtitle downloader & phone pairing companion
│   └── build.gradle.kts          # Version 2.7.0, R8 minify, release signing config
├── cloud-sync/                   # Cloudflare D1 & Worker backend
│   ├── src/worker.js             # PBKDF2 auth, pairing codes, batched sync, TMDB proxy
│   ├── schema.sql                # 9 D1 tables (accounts, playlists, catalog, etc.)
│   └── wrangler.toml             # Cloudflare Worker configuration
├── pc-runner/                    # PC TV Simulator & development tools
│   └── server.js                 # Local Node.js development server
└── Push-To-TCL-TV.bat            # Wireless ADB installer for TCL TV
```
