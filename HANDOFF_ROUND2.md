# StreamVault TV — Round 2 Handoff Document (v2.8.0, versionCode 3)

## 1. Overview & Current State

- **Version**: `2.8.0` (versionCode `3`)
- **APK Artifact**: `app/build/outputs/apk/release/app-release.apk` (~4.11 MB, R8 minified, release signed)
- **Target Device**: TCL 55P635 (Android 11, ATV, 2GB RAM, 960x540 viewport, ADB `192.168.100.42:5555`)
- **Git State**:
  - Baseline Tag: `before-round2` (`a724f06`)
  - Release Tag: `v2.8.0`
  - Active Branch: `main` (merged from `round2-fixes`)

---

## 2. Changes by Phase (Files Touched)

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
  - `app/src/main/java/com/streamvault/tv/data/AppDatabase.kt`
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

### Phase E — Auth Hardening & Brevo Email (commit `d224aa5`)
- **Files Touched**:
  - `cloud-sync/src/worker.js`
  - `cloud-sync/README.md`
  - `tests/phaseE.test.mjs`
- **What Changed**:
  - Removed `devCode` leak from signup response in production; only returned when `DEV_MODE=true` is explicitly configured.
  - Migrated email dispatch to Brevo v3 Transactional Email API (`https://api.brevo.com/v3/smtp/email`, send-only, no contact lists).
  - Configurable sender (`BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME`, defaulting to `noreply@streamvault.tv` / `StreamVault TV`).

---

## 3. What Failed or Was Skipped

- **Failures**: 0 failures. All 36 automated assertions across 5 test suites passed cleanly.
- **Skipped / Held on Owner Request**:
  - Step 2 (ADB install to TCL 55P635) held.
  - Step 3 (Cloudflare Worker production deployment) held.

---

## 4. Test Commands and Results

| Test Suite | Scope | Command | Result |
| :--- | :--- | :--- | :--- |
| **Phase A** | Sign-in gate, 401 enforcement, guest removal, dynamic ID | `node tests/phaseA.test.mjs` | **7/7 PASSED** |
| **Phase B** | Profiles CRUD, scoped data, Kids Mode, Master PIN, Vault | `node tests/phaseB.test.mjs` | **7/7 PASSED** |
| **Phase C** | Spatial navigation, element reachability, Leanback Back key | `node tests/phaseC.test.mjs` | **8/8 PASSED** |
| **Phase D** | TMDB proxy, catalog up/down, profile sync, dedup re-link | `node tests/phaseD.test.mjs` | **8/8 PASSED** |
| **Phase E** | `devCode` omission, Brevo transactional email conform | `node tests/phaseE.test.mjs` | **6/6 PASSED** |
| **Full Run** | Complete regression suite (Phases A through E) | `node tests/phaseA.test.mjs; node tests/phaseB.test.mjs; node tests/phaseC.test.mjs; node tests/phaseD.test.mjs; node tests/phaseE.test.mjs` | **36/36 PASSED** |

---

## 5. Phase F Verification Matrix (TCL 55P635 TV)

| Check | Test Steps | Expected Behavior |
| :--- | :--- | :--- |
| **1. Sign-in Gate** | Launch app on fresh install / after clear data | Welcome overlay opens; no "Guest" button; tabs unreachable |
| **2. Playlist Lock** | Sign in with an account having no playlists | Locked to "Add your IPTV playlist" screen |
| **3. Profile Picker** | Sign in with account having >1 profile | "Who's watching?" picker shows profiles; remembers last selection |
| **4. Spatial Nav (Settings)** | Navigate D-pad across all 4 quadrants in Settings | Focus reaches all buttons/inputs; never gets stuck; Left reaches sidebar |
| **5. Spatial Nav (Profile)** | Navigate D-pad across theme chips, kids toggle, PIN fields | Focus reaches every chip and control smoothly |
| **6. Back Key Contract** | Press Back from Content -> Sidebar -> HOME -> Exit | Content jumps to active sidebar pill -> HOME -> Exit prompt |
| **7. Kids Mode** | Turn ON on a profile; verify titles | Only child-certified titles visible; uncertified & 18+ tab hidden |
| **8. Master PIN** | Attempt to turn Kids Mode OFF; attempt Vault unlock | Requires 4-digit Master PIN; 5 failed attempts locks out |
| **9. 18+ Vault Privacy** | Play/search adult title; switch profile / press TV Home | Re-locks immediately; 0 items in Continue Watching or Search History |
| **10. Real Cloud Sync** | Click "Sync Cloud" in Settings Quadrant 2 | Shows "Just now", "All synced"; pushes and pulls updates |

---

## 6. Worker Secrets & Environment Variables

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

## 7. Owner's Remaining Steps (Max 3 Steps)

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
