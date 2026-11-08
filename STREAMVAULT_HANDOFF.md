# StreamVault TV — Comprehensive Project Handoff & Architecture

## 1. Project Overview & Deliverables
- **Goal**: Native, ultra-smooth, premium Android TV IPTV client tailored for **TCL 55P635 LED TV** (Android TV OS 11, Kernel `4.14.187+`, 2GB RAM) replacing *IPTV Pro Stream Player*.
- **Project Directory**: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv`
- **GitHub Repository**: [`waheedkhan10001/streamvault-tv`](https://github.com/waheedkhan10001/streamvault-tv)
- **Ready Release APK**: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\StreamVault-TV.apk` (14.56 MB)
- **Wi-Fi Install Script**: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\Push-To-TCL-TV.bat`
- **Host Companion Server**: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\pc-runner\server.js` (port 8765, serving `http://192.168.100.66:8765/tv`)
- **TCL 55P635 Android TV**: Connected wirelessly via ADB at `192.168.100.42:5555`.

---

## 2. Real IPTV Account & Database State
- **IPTV Server**: `http://aadiflix.online:8080` (User: `waleed84838`, Pass: `waleed84839`)
- **Database File**: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\pc-runner\data\streamvault_pc_db.json`
- **Catalog Scale**:
  - **60,853 clean VOD titles** (family-safe: adult, dancer clips, and stage drama clips automatically filtered).
  - **3,000 Live TV channels** with categories and favorite pinning.
- **Data Decoupling & Protection**:
  - Watch progress, resume bookmarks, watchlists, and user star ratings are anchored to universal **TMDB ID** / canonical title hashes.
  - If the IPTV provider ever changes credentials or server URLs, user history is permanently preserved and automatically re-linked.

---

## 3. Architecture & Latest Fixes (Completed & Verified Live on TV)

### A. Hardware-Accelerated Video Playback (ExoPlayer) & Audio/Subtitle Drawer
- Fixed root cause of playback failure (HTTP 405 Method Not Allowed caused by stale legacy mock stream IDs taking priority).
- Database cleanly populated from genuine IPTV VOD streams (`action=get_vod_streams`).
- Native ExoPlayer integration in `MainActivity.kt` handles 302 redirects with VLC User-Agent sniffing, sets `MimeTypes.APPLICATION_MATROSKA` for MKV containers, and decodes 5.1 multi-channel surround sound on the TCL TV.
- **In-Player Quick Drawer for Audio & Subtitles** (Remote **▲ DPAD-UP**):
  - Two-column modern translucent drawer: Left column for audio streams (e.g. `English (5.1ch Surround)`, `Hindi (Stereo)`) and Right column for subtitles (`Off (Disable)`, embedded subtitles, etc.).
  - Remote **◀ ▶** switches columns, **▲ ▼** navigates tracks, **OK** applies track switch in real-time via `TrackSelectionOverride` and `setTrackTypeDisabled(C.TRACK_TYPE_TEXT, ...)`, and **Back** closes drawer.
- **HUD & Status Indicators**:
  - Independent top-level `hudOverlay` ensures seek badges (`+5s ▶▶` on right, `◀◀ -5s` on left) and center play/pause indicators are always visible.
  - When paused, center badge shows `❚❚ Paused` and stays visible alongside the bottom timeline scrubber.
  - When playing, center badge flashes `▶ Playing` (800ms) and the timeline auto-hides after 3.5s.
  - Remote **OK** directly toggles Play/Pause.
  - Remote **Back** exits playback immediately and automatically saves resume position.

### B. D-Pad Remote Spatial Navigation & Sidebar Behavior
- Fast O(1) sibling spatial navigation in `tv-ui.html` prevents DOM traversal lag.
- **Sidebar Auto-Activation**: Navigating Up/Down through sidebar tabs activates that tab immediately (`navigateToTab(tabId)`) without needing an extra OK press.
- **Smart Focus Memory**: Moving Left/Back to sidebar remembers `lastContentFocusTarget`; pressing Right on the sidebar restores focus directly to the previously selected card or filter pill instead of defaulting to the top search box.
- Sidebar trapping: moving Up/Down stays strictly within sidebar buttons, stopping at Home (top) and User Profile / Settings (bottom).

### C. Search Filter Bar, Search Button, Autocomplete & Intelligent Matching
- Search input bar is flush with the movie posters grid beneath it; width resized to accommodate a dedicated high-contrast `Search` button.
- **Intelligent Search Engine**: Stop-word filtering (`based`, `movie`, `movies`, `film`, etc.), comprehensive synonym matching (`jungle`, `forest`, `space`, `horror`, etc.), and multi-attribute weighted scoring (title match +300, genre +40, cast +35, plot +20). Queries like "jungle based movies" return 630 matching titles headed by top relevancy.
- **Autocomplete Suggestions**: Clickable/focusable suggestion chips render dynamically beneath the search bar.
- **Clean Slate on Tab Switch**: Navigating between tabs resets search query and filter dropdowns to clean catalog defaults per modern streaming standard.
- Floating dropdowns render above content (`z-index: 99999`) with full vertical height and violet scrollbars.

### D. Fit-to-Screen Cinema Detail Modal, Series Episode System & Air-Tight Focus Trap
- **Fit-to-Screen Cinema Architecture**:
  - Transformed detail view from vertical multi-scroll into a zero-scroll 1080p fit-to-screen cinema interface.
  - Ambient full-screen blurred backdrop + 170x255 high-res poster + title, meta badges (rating, quality, audio/sub, year, runtime, genres), interactive 5-star rating widget, 3-line synopsis, cast & director, and uniform action buttons in the top 65%.
  - Bottom 35% features horizontal carousels: Season Tabs + Episode Cards for Series, and Criteria Chips + Related Strip for Movies.
  - Zero clipping and zero window auto-scroll.
- **Series Season Tabs & Episode Carousel**:
  - Full support for TV series episodes (`action=get_series_info` parsed in `server.js`).
  - Interactive season tabs (`Season 1`, `Season 2`...) and horizontal episode cards displaying `S[x] E[y]` badge, episode title, runtime in minutes, and plot synopsis.
  - Play button dynamically reflects up next episode (`▶ Play S2 E1` or `▶ Resume S2 E1 (at MM:SS)`).
  - Clicking any episode card directly launches playback for that specific episode stream.
- **Air-Tight Focus Leak Bug Fix**:
  - Resolved root cause of remote focus leaking through into background posters behind the modal (caused by `detailOverlay.style.display` being `'flex'` while navigation routines checked `'block'`).
  - Strict modal focus trapping in `fastNavigate` and `navigateSpatial`: if active element is outside modal when modal is open, focus snaps back to the primary action button.
  - Navigation traversal cleanly handles: Close Button (✕) ↔ 5-Star Rating ↔ Action Buttons ↔ Lower Tabs / Season Pills ↔ Episode Cards / MLT Posters.
  - When returning from video playback (`window.onPlaybackExited` / `exitPlayer`), modal action buttons update resume timestamp and re-focus primary button automatically.
- **Explore All / Show More Focus Fix**:
  - Clicking "Explore All" in More Like This passes pre-filter criteria to `navigateToTab('SEARCH', { includedGenres: [genre], mediaTypeFilter: mediaType }, focusFirstCard = true)` without resetting state.
  - Focus lands directly on the first poster card in the catalog grid (`#filterResultsGrid .poster-card`), allowing smooth Down arrow traversal without triggering sidebar tab navigation.
