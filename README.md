# StreamVault TV — Custom Netflix-Grade Android TV App (TCL 55P635)

Built specifically for **TCL 55P635 (Android TV 11, API 30, 2GB RAM)** and local PC testing.

## Key Features
1. **Fixes Missing IPTV Genres & Descriptions**:
   - **Smart Title Cleaner (`TitleParser.kt`)**: Strips messy IPTV prefixes/suffixes (`|EN|`, `[4K-HEVC]`, `[MULTI-SUB]`) into clean searchable Language, Year, Quality, and Subtitle tags.
   - **Smart Deduplication**: Groups duplicate uploads of the same movie (`4K`, `1080p`, `English`, `Hindi`, `Dual-Audio`) into **one Netflix card** with a **Stream Version Picker** inside the detail screen.
   - **100% Background TMDB Enrichment (`CatalogSyncEngine.kt`)**: Enriches all movies and series with true **Multi-Genres**, **Plot Descriptions**, **Cast/Actors**, **Director**, **IMDb/TMDB Rating**, and **Runtime** in smart priority order—with zero risk of your IPTV provider blocking your account.
   - **Incremental Delta Sync + 1-Connection Playback Lock**: Pauses all background IPTV checks whenever a video is playing, and checks for newly added movies/episodes without re-downloading existing data.
2. **4-Way Fast Search & Multi-Attribute Super-Filter**:
   - **🎤 Voice Search**: Speak movie titles, actors, directors, or genres into your TV remote.
   - **📱 Phone Keyboard "Beam to TV" (`PhoneCompanionServer.kt`)**: Scan the QR code on your TV to type on your phone's keyboard and see results live on your TV screen.
   - **⚡ 2-Letter Instant Autocomplete Chips + Compact 6x6 TV Grid Keyboard**: Type just 2 letters to see 1-click completion chips for Movies, Actors, and Directors.
   - **🎯 Include (`+`) & Exclude (`-`) Genre Matrix**: Filter by included genres (`AND`/`OR`), excluded genres (`NOT`), Language, Subtitle availability, Decade/Year, Rating, Quality, and **Hide Already Watched**.
   - **📌 Pinned Smart Filter Rows**: Pin any custom filter combination as a permanent horizontal row on your Home screen.
3. **Anti-Freeze ExoPlayer + Online Multi-Language Subtitle Downloader**:
   - **Built-in Online Subtitle Downloader (`SubtitleService.kt`)**: Fetches synced `.srt` subtitles in English, Urdu, Hindi, Arabic, and 50+ languages on the fly via Wyzie / OpenSubtitles—even when the IPTV stream has zero embedded subtitles—plus live **`+/-` Subtitle Timing Offset** (`-0.5s` / `+0.5s`).
   - **Smart IPTV Buffer & Auto-Reconnect**: 30s RAM buffer + automatic 3x reconnect from the exact timestamp on temporary IPTV stream drops.

---

## Quick Start

### 1. Test Locally on Your Windows PC First
Double-click **[`Run-On-PC.bat`](./Run-On-PC.bat)** to launch the 16:9 TV Simulator on your PC screen (use your keyboard's **Arrow Keys**, **Enter**, and **Esc** just like your TCL remote, or click with your mouse).

### 2. Beam Over Wi-Fi to Your TCL 55P635 (No USB Stick Required)
1. On your TCL 55P635 TV, enable **Developer Options -> Network Debugging** (`Settings -> Device Preferences -> About -> click Build 7 times`).
2. Double-click **[`Push-To-TCL-TV.bat`](./Push-To-TCL-TV.bat)**, enter your TV's Wi-Fi IP address, and it will install and launch **`StreamVault-TV.apk`** directly on your TV screen over Wi-Fi.
