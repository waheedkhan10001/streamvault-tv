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

### I. Polish & Enhancements: Genre AND Filtering, Smart Director/Cast Search, Clean Settings, and Version Switching (Verified Live)
1. **Multi-Genre AND Filtering**:
   - Switched genre matching from `OR` to `AND` in both `tv-ui.html` and `server.js` (`matchAllIncludedGenres = true`).
   - Selecting multiple genres (e.g. `Action` and `Comedy`) now strictly requires titles to contain all selected genres.
2. **Text Cleanup & Minimalist Leanback UI**:
   - Removed `(Scroll down for more)` from the title count label across all tabs (`Showing 1 - 120 of N titles`).
   - Removed `(Click star to remove)` from the star rating display (`5/5 Saved`).
   - Removed `Press & Hold OK to Remove` banner above search suggestions.
3. **Smart Search Engine Architecture (Hybrid Directed By, Starring, Prefix, & Fuzzy Typo Correction)**:
   - Search runs completely local and offline via fast in-memory indexing (<15ms across 60,853 titles).
   - Natural language intent parsing: automatically extracts `directed by <name>`, `starring <name>`, `movies with <name>`, `featuring <name>` and boosts matching director/cast (+400 score).
   - Prefix parsing: supports explicit `director:<name>`, `dir:<name>`, `cast:<name>`, `starring:<name>`, `actor:<name>`.
   - Fuzzy typo tolerance: Damerau-Levenshtein edit distance ($\le 1$ to 2 characters for words 4+ letters) matches common typos (e.g. `christopher nola` or `nolna` matches `Christopher Nolan`).
4. **Settings Screen Re-Architected to 2-Column Grid**:
   - Converted vertical stacked settings into a 2-column layout (`grid-template-columns: 1.05fr 0.95fr`).
   - Fits 100% inside 1080p display viewport without requiring any vertical scrolling.
   - Left: Account & Profile + Factory Reset; Right: Parental PIN + Search & Privacy.
5. **Custom Display Name & Universal Data Persistence**:
   - Added user `Display Name` field in Settings and saved to `state.credentials.displayName`.
   - Sidebar profile pill and user profile modal dynamically display `Waleed Khan`.
   - User data architecture verified: Continue Watching, Watchlist, Ratings, and enrichments are keyed by universal `dedupKey` (TMDB ID / normalized title) and remain 100% intact even if IPTV account credentials change.
6. **Recent Searches Clean Display**:
   - Recent search suggestions container is hidden when browsing catalog grids and only displays when actively typing in the search box.
7. **Dual Approach for Multi-Version & '*' Clean/HQ Releases**:
   - Deduplication quality engine promotes releases marked with `*` (e.g. `Heart of the Beast (2026)*`) as `primaryStreamId` and index 0 of `versions`.
   - Watch Now detail modal provides an interactive Version Switcher row displaying `▶ ⭐ Clean HQ* (HD)` alongside `▶ Version 2: English (HD)` so users can seamlessly switch streams.
8. **Long-Press OK Fix on Search History**:
   - Suppressed immediate synchronous `click()` on `keydown` for `.is-history` items.
   - Keyup executes short tap (fills query) while $\ge 550\text{ ms}$ keydown cleanly opens the Delete confirmation modal without filling the search field.

### H. TV Remote Textbox Auto-Advance, Dedicated 18+ Vault & Multi-Tier Stream Probing (Latest Session)
1. **TV Remote Soft Keyboard Auto-Advance (`tv-ui.html`)**:
   - Implemented `advanceToNextInput`, `moveToPreviousInput`, and `onPinInput` for seamless TV remote entry without remote hunting.
   - In Parental PIN: entering 4 digits into `Current PIN` (`setCurPin`) automatically advances cursor into `New PIN` (`setNewPin`); entering 4 digits into `New PIN` advances into `Confirm PIN` (`setConfirmPin`); entering 4 digits into `Confirm PIN` automatically dismisses soft keyboard and highlights the `Update` button (`#btnUpdatePin`).
   - In Settings form: pressing D-Pad Down/Right or Enter on TV remote smoothly traverses from `Display Name` → `Playlist Name` → `Server URL` → `Username` → `Password` → `Save & Connect`.