- **Circular Frosted Glass Seek HUD**:
  - Both native ExoPlayer and web player upgraded to 10-second seek step with circular frosted glass HUD indicators: `⟳ 10s` (forward) and `⟲ 10s` (rewind).
- **Language Filter Clarification**:
  - Language filter directly filters **Audio Stream Language** (from IPTV stream and category metadata), ensuring matching titles provide genuine English dialogue.

---

### E. Theme, Badges & "More Like This" End Card
- Theme: Deep Royal Violet (`#7C3AED`) and Obsidian (`#090714`).
- Poster selection: Removed harsh white outline on focus/zoom, replaced with a subtle ambient violet glow (`box-shadow: 0 12px 30px rgba(124, 58, 237, 0.42)`).
- End card redesigned: Netflix-style frosted glass gradient card with subtle violet border glow, clean circular right arrow (`→`), and "Explore All" title.
- Corner-pinned poster badges with high-contrast opaque dark backgrounds.

### F. Acoustic Click Audio Engine & My List Route
- Fixed `/api/watchlist` route in `server.js` returning clean JSON and eliminating 404/Unexpected Token error.
- Series tab locks `mediaTypeFilter = 'SERIES'`, displaying 5,488 series without bleeding movies into the query.
- Synthesized 20ms PCM 16-bit 44.1kHz acoustic sine click curve played via `AudioTrack` with `AudioAttributes.USAGE_MEDIA`.

