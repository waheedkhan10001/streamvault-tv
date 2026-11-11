# StreamVault TV — Round 2 Handoff Document (v2.8.0, versionCode 3)

## 0. Start Here for a New Chat

### Repo Layout
- **`app/`**: Android TV application (Android 11+, Leanback TV wrapper, Room/SQLite, ExoPlayer).
  - `app/src/main/assets/tv-ui.html`: Standalone TV Web UI running inside native WebView (spatial nav, profiles, video player UI, multi-version stream selector).
  - `app/src/main/java/com/streamvault/tv/data/`: Native data layer:
    - `StreamVaultDatabase.kt`: Room/SQLite database (`profiles`, `profile_media_state`, `media_items`, `series_episodes`, `live_channels`, `pinned_smart_rows`).
    - `AppApiRouter.kt`: Native HTTP server intercepting `/api/*` calls from `tv-ui.html` (auth gates, profile CRUD, `/api/probe-versions`, sync, credentials).
    - `CatalogSyncEngine.kt`: Batched 25-item catalogue sync with exponential backoff and 14-day soft delete.
    - `PreferencesManager.kt`: Encrypted and persistent device preferences (auth token, last profile, dedupKey index).
  - `app/src/main/java/com/streamvault/tv/MainActivity.kt`: Hardware Back key interceptor and WebView container.
- **`cloud-sync/`**: Cloudflare Worker backend and D1 database schema.
  - `src/worker.js`: Auth API (PBKDF2 SHA-256), Brevo v3 transactional email, per-IP and per-email rate limits, `/api/auth/resend-code`, TMDB proxy with D1 cache, catalog and profile delta sync.
  - `schema.sql`: D1 relational schema (`accounts`, `profiles`, `profile_media_state`, `playlists`, `catalog_items`, `stream_versions`, `tmdb_cache`, `email_codes`).
- **`pc-runner/`**: Desktop test harness for headless and browser-based debugging (`server.js`, `tv-ui.html`).
- **`tests/`**: Automated Puppeteer / Node.js test suites (`phaseA.test.mjs` through `phaseE.test.mjs`).
- **`.toolchain/`**: Local portable Android SDK (build-tools 34.0.0, platforms android-34) and OpenJDK.

### How to Run the Tests
```bash
# Run complete test suite (42/42 assertions across all phases):
node tests/phaseA.test.mjs
node tests/phaseB.test.mjs
node tests/phaseC.test.mjs
node tests/phaseD.test.mjs
node tests/phaseE.test.mjs

# Rebuild signed release APK:
.\gradlew.bat assembleRelease

# Verify APK signature:
.\.toolchain\android-sdk\build-tools\34.0.0\apksigner.bat verify --verbose app\build\outputs\apk\release\app-release.apk
```

### Open Gaps
1. **Phase E Items 3, 4, 5**: **ALL COMPLETED** (Per-email rate limiting & `/api/auth/resend-code` implemented; `/api/probe-versions` implemented in `AppApiRouter.kt`; Jetpack Compose completely purged and APK reduced to ~2.96 MB).
2. **Physical TV Verification (Phase F)**: Visual D-pad smoothness on 55" display, hardware ExoPlayer video playback (MKV/MP4/HLS MPEG-TS), real-time cross-device sync between two TVs, and 60,000-title catalog memory pressure testing on physical 2 GB RAM TV hardware.

### Secrets & Variables Needed
- `BREVO_API_KEY`: Brevo v3 API key (`xkeysib-...`) for sending 6-digit verification codes.
- `AES_SECRET`: 32+ character random key for encrypting IPTV passwords in D1.
- `TMDB_API_KEY`: TMDB v3 API key for worker metadata enrichment and D1 caching.
- `JWT_SECRET`: Secret for signing session tokens and verification payloads.
- `DEV_MODE`: Set to `"true"` ONLY during local automated testing to expose `devCode`.

---

## 1. Quick Audit & User Questions

### Question 1: Phase E Items 3, 4, 5 Status
- **Item 3 (Rate-limit & Resend)**: **DONE**; IP and per-email limits enforced on signup (3/min), login (5/min), verify (5/min), and resend (3/min) in `cloud-sync/src/worker.js`, plus `/api/auth/resend-code` route fully implemented and wired to `tv-ui.html`.
- **Item 4 (`/api/probe-versions`)**: **DONE**; implemented in `app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt` using fast HTTP Range bytes 0-10, size formatting, and CAM rip detection.
- **Item 5 (Compose cleanup)**: **DONE**; all Jetpack Compose dependencies removed from `app/build.gradle.kts` and legacy screens deleted from `app/src/main/java/com/streamvault/tv/ui/` (`StreamVaultTvApp.kt`, `StreamVaultPlayerScreen.kt`), shrinking APK from 4.11 MB to ~2.96 MB.

