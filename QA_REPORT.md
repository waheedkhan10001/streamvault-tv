# QA Report — StreamVault TV (Android TV app)

## Scope checked
- Repository structure and key runtime files
- Local functional smoke checks for PC runner (`pc-runner/server.js`, `tv-ui.html`)
- Android build attempt
- GitHub Actions workflow visibility/log access
- Security scan for hardcoded credentials/secrets in code/docs

## Issues found

| # | Problem (simple English) | Where (file/screen) | Severity | Suggested fix | Status |
|---|---|---|---|---|---|
| 1 | Real IPTV server credentials and personal defaults were hardcoded in app/runner UI and backend defaults. This is a security/privacy risk. | `/home/runner/work/streamvault-tv/streamvault-tv/pc-runner/server.js`, `/home/runner/work/streamvault-tv/streamvault-tv/pc-runner/tv-ui.html`, `/home/runner/work/streamvault-tv/streamvault-tv/app/src/main/assets/tv-ui.html` (profile/account screens) | High | Replace with safe generic defaults (`Not configured`, `Not set`, empty credentials). | **Fixed** |
| 2 | Profile modal showed **Connected** by default even when no IPTV is configured, which can mislead users. | `/home/runner/work/streamvault-tv/streamvault-tv/pc-runner/tv-ui.html`, `/home/runner/work/streamvault-tv/streamvault-tv/app/src/main/assets/tv-ui.html` (User Profile modal) | Medium | Compute status dynamically from actual credentials and show `Disconnected` when incomplete. | **Fixed** |
| 3 | PC runner attempted startup sync when only partial credentials existed, causing repeated DNS/network errors in logs. | `/home/runner/work/streamvault-tv/streamvault-tv/pc-runner/server.js` (startup sync condition) | Medium | Require `serverUrl + username + password` before auto-sync starts. | **Fixed** |
| 4 | Sensitive provider details were documented in handoff markdown. | `/home/runner/work/streamvault-tv/streamvault-tv/STREAMVAULT_HANDOFF.md` | High | Redact provider URL and credentials from committed documentation. | **Fixed** |
| 5 | Android build is not reproducible out of the box because there is no Gradle wrapper in repo; in this environment `./gradlew` is missing and plugin resolution failed via system Gradle. | Repository root (build setup) | Medium | Add and commit Gradle wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`) from a trusted environment. | Open (owner decision) |
| 6 | No automated tests are present (`src/test` / `src/androidTest` missing), so regressions are hard to catch automatically. | Entire repository | Medium | Add minimal smoke tests (playlist parsing, credential validation, profile/status UI logic). | Open (owner decision) |
| 7 | Browser console shows form/usability warnings (password inputs not in forms and missing autocomplete hints). | `tv-ui.html` auth/settings dialogs | Low | Wrap password fields in forms where appropriate and add `autocomplete` attributes. | Partially fixed (autocomplete + one PIN form handled; some warning remains) |
| 8 | Very large monolithic files reduce maintainability (harder debugging/refactoring). | `pc-runner/server.js`, `pc-runner/tv-ui.html`, `app/src/main/assets/tv-ui.html`, `app/src/main/java/com/streamvault/tv/MainActivity.kt` | Low | Split by feature modules/components and keep shared logic reusable. | Open (owner decision) |

## Functional check notes
- **PC runner startup + `/tv` page:** OK after fixes (loads successfully).
- **`/api/state` endpoint:** OK.
- **Playlist/network failure handling:** No crash observed; network failures are logged.
- **Android build check:** Failed in this environment due missing wrapper / plugin resolution path.
- **CI visibility:** Workflow runs are visible; live job log download returned 404 while job was still in progress.

## Summary
- **Total issues found:** 8
- **Fixed in this PR:** 4
- **Partially fixed in this PR:** 1
- **Left for owner decision / bigger work:** 3