2. **Adult Content Ingest & Dedicated 18+ Vault Sidebar Tab (`server.js` & `tv-ui.html`)**:
   - Discovered and ingested 2,681 titles across 11 adult IPTV categories (`XXX Hindi`, `XXX Hindi Full`, `XXX VIP`, `XXX Team Skeet`, `XXX Best Full Movies`, `XXX Redhat`, `XXX Strom`, `XXX Adult Ultimate`, `XXX Korean`, `XXX Japanese`, `Philippines 18+`).
   - Separated junk clips (mujra, dance, stage drama) from adult catalog; all adult content is tagged `isAdult: true`.
   - Strict segregation: adult content is 100% blocked from default media queries, Movies/Series tabs, and Home rows.
   - **Dedicated `18+ Vault` Sidebar Tab**: Conditionally rendered ONLY when the session is unlocked (`parentalControl.isLocked === false && parentalControl.showAdult === true`). Completely hidden and unreachable when locked.
   - Custom 18+ Vault Super Filter Bar: Studio/Category dropdown (`dropAdultCat`), Year dropdown (`dropAdultYear`), Quality dropdown, Sort dropdown, and a 1-click `🔒 Lock Vault` button.
   - Immediate Return & Auto-Lock: Clicking `🔒 Lock Vault` or triggering TV standby/app background (`visibilitychange`) immediately locks the session, removes `18+ Vault` from the sidebar, and navigates back to `Home`.
3. **Robust Multi-Tier Quality Detection & Fast 11-Byte Stream Prober**:
   - Upgraded `classifyCategoryAndTitle` with a multi-tier heuristic:
     - Heavy penalty (-30) for CAM, HDCAM, TS, TELESYNC, TC, 1XBET, BETWINNER, DRAGON MONEY, SLOT releases.
     - Positive bonuses: 4K/UHD/REMUX (+40), BluRay (+30), WEB-DL/WEBRIP (+25), Clean HQ* (+15), 1080p/FHD (+15), HD (+10).
   - HTTP Stream Probing (`probeStreamSize`): Cloudflare blocks standard `HEAD` requests with HTTP 520, but HTTP `GET` with `Range: bytes=0-10` returns HTTP 206 Partial Content and `Content-Range: bytes 0-10/<TOTAL_BYTES>`, measuring exact file sizes in ~40ms while transferring only 11 bytes.
   - Live probe on *Heart of the Beast*: Clean HQ* release is verified at 995 MB (1,042,894,167 bytes) vs older watermarked release at 870 MB (912,480,337 bytes). Clean HQ* version is reliably ranked #1.
   - Dynamic version switcher pills display verified metadata: `▶ ⭐ Clean HQ* (Clean HQ* • 995 MB)` and `▶ Version 2 (HD • 870 MB)`.

4. **UI/UX & Remote Navigation Polish (v2.4)**:
   - **4-Column Cinematic Grid**: Refactored `.results-grid` with `grid-template-columns: repeat(4, minmax(0, 1fr)) !important;`, `overflow-x: hidden !important;`, `gap: 16px;`, and strict child constraints (`min-width: 0 !important; max-width: 100% !important; aspect-ratio: 2 / 3 !important;`). Displays exactly 4 large cinematic posters per row (~308 physical pixels wide on 1080p) across Search, Movies, and My List.
   - **Detail Modal Version Selection**: Remote `ArrowDown` from action buttons navigates directly to the version pills row (`.detail-version-pill`), `ArrowLeft`/`ArrowRight` switches versions, `ArrowUp` returns to actions, and `ArrowDown` advances to More Like This chips.
   - **Subtitle Auto-Selection**: ExoPlayer Media3 configured with `TrackSelectionParameters` setting preferred language `"en"` and `Player.Listener.onTracksChanged` to auto-select English (or first discovered subtitle track) upon initial playback without requiring exit and resume.
   - **Soft Keyboard 'X' / Backspace**: Keycode 8 inside `<input>` and `<textarea>` deletes the preceding character rather than closing the dialog or exiting the view.
   - **Settings Screen Cleanup**: Renamed "Account & Profile" -> "Profile", added editable Display Name (`Waleed Khan`) decoupled from IPTV credentials, renamed "Search and Privacy" -> "Privacy", simplified buttons to "Clear", "Unlock" / "Lock", "Reset", and subtext to "Wipes everything". Entire screen fits on 1080p without vertical scrolling.
   - **Search Bar & Suggestions Polish**: Popup aligns pixel-perfectly with search input width, limited to max 5 items, only appears while typing or clicking search box, dismisses on Enter or navigating Down to cards. Long-pressing OK on remote opens confirmation modal to remove item from history. Search button redesigned as icon-only (`🔍`) with dedicated voice search button (`🎙️`) wired to native `RecognizerIntent`.
   - **Main Screen Left Navigation**: Pressing Left from any content row jumps directly to `.nav-btn.active` in the sidebar instead of falling through to profile/settings at the bottom.
   - **Hero Banner Up Scroll**: Navigating `ArrowUp` from row 0 smoothly scrolls the hero billboard completely back into view.

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