### Question 2: Phase F Verification Status Breakdown
- **Ran & Passed (Headless Puppeteer)**: Sign-in gate & 401s (PASS), Profile CRUD & Kids/Vault privacy (PASS), Spatial nav & Back key (PASS), Cloud sync & dedup re-linking (PASS), Auth hardening, per-email rate limits & Brevo email (PASS), 960x540 zero console errors (PASS) — 42/42 tests passed.
- **Needs TV**: Physical D-pad remote feel on 55" display, ExoPlayer hardware video playback (MKV/MP4/HLS MPEG-TS), cross-device real-time sync between two TVs, and 14-day soft-delete visual restore confirmation.
- **Not Run**: 60,000-title catalogue memory pressure stress test on physical 2 GB RAM TV hardware.

### Question 3: APK Signature & Version Code
- **Signed**: Yes, signed with release keystore (`release.keystore`) via APK Signature Scheme v2.
- **`apksigner` Result**: `Verifies: true`, `Verified using v2 scheme (APK Signature Scheme v2): true`, `Number of signers: 1`.
- **`versionCode`**: `versionCode='3'`, `versionName='2.8.0'`, size 2,960,072 bytes (~2.96 MB, down from 4.11 MB).

---

## 2. Overview & Current State

- **Version**: `2.8.0` (versionCode `3`)
- **APK Artifact**: `app/build/outputs/apk/release/app-release.apk` (~2.96 MB, R8 minified, release signed)
- **Target Device**: TCL 55P635 (Android 11, ATV, 2GB RAM, 960x540 viewport, ADB `192.168.100.42:5555`)
- **Git State**:
  - Baseline Tag: `before-round2` (`a724f06`)
  - Release Tag: `v2.8.0`
  - Active Branch: `main`

---

## 3. Changes by Phase (Files Touched)

### Phase A — Sign-in Gate & 401 Enforcement (commit `98cc2c5`)
- **Files Touched**:
  - `app/src/main/assets/tv-ui.html` & `pc-runner/tv-ui.html`
  - `app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt`
  - `tests/phaseA.test.mjs`
- **What Changed**:
  - Defined missing `checkAuthAndRoute()` and `showWelcomeScreen()` at startup.
  - Completely removed "Guest" button and guest bypass mode; app is strictly locked behind Welcome overlay.
  - Native router enforces HTTP 401 on `/api/playlists*`, `/api/save-credentials`, `/api/sync-now`, and `/api/profiles*` when no session is present.
  - Dynamic user identity (removed hardcoded "Waleed Khan", "Family", "Kids").
  - Sign out purges token, local credentials, and local profile data.

### Phase B — Real Profiles & Content Rules (commit `796e4dc`)
- **Files Touched**:
  - `app/src/main/java/com/streamvault/tv/data/StreamVaultDatabase.kt`
  - `app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt`
  - `app/src/main/assets/tv-ui.html` & `pc-runner/tv-ui.html`
  - `tests/phaseB.test.mjs`
- **What Changed**:
  - Added Room SQLite table `profiles` with CRUD endpoints (max 5 profiles; primary cannot be deleted).
  - Personal data strictly scoped per profile (`profile_media_state`: watchlist, resume progress, ratings, search history).
  - Account-level Master PIN (PBKDF2 SHA-256 hash, 5-attempt lockout, re-auth to reset).
  - Kids Mode on/off per profile: filters to child certifications (G, PG, TV-Y, TV-Y7, TV-G, TV-PG, U; uncertified titles hidden; turning OFF requires Master PIN; 18+ Vault tab completely hidden).
  - 18+ Adult Vault: session-only memory unlock; auto re-locks on app standby, pause, and profile switch; zero tracking (no Continue Watching, no search history, no ratings).

### Phase C — Spatial Navigation & Back Key Contract (commit `cf9d701`)
- **Files Touched**:
  - `app/src/main/assets/tv-ui.html` & `pc-runner/tv-ui.html`
  - `app/src/main/java/com/streamvault/tv/MainActivity.kt`
  - `tests/phaseC.test.mjs`