### G. Multi-Season Auto-Federation, Series Badging & Genre Coverage
- **Multi-Season Auto-Federation (`server.js`)**:
  - IPTV providers frequently package seasons either as a single container OR as separate standalone entries per season (e.g. `The Great Indian Kapil Show (2025) S04` and `(2026) S05`, or `Dexter: Resurrection (2026) S02`).
  - `/api/detail` now automatically scans for sister season entries sharing the same `tmdbId` or normalized title and unifies all seasons and episodes under one master series view with interactive season pills (`Season 2`, `Season 3`, `Season 4`, `Season 5`).
- **Cover Season Badges & Search Grid Distinction (`tv-ui.html`)**:
  - Series poster cards feature a bold violet glowing gradient badge pinned to top-left: `SERIES • S2` (or `SERIES • 3 Seasons`, or `SERIES`), while the gold star rating (`★ 8.5`) shifts to top-right beside the `HD` chip.
  - Series poster cards feature a dedicated violet accent focus border (`#8B5CF6`) and violet ambient shadow when navigated on the TV remote.
  - Movies in the mixed search grid retain classic gold rating tags on top-left, making Movies vs Series immediately distinguishable at a glance.
- **100% Series Genre Tag Coverage**:
  - Series detail modal now extracts rich genres from Xtream Codes `get_series_info` (`sData.info.genre`) with automatic fallback to IPTV `categoryName`.
  - Displayed as vibrant purple cinema chips (`badge-genre-cinema`: `Crime`, `Drama`, `Mystery`, `Reality`, etc.) ensuring no Series ever has missing genre tags.

### H. Polish & Verification of 7 User Concerns (Completed & Verified Live)
1. **Series Badges Relocated to 2nd Row**:
   - Removed badge overlays from inside the poster artwork.
   - Top corners of poster artwork strictly reserved for Gold Star Rating (`★ 8.5`) on top-left and Quality (`1080p`/`HD`) & `Watched` on top-right.
   - Row 1: Title. Row 2: Dedicated type pill (`SERIES` + `Season 1` / `2 Seasons` or `MOVIE` + `2024`). Row 3: Genres.
   - Sister season federation automatically gathers all available seasons on the provider into the Watch Now screen with interactive season pills.
2. **False TMDB Match Repaired ("Heart of the Beast" vs "The Beast")**:
   - `findBestTmdbMatch` now enforces strict title similarity ratio (>= 0.70) and year distance (<= 1 year), preventing false positive TMDB ID assignments.
   - Repaired entry `410295` in `streamvault_pc_db.json`. Verified live: More Like This under *Heart of the Beast* displays genuine artwork for every title.
