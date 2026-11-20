# StreamVault TV: how it works (current as of v2.9.1, Nov 2026)

Give this file to an AI before asking it to change anything. It explains the design, the data, the known traps and the rules we work by. It replaces the older handoff files for "how does it work"; those (STREAMVAULT_HANDOFF.md, HANDOFF_ROUND2.md) are history and out of date (they describe v2.7.0).

## 1. What it is
- An Android TV app (Kotlin) that plays an IPTV provider's Xtream catalogue (about 47,000 titles: ~42.6k movies, ~4.5k series, ~3,000 live channels) with a Netflix-style screen. Target device: TCL TV, Android 11, 2 GB RAM, slow CPU. Everything must be light.
- Owner (Saman) is non-technical. Waheed builds with her. Rule: find root causes, not instance fixes; ask all questions once; one build round at a time.
- Repo: github waheedkhan10001/streamvault-tv. Work branch: `fix-round-2` (merged to `main` on 2026-11-19, v2.9.1). CI: GitHub Actions `build-apk.yml` runs all tests and builds the APK (artifact `StreamVault-TV-Release-APK`). Install on TV: `adb connect <TV-IP>:5555` then `adb install -r app-release.apk` (never uninstall: it would delete the 2 GB content pack).

## 2. The three parts
1. **The TV app** (`app/`): a native shell around a WebView. The whole screen is HTML/JS in `app/src/main/assets/` (tv-ui.html + ui/*.js). The JS talks to a local "server" inside the app, `AppApiRouter`, with `fetch('/api/...')`. No real network server: calls go through a JavaScript bridge into Kotlin (async since round 3, `handleApiRequestAsync`, 2-thread pool; the old synchronous bridge froze the screen).
2. **The content pack** (`.svpack`, ~2 GB): a SQLite file with titles, aliases, TMDB ids, genres, plots, cast, ratings, age ratings, plus poster images. Built by `tools/enrichments-test/pack-build.cjs`, stored in Cloudflare R2, served by the Worker (`/api/pack/latest`, `/api/pack/file`). The TV downloads it once (resumable) and `PackApplier` copies matching details onto the provider's titles ("fill").
3. **The cloud** (`cloud-sync/`): one Cloudflare Worker (`src/worker.js`) + D1 database + R2. Handles accounts (sign-up/login/PIN with email codes via Brevo), saved playlists, profiles, per-profile data push/pull (`/api/sync/push|pull`), catalogue sync batches, pack serving. Deploy: `wrangler deploy` from the `cloud-sync` folder (Saman does this). The app is fully usable without the cloud; the cloud only syncs accounts/profiles/progress.

## 3. Kotlin files (app/src/main/java/com/streamvault/tv/)
- `MainActivity.kt`: starts everything, owns the WebView, key forwarding (remote keys go to JS `handleTvKeyEvent`), player (ExoPlayer), the async API bridge. Heavy startup work must stay off the main thread (the catalogue refresh starts 4 s after the screen).
- `data/AppApiRouter.kt`: every `/api/...` endpoint the UI calls (`/api/home`, `/api/query`, `/api/detail`, `/api/related`, `/api/state`, `/api/profiles*`, `/api/parental-pin`, `/api/sync/status`, `/api/diag`, ...). Also builds the "Report a problem" text.
- `data/StreamVaultDatabase.kt`: SQLite for the user's catalogue (`media_items`, live channels, episodes, watch progress, watchlist, `dedup_alias`, `app_flags`). All list queries, kids filtering, search, More Like This, same-film merging (`foldSameTmdbTitles`).
- `data/CatalogSyncEngine.kt`: imports the provider list (movies, then series, then live, vault, tidy), downloads to a cache file, SHA-256 fingerprint to skip parsing when unchanged, runs the pack fill, cloud pending queue, series episodes on demand.
- `data/PackManager.kt` / `PackApplier.kt`: download, verify, unpack and apply the content pack.
- `data/Models.kt`: data classes and `ContentCertifications` (age-rating rules).
- `data/TitleParser.kt`: cleans provider names ("DE: Title (2019) 4K" to a clean title, year, language, quality) and builds the `dedup_key`.
- `data/PreferencesManager.kt`: settings, credentials, PIN state, vault locks, sync timestamps.
- `data/SubtitleService.kt`, `RelatedScoring.kt`, `DiagStats.kt`, `DiagLog.kt`: subtitles, More Like This scoring, timing/diagnostic counters.

## 4. UI files (app/src/main/assets/)
`tv-ui.html` holds the shell; `ui/00..09-*.js` are loaded in order as one global scope:
- 01 start, sign-in, startup order, Latest; `SIDEBAR_OPEN_DELAY_MS` (a tab opens when focused, after 250 ms)
- 02 navigation, Home rows, filters (`navigateToTab`, `loadHome`, `loadSuperFilter`, `executeFilterQuery`, `navLoadSeq` guards stale tab content)
- 03 Live TV, themes, Settings and Profile screens
- 04 cloud sign-in, PIN modals, Kids toggle, cloud profile sync queue (`ProfileSyncManager`), "Check for new titles"
- 05 profiles, Save Profile, Watch Now/detail screen, More Like This, age badge
- 06 player controls, search, parental controls, Report a problem screen
- 07 focus memory, Back key rules (`handleAppBackKey`), popup keys
- 08 remote-control spatial navigation (`handleTvKeyEvent`, `navigateSpatial`)
- 09 catalogue-status strip. 00 is a vendored QR library; ignore it.

## 5. Concepts you must know
- **Profiles**: each has a name, theme, Kids flag. The saved profile lives in the app database; the screen keeps a copy (`currentActiveProfile`). The Kids switch only sets `window.pendingKids`; nothing changes until Save Profile succeeds (a past bug: screen and database disagreed, giving 3,096 movies, few series and no Live TV).
- **Kids mode** = certification in the all-ages set only (G, TV-Y, TV-G, U, UK U, FSK 0, AU G, CA G, IN U, NL AL). No PG. No Live TV, 18+ or Extras tabs. Applied in every list, search, related, latest and watchlist query.
- **Vaults**: 18+ ("Vault") and Extras are locked by default behind the Master PIN. Turning Kids on locks both and remembers what was open; turning Kids off with the PIN and saving restores them.
- **Same-film merge**: listings with the same TMDB id + same type + same group (normal/Adult/Extras) + years within 1 (or a shared real word when year is missing) become one card with several "versions". `dedup_alias` makes later refreshes land on the merged card. The plain (non "DE:") name wins.
- **Series**: providers often list one season per entry; episodes are fetched on demand from every merged listing and shown as season tabs.
- **Back key rule**: first Back goes to the top row, then the search box, then the sidebar tab. Entering a tab from elsewhere always starts at the top.
- **Cloud push**: the TV's profile ids are its own; the Worker registers an unknown profile before saving its data (the earlier foreign-key 500 error).

## 6. Performance lessons (all learned the hard way)
- SQLite cannot use a partial index (`WHERE tmdb_id>0`) with bound parameters, so lookups did full scans. Use plain indexes.
- Low-selectivity indexes (`idx_media_extra`, adult, cert, enriched) made the planner choose bad plans with temp sorts: they were dropped; `ANALYZE` creates statistics. Index changes must live in `ensureSchemaUpdated` (runs every open), not in `onCreate` (only runs on new databases).
- Never run a full-table `UPDATE ... LIKE` on every start (it caused a 6-7 s blank screen); use a one-time flag in `app_flags`.
- Synchronous `@JavascriptInterface` calls block the WebView; keep the async bridge.
- Imports are low priority and yield to the UI; the pack fill runs only when the user is idle.
- Cloudflare D1 free tier has a daily row-write limit; avoid per-row writes (batch). A past incident: 2026-11-13.

## 7. Report a problem (diagnostics)
Settings > Report a problem shows a paged report: summary (version, title counts, active profile and Kids state, memory, last refresh), slowest request types, Home row timings, details-coverage table (missing genre/rating/plot/age rating per type), recently merged titles, JS freezes/errors, fill progress. It is also written to `Android/data/com.streamvault.tv/files/streamvault-report.txt` (`adb pull`). Saman sends photos of the pages; read them before guessing.

## 8. How we test
- `npm ci && npm test` runs ~30 Playwright/Node UI tests in `tests/` against mock APIs (no TV needed), plus Kotlin Robolectric tests under `app/src/test`. CI runs both. Tests encode behaviour on purpose (Back order, tabs start at top, Kids all-ages); when behaviour is changed deliberately, update the test and say so.
- Nothing is "done" until CI is green AND Saman has tried it on the TV.

## 9. Known open items
Foreground service so the fill survives the app leaving the screen; smarter search with synonyms; the pack builder should create a non-partial tmdb index and use the same all-ages list; poster image size reduction; ~39% of movies have no age rating in the pack (they never appear in Kids mode); Continue Watching is per profile; old branches `wip/*`, `round2-fixes` can be deleted.

## 10. Where the history is
The claude.ai Project "streamvault" holds the per-round notes: `streamvault-fix-round-2026-11-13`, `...-3-2026-11-14`, `...-4-2026-11-15`, `...-4b-2026-11-15`, plus older round and pack docs.