- **What Changed**:
  - Deleted broken legacy ID chains (`setPlaylistName`, `btnSaveAccount`, etc.).
  - Implemented nearest-neighbor spatial navigation (`getBoundingClientRect`) across Settings and Profile.
  - Left boundary navigation smoothly jumps from content to active sidebar item (`PROFILE` -> user pill, `SETTINGS` -> settings icon).
  - Leanback Back key hierarchical contract: Content -> Active Sidebar Icon -> HOME -> Exit Confirm dialog.
  - Native text input caret movement and modal focus trapping.

### Phase D — Real Sync & Universal Dedup Anchoring (commit `ca59358`)
- **Files Touched**:
  - `cloud-sync/src/worker.js`
  - `app/src/main/java/com/streamvault/tv/data/PreferencesManager.kt`
  - `app/src/main/java/com/streamvault/tv/data/CatalogSyncEngine.kt`
  - `app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt`
  - `app/src/main/assets/tv-ui.html` & `pc-runner/tv-ui.html`
  - `pc-runner/server.js`
  - `tests/phaseD.test.mjs`
- **What Changed**:
  - TMDB proxy through Cloudflare Worker (`/api/tmdb/*`) with D1 cache (`X-Cache: HIT`); age certification extraction; zero API keys in APK.
  - Resumable catalogue upload to `/api/catalog/sync-batch` in chunks of 25 with exponential backoff; 14-day soft delete (`/api/catalog/mark-removed`).
  - Catalogue down streaming to Room (`/api/catalog/pull-cloud`).
  - `ProfileSyncManager`: debounced 10s queue, immediate flush on pause/switch/exit, delta pull via `/api/sync/pull` with last-write-wins by `updatedAt` (adult excluded).
  - Auto-import first enabled cloud playlist on new TV.
  - Real sync Settings UI ("Just now", "All synced").
  - Universal `dedupKey` anchoring retains 100% of user profile data across playlist swaps.

### Phase E — Auth Hardening, Resend Route, Probe Versions & Compose Cleanup
- **Files Touched**:
  - `cloud-sync/src/worker.js`
  - `cloud-sync/README.md`
  - `app/build.gradle.kts`
  - `app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt`
  - `app/src/main/assets/tv-ui.html` & `pc-runner/tv-ui.html`
  - `app/src/main/java/com/streamvault/tv/ui/StreamVaultPlayerScreen.kt` (deleted)
  - `app/src/main/java/com/streamvault/tv/ui/StreamVaultTvApp.kt` (deleted)
  - `tests/phaseE.test.mjs`
- **What Changed**:
  - Removed `devCode` leak from signup response in production; only returned when `DEV_MODE=true` is explicitly configured.
  - Migrated email dispatch to Brevo v3 Transactional Email API (`https://api.brevo.com/v3/smtp/email`, send-only, no contact lists).
  - Per-email rate limits on signup (3/min), login (5/min), verify (5/min), and resend (3/min).
  - Implemented `/api/auth/resend-code` route in `worker.js` and wired to TV UI (`resendVerificationCode`).
  - Implemented `/api/probe-versions` in native `AppApiRouter.kt` using fast HTTP Range bytes 0-10, size formatting, and CAM rip detection.
  - Completely purged unused Jetpack Compose dependencies and legacy screen files, reducing APK size from 4.11 MB to ~2.96 MB.

---

## 4. What Failed or Was Skipped

- **Failures**: 0 failures. All 42 automated assertions across 5 test suites passed cleanly.
- **Skipped / Held on Owner Request**:
  - ADB install to TCL 55P635 held.
  - Cloudflare Worker production deployment held.

---

## 5. Test Commands and Results

| Test Suite | Scope | Command | Result |
| :--- | :--- | :--- | :--- |
| **Phase A** | Sign-in gate, 401 enforcement, guest removal, dynamic ID | `node tests/phaseA.test.mjs` | **7/7 PASSED** |
| **Phase B** | Profiles CRUD, scoped data, Kids Mode, Master PIN, Vault | `node tests/phaseB.test.mjs` | **7/7 PASSED** |
| **Phase C** | Spatial navigation, element reachability, Leanback Back key | `node tests/phaseC.test.mjs` | **8/8 PASSED** |
| **Phase D** | TMDB proxy, catalog up/down, profile sync, dedup re-link | `node tests/phaseD.test.mjs` | **8/8 PASSED** |
| **Phase E** | `devCode` omission, Brevo email, per-email limits, resend route, probe-versions, Compose removal | `node tests/phaseE.test.mjs` | **12/12 PASSED** |
| **Full Run** | Complete regression suite (Phases A through E) | `node tests/phaseA.test.mjs; node tests/phaseB.test.mjs; node tests/phaseC.test.mjs; node tests/phaseD.test.mjs; node tests/phaseE.test.mjs` | **42/42 PASSED** |