3. **Continue Watching Reliability & Capacity**:
   - Added 10-second periodic background autosave in `MainActivity.kt`.
   - Synchronous progress save on `onPause()` and `onStop()`.
   - Lowered minimum resume threshold from 30s to 15s.
   - Increased capacity to 30 titles sorted by `lastWatchedTimestamp DESC` (most recently watched first).
4. **IPTV Provider Stream Quality Audit**:
   - Audited provider streams for *Heart of the Beast* directly from `aadiflix.online:8080`.
   - Confirmed both streams (`448510` and `449791`) come with the hardcoded "Dragon Money" betting sponsor watermark from the source provider release.
   - Added deduplication quality promotion (4K > 1080p > HD > SD) ensuring highest quality stream is always `primaryStreamId`.
5. **Search History & Settings Clear (YouTube TV Model)**:
   - Empty search input displays vertical "Recent Searches" with clock icons (🕒).
   - Typing pins matching history at the top followed by catalog suggestions (🔍).
   - Long-press OK (>=550ms) on a history item opens "Remove from search history?" confirmation modal with `Cancel` (default) and `Remove`.
   - Settings tab features dedicated "Search & Privacy" card with `Clear Search History` button that clears all search history without wiping Continue Watching, ratings, or watchlist bookmarks.
6. **Parental Controls (Adult Content Locked by Default & Auto-Lock on Standby)**:
   - All 593 live adult channels and 667 VOD adult items are hidden by default from search, autoChips, catalog queries, and live TV channels.
   - Unlocked via Master 4-digit PIN dialog (default `0000`, customizable in Settings).
   - Android `onPause()` and `onStop()` in `MainActivity.kt` plus `visibilitychange` in `tv-ui.html` automatically re-lock parental controls immediately when the TV goes into standby or app is backgrounded.
7. **Hero Billboard Smooth Scroll-Back**:
   - In `tv-ui.html`, pressing ArrowUp from the top movie row scrolls `#mainViewport` back to `top: 0` and focuses the hero billboard action button with `{ preventScroll: true }`, ensuring the full hero poster and synopsis are never cut off.

### I. Major Release v2.5: 5-Column Cinematic Grid, Dedicated Profile & Cloud Sync, and Search History Engine (Verified Live)
1. **5-Column Cinematic Density ($5 \times 2$ Full Posters Visible)**:
   - Upgraded `.results-grid` to `grid-template-columns: repeat(5, minmax(0, 1fr)) !important;` with 15px gap.
   - Exactly 10 full posters ($5 \times 2$) fit simultaneously on screen inside 1080p without any clipping below the filter bar.
   - Inside poster artwork: bottom-right strip displays `MOVIE` or `SERIES • S2` (replacing language tag); bottom-left strip displays `YEAR` (`2026`).
   - Under title: redundant year/series row eliminated; Row 1 displays bold Title, Row 2 displays Genre chips.
   - Updated `getGridColumns(grid)` to 5 and synchronized spatial D-pad navigation (`idx + 5` / `idx - 5`) across Movies, Series, and Search.
2. **Search History Engine Repaired**:
   - Fixed root cause: Decoupled 220ms keystroke debouncing from search history saves, preventing partial keystroke fragments (`b`, `br`, `bra`, `cast c`) from displacing real searches.
   - Strict commit triggers: Queries save to history ONLY on explicit submission (Enter/OK key, Search button click, chip click, or poster click).
   - Instant Recent Searches popup: Focusing or clicking `#filterSearchInput` displays recent searches immediately with clock icons (🕒) and "Hold OK to remove" hints.
3. **Decoupled User Profiles & Cloud Sync from System Settings**:
   - Industry-standard separation: Avatar pill on bottom left strictly opens "User Profiles & Cloud Sync" (`loadProfile`), while Gear icon on bottom right strictly opens "Settings & System" (`loadSettings`).
   - Profile Switcher: Horizontal profile cards (`Waleed Khan (Active)`, `Family`, `Kids (Kids Mode)`, `+ Add Profile`) with 1-click D-pad profile switching.
   - Profile Customization: Editable Display Name, 6 avatar color theme chips, and 1-click Kids Mode filter.