### J. Major Release v2.6: Symmetrical 2x2 Quadrant Settings, Bedside 180px QR Code, Protected Profiles & Netflix Home Density (Verified Live)
1. **Symmetrical 2x2 Quadrant Settings Screen**:
   - Redesigned from asymmetric 2-column layout into 4 uniform, equal-weight quadrants (`grid-template-columns: 1fr 1fr; gap: 14px;`):
     - Quadrant 1 (Top-Left): IPTV Provider & Playlists (`Playlist Name`, `Server URL`, `Username`, `Password`, `Save & Connect`).
     - Quadrant 2 (Top-Right): Playback & Hardware Engine (`HW+ ExoPlayer Media3`, `English 5.1ch Surround`, `4K UHD > Clean HQ* > 1080p`, `11-Byte Fast Probe`).
     - Quadrant 3 (Bottom-Left): Parental Controls & PIN (Current/New/Confirm 4-digit PIN auto-advance inputs + Adult Vault toggle).
     - Quadrant 4 (Bottom-Right): Privacy & Maintenance (`Clear Search History` + `Clean Factory Reset` + TMDB data decoupling protection).
   - 100% zero-scroll on 1080p with matching borders, uniform padding (`16px 18px`), and aligned action rows.
2. **Bedside High-Contrast 180px QR Code**:
   - Expanded Cloud TV Link hero card to balanced 330px height matching Profile Customization card.
   - Replaced tiny 76px QR thumbnail with prominent 180px high-contrast QR code (`size=300x300` rendered at 164x164 inside white quiet zone card) easily scannable from bed (8-12 feet away on 55" TV).
   - Side-by-side format: QR code on left, bold 6-digit pairing code (`SV-XXXX`) and clear 3-step instructions on right.
3. **Protected Profile Management & Dynamic Top Name Bug Fix**:
   - Fixed bug where active profile name on top "Who's Watching?" tile stayed stale after saving new display name: `saveActiveProfile()` now dynamically updates both `.profile-name-text` and `.profile-avatar-initials` in the DOM immediately.
   - Primary profile (`prof_1`) is protected (cannot be deleted, retains account owner status).
   - Secondary profiles feature a red `Delete Profile` button opening a TV-friendly confirmation dialog.
   - Backend endpoints implemented: `POST /api/profiles/create` and `POST /api/profiles/delete` with active profile failover.
4. **Netflix / Apple TV Standard Poster Scaling**:
   - Upgraded Home discovery rows (`.row-section .poster-card` and `.row-section .poster-img-wrap`) to ~195px wide (`187px x 276px`), displaying ~6.5 punchy cards per row with an edge-peek affordance inviting horizontal scrolling.
   - Category browse tabs (Movies, Series, Search) retain the verified 5-column cinematic grid (10 full posters visible without clipping).
5. **New TV Credential Provisioning & Friend TV Distribution**:
   - **New TV Flow**: Zero typing on TV remote — TV displays 6-digit code and QR code. Scanning with phone links TV via Cloudflare Workers + D1 and automatically pushes IPTV credentials, watchlist, ratings, and resume history to the TV in seconds.
   - **Friend TV Distribution**: How to share the standalone APK or connect via companion documented in Section 6.
6. **Universal Remote Navigation & 2D Settings Grid (Verified Live)**:
   - **Universal Sidebar Active Tab Return (`ArrowLeft`)**: Replaced broken `#sidebarNav` selector with universal `getActiveSidebarElement()`. Pressing Left from ANY content area (Home carousel, Search/Movies/Series 5-col grids, Live TV channel cards, Settings quadrants, Profile hero cards) consistently focuses the active tab on the sidebar (e.g. Home tab, Series tab, Settings icon, or Profile pill), eliminating accidental fallthroughs to the user profile pill.
   - **Settings Screen 2D Grid Routing**: Removed linear `advanceToNextInput` arrow hijacking from inputs. Replaced with an explicit 2x2 quadrant spatial map connecting IPTV Provider (Q1), Playback Engine (Q2), Parental Controls (Q3), and Privacy Maintenance (Q4). Up/Down/Left/Right navigate strictly in their intended 2D direction with interactive Audio Priority and Dedup Quality selectors in Q2.

7. **Zero-Scroll User Profile Screen & Bedside QR**:
   - Shortened instruction text to 2 crisp bullets and large single-line pairing code SV-7482.
   - Maintained high-contrast ~155px QR code on white card for effortless bedside phone scanning.
   - Balanced card height (285px) completely eliminating vertical scroll on 1080p Android TV.
8. **Settings Screen Zero-Scroll Layout**:
   - 4-quadrant layout measures ~430px tall, completely fitting within 1080p viewport without any vertical scrolling.
9. **Factory Reset Confirmation Modal & Progress Toast**:
   - Replaced browser alert() with an Android TV modal overlay with warning icon, default focus on Cancel, animated wiping spinner, and floating HUD toast (showToast()).
10. **Subtle Violet Poster Focus Border & Zero Edge Clipping**:
    - Applied uniform 1.5px violet focus border (#A78BFA / var(--theme-border)) on all posters (Movies, Series, Continue Watching) preserving soft ambient glow.
    - Added 14px horizontal padding to .results-grid and .poster-strip so border is never clipped at left/right viewport edges.
11. **Smooth Live TV Horizontal Pill Navigation**:
    - Prevented DOM destruction/rebuilding of tab buttons on tab change in fetchLiveChannels(rebuildTabs).
    - Remote focus moves smoothly pill-to-pill (News -> Kids -> Pakistan, etc.) without dropping to sidebar.
12. **Strict Adult Content Isolation**:
    - Enforced server-side filtering across server.js: adult items strictly excluded from Home carousels, Continue Watching, Watchlist, general search, autocomplete, and general Live TV channels even when unlocked. Only visible inside dedicated 18+ Vault tab.
13. **Streaming Brand Color Themes**:
    - 4 profile-customizable color themes: StreamVault Purple (#8B5CF6), Netflix Red (#E50914), Disney+ Blue (#0063E5), Prime Video Cyan (#00A8E1). Dynamically updates UI accents, badges, buttons, and focus rings.


### K. Major Release v2.7: Industry-Grade Standalone Architecture (Bundled Assets & Cloudflare Universal Auth Sync)
1. **100% Standalone APK (Zero PC Dependency)**:
   - Eliminated the local PC companion requirement for the TV to function. The complete modern TV UI is bundled directly inside the APK assets at pp/src/main/assets/tv-ui.html.
   - MainActivity.kt now boots directly from ile:///android_asset/tv-ui.html with automatic fallback routing if a developer server is unreachable.
   - Smart universal window.fetch interceptor automatically routes cloud authentication, pairing, and multi-device sync calls directly to Cloudflare Edge.
2. **Universal Cloud Account & Authentication Engine (Live on Edge)**:
   - Production Cloudflare Worker deployed live at https://streamvault-sync.streamvault-app.workers.dev.
   - Added standard email & password authentication (/api/auth/signup, /api/auth/login) with salted SHA-256 password hashing via Web Crypto API.
   - Dedicated sync endpoints (/api/sync/push, /api/sync/pull, /api/account/update-credentials) sync watchlist, playback timestamps, ratings, and IPTV credentials across devices.
3. **In-App Cloud Account Modal**:
   - Added interactive Sign In / Sign Up dialog on the TV screen with email and password inputs, complementing the 6-digit TV QR linking (SV-XXXX).
4. **Decoupled Content Basket**:
   - IPTV credentials (adiflix.online:8080) are treated as an interchangeable stream source. All watch history, continue watching, and ratings are permanently anchored to the user's Cloudflare D1 account.
5. **Cross-Device Sync (Android TV & Phone)**:
   - Movies paused on the TV push playback timestamps to Cloudflare D1 and can be resumed at the exact same second on Android phone (or mobile browser at streamvault-app.workers.dev/link).

---

### G. StreamVault TV v2.6.0 Polish & Cloud Auth Hardening (Verified Live on TCL TV)
- **Cloudflare Edge D1 Authentication**: Strict enforcement of password hashing. Unhashed records or blank passwords reject with 401 Unauthorized.
- **Industry Standard 2:3 Cinema Posters**: Uniform `154px` card with `146x219px` image container across all tabs (Home, Movies, Series, More Like This).
- **Zero Edge Clipping**: 2px subtle theme border (`#A78BFA`) + soft ambient glow with `scale(1.05) translateY(-4px)` and `overflow: visible;` on all rails, eliminating left/right/top/bottom clipping.
- **Series Season Pill Clamping**: Compact single-pill season formatting (`S1`, `3 SEASONS`, `SERIES`) with titles clamped cleanly to 2 lines with ellipsis.
- **My List Cleanup**: Excluded "My List" from Home catalog rows to prevent duplicate display (dedicated tab already exists in sidebar).
- **Watch Now / More Like This (MLT)**:
  - Replaced cluttered multi-text cards with a single clean "Show More" card.
  - Added D-pad focus memory (`lastMltFocusedCard`) so navigating Up to filter chips and Down back to the rail preserves exact card position instead of resetting to the start.
- **Zero-Scroll User Profiles & Settings**:
  - Strict 1080p fit with zero vertical and zero horizontal scrolling.
  - Large bedside QR code with generous spacing for effortless scanning from 8-10 feet away.
  - 4 Streaming UI Themes per profile: HBO Purple (`#7C3AED`), Netflix Red (`#E50914`), Disney+ Blue (`#1E40AF`), Prime Cyan (`#0284C7`). Avatars dynamically adopt active theme colors.
  - 4-digit Master PIN security gate before deleting secondary user profiles.
  - Settings screen arranged in 4 equal balanced quadrants (IPTV Provider, Playback Engine, Parental PIN, Maintenance) with 2x2 D-pad spatial flow.
- **Sidebar Spatial Navigation**: Pressing Left from any catalog card or input jumps directly to the active tab in the sidebar rather than defaulting to the user pill.
- **Native Voice Search Modal**: Handles runtime `RECORD_AUDIO` permission on Android 11 with dark modal UI and graceful remote fallback.
- **ExoPlayer Subtitle Contrast**: Subtitles styled with `CaptionStyleCompat` high-contrast drop shadow (`Color.WHITE`, black drop shadow, 22sp) for effortless legibility on resume.

## 5. Live TV Verification on TCL 55P635
- **Latest GitHub Commit**: [`6efd7a1`](https://github.com/waheedkhan10001/streamvault-tv/commit/6efd7a1c7a9aebb0afcce31efcd76062da9d137a) on branch `main` (20 files, +9,799 insertions).
- Built and signed release APK: `C:\Users\wkhan\.gemini\antigravity\scratch\streamvault-tv\StreamVault-TV.apk` (15.27 MB).
- Installed live over Wi-Fi ADB to TCL 55P635 TV at `192.168.100.42:5555`.
- Host PC companion running on `192.168.100.66:8765` over Wi-Fi SSID `EME-CORE-HAI`.
- Live screenshot verification:
   - `tv_settings_quad4_to_sidebar.png`: Verified Settings Left navigation cleanly focuses active Settings gear icon in sidebar.
   - `tv_settings_right_return.png`: Verified Right arrow from sidebar returns smoothly into Settings Quadrant 1 (`Playlist Name`).
   - `tv_settings_quad3_to_4.png`: Verified 2D navigation smoothly crosses from Quadrant 3 (Parental Controls) to Quadrant 4 (Privacy & Maintenance).
   - `tv_settings_verified.png`: Verified symmetrical 2x2 quadrant Settings layout with 4 uniform boxes.
   - `tv_profile_verified.png`: Verified balanced 330px hero cards with 180px bedside QR code and protected profile deletion.
   - `tv_home_scaled.png`: Verified ~195px Netflix-standard Home carousel posters with edge-peek horizontal scroll.
   - `tv_movies_5col.png`: Verified 5-column cinematic grid displaying 10 complete posters ($5 \times 2$) with zero vertical clipping below the filter bar.
  - `tv_search_hist.png`: Verified Search History popup displaying recent searches with TV remote soft keyboard active.
  - `live_welcome_final2.png`: Verified full-screen Welcome Screen on fresh boot with live bedside pairing QR code (`SV-6ZAL`), cloud account sign-in/up modals, and guest bypass.
  - `after_guest_enter.png` & `save_connect_clicked.png`: Verified Settings & System 2x2 quadrant grid fitting completely inside 540 CSS px with zero vertical scroll, ~60px clearance, and all bottom borders 100% visible.
  - `user_profile_opened.png`: Verified User Profiles & Cloud Sync screen fitting inside 540 CSS px with zero scroll, ~80px bottom clearance, and all action buttons visible.
  - `cloud_auth_modal_open.png` & `modal_closed.png`: Verified Cloud Auth modal popup, auto-focus on email, remote D-pad trapping, and instant Back-key dismissal.
  - `home_catalog_rendered.png`: Verified end-to-end IPTV save & connect flow immediately loading, synchronizing with Cloudflare D1, and rendering full catalog on Home.

---

### K. Fresh Install Welcome Screen, Cloudflare D1 Pairing & Onboarding Flow
- **First-Run OOBE Routing (`checkAuthAndRoute`)**:
  - Gated boot routing so fresh downloads immediately show the full-screen cinematic Welcome Screen before attempting `/api/state` or catalog fetches.
  - Generates live bedside TV pairing code (`SV-XXXX`) directly from Cloudflare D1 Worker (`https://streamvault-sync.streamvault-app.workers.dev/api/auth/request-code`).
  - Mobile QR link points to `streamvault-app.workers.dev/link` for 1-tap instant TV sign-in.
  - Native TV options: "Sign In with Email", "Create New Cloud Account", and "Enter IPTV Credentials Directly ->".
- **Intelligent Account Routing**:
  - If a user signs into their cloud account (via phone QR scan or on-screen TV login) and the account already has IPTV credentials, it routes immediately to `HOME`.
  - If the account does not yet have IPTV credentials, it prompts the user with a helpful toast and routes directly to `SETTINGS` with focus set on the Server URL field.
- **Save & Connect Catalog Pipeline (`saveAccountCredentials`)**:
  - Validates required inputs with on-screen error labels without altering card geometry.
  - Synchronizes IPTV credentials to Cloudflare D1 (`POST /api/account/update-credentials`) to persist across all user devices.
  - Posts to companion runner (`POST /api/save-credentials`) to connect the IPTV stream provider, load and categorize the catalog, enrich with TMDB metadata, and smoothly transition into `HOME`.

### L. 540 CSS px Android TV Viewport Calibration (Zero Scroll, No Bottom Border Clipping)
- **Viewport Metrics**: Physical 1080p (1920x1080) at 320 dpi yields an exact CSS viewport of 960x540px (`window.innerHeight = 540`).
- **Settings Screen Grid**:
  - Container padding trimmed to `8px 24px 22px 24px` with `max-height: 100vh; overflow: hidden;`.
  - Card paddings tightened to `10px 14px` and grid gap to `10px`.
  - Total content height reduced to ~410px, leaving >100px breathing space above the bezel.
  - Quadrant 3 ("Parental Controls & PIN") and Quadrant 4 ("Privacy & Maintenance") bottom borders and action buttons are 100% visible with zero vertical scroll.
- **User Profiles Screen Layout**:
  - Rescaled outer container padding to `8px 24px 22px 24px`.
  - Who's Watching header tiles scaled to 42px height.
  - Profile Customization (left) and Cloud TV Link & QR (right) cards scaled to ~340px height with 110px QR image and 22px code badge.
  - Total height reduced to ~390px, leaving ~80px bottom clearance. All cards and borders are 100% visible with zero vertical scroll.
- **Air-Tight D-Pad Trapping**:
  - `navigateSpatial()` updated to recognize `welcomeScreenOverlay` and `cloudAuthModal` containers, preventing focus from escaping to background elements.
  - `fastNavigate()` provides dedicated 1:1 remote navigation across Welcome buttons (`welcomeBtnSignIn`, `welcomeBtnSignUp`, `welcomeBtnGuest`), Cloud Auth form inputs, and Profile card action buttons (`btnOpenCloudSignIn`, `btnReqNewTvCode`, `btnSyncNow`, `btnSaveProfile`).

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