---

## 6. Phase F Verification Matrix (TCL 55P635 TV)

| Check | Test Steps | Expected Behavior | Status |
| :--- | :--- | :--- | :--- |
| **1. Sign-in Gate** | Launch app on fresh install / after clear data | Welcome overlay opens; no "Guest" button; tabs unreachable | **PASS** (automated) |
| **2. Playlist Lock** | Sign in with an account having no playlists | Locked to "Add your IPTV playlist" screen | **PASS** (automated) |
| **3. Profile Picker** | Sign in with account having >1 profile | "Who's watching?" picker shows profiles; remembers last selection | **PASS** (automated) |
| **4. Spatial Nav (Settings)** | Navigate D-pad across all 4 quadrants in Settings | Focus reaches all buttons/inputs; never gets stuck; Left reaches sidebar | **PASS** (automated) |
| **5. Spatial Nav (Profile)** | Navigate D-pad across theme chips, kids toggle, PIN fields | Focus reaches every chip and control smoothly | **PASS** (automated) |
| **6. Back Key Contract** | Press Back from Content -> Sidebar -> HOME -> Exit | Content jumps to active sidebar pill -> HOME -> Exit prompt | **PASS** (automated) |
| **7. Kids Mode** | Turn ON on a profile; verify titles | Only child-certified titles visible; uncertified & 18+ tab hidden | **PASS** (automated) |
| **8. Master PIN** | Attempt to turn Kids Mode OFF; attempt Vault unlock | Requires 4-digit Master PIN; 5 failed attempts locks out | **PASS** (automated) |
| **9. 18+ Vault Privacy** | Play/search adult title; switch profile / press TV Home | Re-locks immediately; 0 items in Continue Watching or Search History | **PASS** (automated) |
| **10. Real Cloud Sync** | Click "Sync Cloud" in Settings Quadrant 2 | Shows "Just now", "All synced"; pushes and pulls updates | **PASS** (automated) |
| **11. D-Pad TV Feel** | Test D-pad navigation feel with remote on 55" display | Smooth scrolling, clear focus outlines, responsive 60fps feel | **Needs TV** |
| **12. Video Playback** | Play MKV, MP4, and HLS MPEG-TS live IPTV streams | ExoPlayer hardware decoding, audio sync, no stutter | **Needs TV** |
| **13. Cross-Device Sync** | Perform watchlist change on TV 1, check TV 2 | Profile state updates within 10s sync window | **Needs TV** |
| **14. 14-day Soft Delete** | Remove playlist item, observe mark-removed | Soft deleted in cloud; restores if re-added within 14 days | **Needs TV** |
| **15. 60k Catalog Load** | Stress test catalog with 60,000 titles on 2 GB RAM TV | Memory stable, no OOM crash | **Not Run** |

---

## 7. Worker Secrets & Environment Variables

| Variable / Secret | Type | Required | Purpose |
| :--- | :--- | :--- | :--- |
| `BREVO_API_KEY` | Secret | **Yes** | Brevo API key (`xkeysib-...`) for sending 6-digit verification codes |
| `AES_SECRET` | Secret | **Yes** | 32+ character random key for encrypting IPTV passwords at rest |
| `TMDB_API_KEY` | Secret | **Yes** | TMDB API v3 key for worker-level metadata enrichment |
| `JWT_SECRET` | Secret | **Yes** | Secret for signing session tokens and verification payloads |
| `BREVO_SENDER_EMAIL`| Var / Secret | Optional | Verified sender address (default: `noreply@streamvault.tv`) |
| `BREVO_SENDER_NAME` | Var / Secret | Optional | Sender display name (default: `StreamVault TV`) |
| `DEV_MODE` | Var | Optional | Set to `"true"` ONLY in automated local tests to expose `devCode` |

---

## 8. Owner's Remaining Steps (Max 3 Steps)

1. **Install v2.8.0 Release APK to TCL TV**:
   ```bash
   adb connect 192.168.100.42:5555
   adb -s 192.168.100.42:5555 install -r app/build/outputs/apk/release/app-release.apk
   ```

2. **Configure Brevo Secret & Deploy Worker**:
   ```bash
   cd cloud-sync
   npx wrangler secret put BREVO_API_KEY
   # Paste your Brevo key when prompted
   npx wrangler deploy
   ```

3. **Perform Phase F Verification**:
   - Use the Phase F table above with the TCL remote to complete final visual sign-off.