4. **Cloudflare Workers + D1 Cloud Sync Architecture (Live on Edge)**:
   - **Production Edge URL**: `https://streamvault-sync.streamvault-app.workers.dev`
   - **Cloudflare Account**: `wkhan.10001@gmail.com` (`0bab3b894a68adb77fdd14596a3f4364`)
   - **Subdomain**: `streamvault-app.workers.dev`
   - **D1 Database**: `streamvault-db` (`d1d96b37-9099-4455-8428-954c322cfa37`) in region APAC (Hong Kong)
   - **Tables**: `accounts`, `tv_codes`, `profiles`, `user_sync_data`
   - **Mobile Link Web App**: `https://streamvault-sync.streamvault-app.workers.dev/link`
   - **Live TV Pairing**: Server relays live 6-digit codes (e.g. `SV-4FKQ`) from Cloudflare edge with QR code directly rendered on TV screen.
   - Zero-cost serverless architecture (100k requests/day free, <20ms global edge speed).
   - Automatic IPTV credential and profile provisioning: Logging into any new TV automatically restores playlists, continue watching progress, bookmarks, and ratings with zero password entry on remote.
5. **Clean Zero-Scroll Settings Screen**:
   - Left: IPTV Provider & Playlists (`Playlist Name`, `Server URL`, `Username`, `Password`, `Save & Connect`) + Factory Reset.
   - Right: Hardware Acceleration (`HW+ ExoPlayer Media3`, `English 5.1ch Surround`), Parental PIN, and Privacy/History Clear.
   - 100% zero-scroll 1080p layout.

---

## 5. Live TV Verification on TCL 55P635
- Built and signed release APK: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\StreamVault-TV.apk` (15.27 MB).
- Installed live over Wi-Fi ADB to TCL 55P635 TV at `192.168.100.42:5555`.
- Host PC companion running on `192.168.100.66:8765` over Wi-Fi SSID `EME-CORE-HAI`.
- Live screenshot verification:
  - `tv_movies_5col.png`: Verified 5-column cinematic grid displaying 10 complete posters ($5 \times 2$) with zero vertical clipping below the filter bar.
  - `tv_search_hist.png`: Verified Search History popup displaying recent searches with TV remote soft keyboard active.
  - `tv_profile_linked.png`: Verified dedicated User Profiles & Cloud Sync screen linked live to Cloudflare Account (`WKHAN.10001@GMAIL.COM`) with active code `SV-4FKQ`.
  - `tv_settings_screen.png`: Verified clean, dedicated Settings & System screen with IPTV credentials, HW+ ExoPlayer decoder stats, Parental PIN, and Clear History.
  - `tv_home_5col.png`: Verified Home screen with decoupled bottom Profile pill and Settings gear icon.

---

## 6. Network & Daemon Quick-Check
- **Wi-Fi Subnet**: Both PC and TV must stay connected to `EME-CORE-HAI` (`192.168.100.x`).
  - PC IP: `192.168.100.66`
  - TV IP: `192.168.100.42`
- **Companion Daemon Command**:
  ```powershell
  cd "C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\pc-runner"
  node server.js
  ```
- **ADB Reconnect**:
  ```powershell
  & "C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\.toolchain\android-sdk\platform-tools\adb.exe" connect 192.168.100.42:5555
  ```

---

## 7. How to Continue in a New Chat
1. Open a new chat in Antigravity.
2. Paste this exact prompt:
   > "I am continuing development on StreamVault TV (Android TV IPTV app running live on TCL 55P635). All project files, architecture, and live verification state are documented in `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\STREAMVAULT_HANDOFF.md`. Please review that file and confirm you are up to date so we can proceed with polishing."
