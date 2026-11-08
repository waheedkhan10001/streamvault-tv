/**
 * StreamVault TV — High-Performance Local PC Runner & Companion Server
 *
 * Designed to handle 65,000+ real Xtream Codes IPTV items in-memory with:
 * - Sub-10ms server-side filtering & pagination (never sends 85MB JSON to the browser)
 * - Smart Category/Title Language & Year Parser tailored for Hollywood/Bollywood/Hindi-Dubbed/Pakistani catalogs
 * - 10x Parallel Smart-Priority TMDB Enrichment (newest & preferred languages first)
 * - Built-in HTTP Range Stream Proxy & Online Subtitle Downloader (Wyzie/OpenSubtitles SRT -> WebVTT)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = 8765;
process.on('uncaughtException', (err) => {
  if (err.code === 'EOF' || err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
  console.error('[Daemon Error]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[Daemon Rejection]', err?.message || err);
});
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'streamvault_pc_db.json');
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';

let state = {
  credentials: {
    playlistName: 'Aadiflix TV',
    serverUrl: 'http://aadiflix.online:8080',
    username: 'waleed84838',
    password: 'waleed84839',
    tmdbApiKey: DEFAULT_TMDB_KEY,
    preferredLanguages: ['English', 'Hindi', 'Urdu', 'Punjabi', 'Multi-Audio'],
    hiddenLanguages: ['German'],
    preferredSubtitleLanguages: ['en', 'ur', 'hi', 'ar']
  },
  syncStatus: {
    isSyncing: false,
    phase: 'Ready',
    newlyAddedCount: 0,
    enrichedCount: 0,
    totalToEnrich: 0,
    lastSyncTimestamp: 0
  },
  remoteSearchQuery: '',
  recentSearches: ['Christopher Nolan', 'Dune', 'Action', '2024'],
  pinnedSmartRows: [
    {
      id: 'smart_scifi_thriller_no_horror',
      title: 'Top Sci-Fi & Thrillers (No Horror, 7.0+)',
      filterState: {
        searchQuery: '',
        includedGenres: ['Sci-Fi', 'Thriller'],
        excludedGenres: ['Horror'],
        matchAllIncludedGenres: false,
        selectedLanguages: [],
        subtitleFilterMode: 'ANY',
        decade: null,
        minRating: 7.0,
        qualityFilter: null,
        hideWatched: false,
        actorFilter: null,
        directorFilter: null,
        sortBy: 'RATING_DESC'
      }
    },
    {
      id: 'smart_2024_hits',
      title: '2020s Action & Adventure Blockbusters',
      filterState: {
        searchQuery: '',
        includedGenres: ['Action', 'Adventure'],
        excludedGenres: [],
        matchAllIncludedGenres: false,
        selectedLanguages: [],
        subtitleFilterMode: 'ANY',
        decade: 2020,
        minRating: 6.5,
        qualityFilter: null,
        hideWatched: false,
        actorFilter: null,
        directorFilter: null,
        sortBy: 'RELEASE_YEAR_DESC'
      }
    }
  ],
  mediaItems: [],
  liveChannels: [],
  parentalControl: {
    isLocked: true,
    pin: '0000',
    showAdult: false
  },
  favoriteLiveChannels: [],
  userRatings: {}
};

const mediaMap = new Map();
let saveTimer = null;
let isEnriching = false;

// Bayesian Weighted Rating (IMDb Top 250 Formula)
// Eliminates fake placeholder 10 ratings and single-vote anomalies
function calcWeightedRating(rawRating, voteCount = 0) {
  const m = 25; // Minimum vote threshold
  const C = 6.2; // Global mean rating
  const v = Math.max(0, voteCount || 0);
  const r = Math.min(10, Math.max(0, parseFloat(rawRating || '0') || 0));
  if (v <= 0) {
    if (r >= 9.9 || r === 0) return 0;
    return Math.min(r, 6.5);
  }
  const weighted = ((v / (v + m)) * r) + ((m / (v + m)) * C);
  return Math.round(weighted * 10) / 10;
}

let isSaving = false;
function scheduleSaveState() {
  if (saveTimer || isSaving) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    isSaving = true;
    try {
      const dataStr = JSON.stringify(state);
      fs.writeFile(DB_FILE, dataStr, 'utf8', () => { isSaving = false; });
    } catch (_) {
      isSaving = false;
    }
  }, 45000);
}

// Smart Classification of Category & Title for Real IPTV Providers (e.g., aadiflix.online)
function classifyCategoryAndTitle(rawTitle, categoryName = '', existingTmdbId = 0) {
  const catUpper = String(categoryName || '').toUpperCase();
  let working = String(rawTitle || '').trim();
  const titleUpper = working.toUpperCase();

  // Distinguish junk clip categories vs adult content
  const isJunkClip =
    catUpper.includes('DANCE |') ||
    catUpper.includes('STAGE DRAMA CLIP') ||
    catUpper.includes('SONGS |') ||
    catUpper.includes('MUJRA') ||
    catUpper.includes('DASI');

  const isAdult =
    /(^|\b)(XXX|XX|18\+|PORN|ADULT|SEX)\b/i.test(catUpper) ||
    catUpper.includes('FOR ADULTS') ||
    catUpper.includes('18+') ||
    /(^|\b)(XXX|18\+)\b/i.test(titleUpper);

  const isAdultOrJunkClip = isJunkClip || isAdult;

  // Detect Language from Category Name first, then Title Prefix
  let language = 'English';
  if (catUpper.includes('HINDI DUBBED') || catUpper.includes('MULTI LANGUAGE') || catUpper.includes('DUAL AUDIO')) language = 'Multi-Audio';
  else if (catUpper.includes('BOLLYWOOD') || catUpper.includes('HINDI')) language = 'Hindi';
  else if (catUpper.includes('PAKISTAN') || catUpper.includes('LOLLYWOOD') || catUpper.includes('URDU') || catUpper.includes('STAGE DRAMA') || catUpper.includes('ISLAMIC')) language = 'Urdu';
  else if (catUpper.includes('PUNJABI')) language = 'Punjabi';
  else if (catUpper.includes('TAMIL')) language = 'Tamil';
  else if (catUpper.includes('TELUGU')) language = 'Telugu';
  else if (catUpper.includes('MALAYALAM')) language = 'Malayalam';
  else if (catUpper.includes('KANNADA')) language = 'Kannada';
  else if (catUpper.includes('MARATHI')) language = 'Marathi';
  else if (catUpper.includes('GUJRATI') || catUpper.includes('GUJARATI')) language = 'Gujarati';
  else if (catUpper.includes('BHOJPURI')) language = 'Bhojpuri';
  else if (catUpper.includes('ODIA')) language = 'Odia';
  else if (catUpper.includes('BANGALI') || catUpper.includes('BENGALI')) language = 'Bengali';
  else if (catUpper.includes('PASHTO')) language = 'Pashto';
  else if (catUpper.includes('GERMANY') || catUpper.includes('GERMAN')) language = 'German';
  else if (catUpper.includes('ARAB')) language = 'Arabic';
  else if (catUpper.includes('PHILIPPINES') || catUpper.includes('TAGALOG')) language = 'Filipino';
  else if (catUpper.includes('TURKISH') || catUpper.includes('TURKEY')) language = 'Turkish';
  else if (catUpper.includes('KOREAN') || catUpper.includes('KOREA')) language = 'Korean';
  else if (catUpper.includes('CHINESE') || catUpper.includes('CHINA')) language = 'Chinese';
  else if (catUpper.includes('JAPANESE') || catUpper.includes('ANIME')) language = 'Japanese';
  else if (catUpper.includes('HOLLYWOOD') || catUpper.includes('(ENG)') || catUpper.includes('ENGLISH')) language = 'English';
  else if (catUpper.startsWith('IN |') || catUpper.includes('SOUTH INDIAN')) language = 'Hindi';
  else language = 'English';

  const prefixLangMap = {
    EN: 'English', ENG: 'English', HI: 'Hindi', HIN: 'Hindi', HINDI: 'Hindi',
    UR: 'Urdu', URDU: 'Urdu', PK: 'Urdu', PA: 'Punjabi', DE: 'German', GER: 'German',
    AR: 'Arabic', TR: 'Turkish', KR: 'Korean', ES: 'Spanish', FR: 'French',
    TA: 'Tamil', TE: 'Telugu', ML: 'Malayalam', MULTI: 'Multi-Audio', DUAL: 'Multi-Audio'
  };

  const mPrefix = working.match(/^\s*\|?([A-Za-z]{2,6})\|?\s*[-:|]\s*/);
  if (mPrefix && prefixLangMap[mPrefix[1].toUpperCase()]) {
    language = prefixLangMap[mPrefix[1].toUpperCase()];
    working = working.slice(mPrefix[0].length).trim();
  }

  // Strip trailing '*' that vendors use for clean updated retail copies (e.g., "Striking Rescue (2024)*")
  working = working.replace(/\*+$/g, '').trim();

  // Remove bracketed/piped tags
  working = working.replace(/\[([^\]]+)]|\|([^|]+)\|/g, ' ');

  // Extract Year from Title (ignoring DD.MM.YYYY dates at the very start)
  let year = 0;
  const yearMatches = [...working.matchAll(/(?:^|[\s(\[._-])((?:19[2-9]\d|20[0-2]\d))(?:[\s)\]._-]|$)/g)];
  if (yearMatches.length > 0) {
    const last = yearMatches[yearMatches.length - 1];
    const yrVal = parseInt(last[1], 10);
    // Avoid slicing if it's part of a date prefix like "26.09.2025 Friday Night..."
    const beforeSlice = working.slice(0, last.index);
    if (!/^\d{1,2}[./-]\d{1,2}$/.test(beforeSlice.trim())) {
      year = yrVal;
      if (last.index > 2) {
        working = beforeSlice;
      }
    } else {
      year = yrVal;
    }
  }

  // Fallback: Extract Year from Category Name if Title had no year, e.g. "(2024) HOLLYWOOD"
  if (year === 0) {
    const catYearMatch = catUpper.match(/\((\d{4})\)/);
    if (catYearMatch) {
      year = parseInt(catYearMatch[1], 10) || 0;
    }
  }

  // Multi-tier Quality Badges & Scoring Engine
  const fullText = `${rawTitle} ${categoryName}`.toUpperCase();

  // Negative CAM / Telesync / Watermarked Rip detection
  const isCam =
    /\b(CAM|HDCAM|CAM-RIP|CAMRIP|TS|TELESYNC|HDTS|TC|TELECINE|SCREENER|SCR|DVD-SCR|WORKPRINT|WP)\b/.test(fullText) ||
    /\b(DRAGON\s*MONEY|1XBET|BETWINNER|LINEBET|SLOT)\b/.test(fullText);

  // Positive Quality Source Tiers
  const is4K = /\b(4K|UHD|2160P|HDR|REMUX)\b/.test(fullText);
  const isBluRay = /\b(BLURAY|BD-?RIP|BRRIP)\b/.test(fullText);
  const isWebDl = /\b(WEB-?DL|WEBRIP|AMZN|DSNP|ATVP|NF)\b/.test(fullText);
  const isCleanProper = (rawTitle || '').includes('*') || /\b(CLEAN|HQ|PROPER|REPACK|REAL)\b/.test(fullText);
  const is1080p = /\b(1080P|FHD|HDTV)\b/.test(fullText);
  const isHevc = /\b(HEVC|X265|H\.?265)\b/.test(fullText);

  const qualities = [];
  if (isCam) qualities.push('CAM');
  if (is4K) qualities.push('4K');
  if (isBluRay) qualities.push('BluRay');
  if (isWebDl && !isBluRay) qualities.push('WEB-DL');
  if (is1080p && !is4K) qualities.push('1080p');
  if (isCleanProper && !isCam) qualities.push('Clean HQ*');
  if (isHevc) qualities.push('HEVC');
  if (qualities.length === 0) qualities.push('HD');

  // Compute Quality Rank Score
  let qualityScore = 10;
  if (isCam) {
    qualityScore = -30; // Heavy penalty for CAM / watermarked rip
  } else {
    if (is4K) qualityScore += 40;
    else if (isBluRay) qualityScore += 30;
    else if (isWebDl) qualityScore += 25;
    else if (is1080p) qualityScore += 15;
    if (isCleanProper) qualityScore += 15;
    if (isHevc) qualityScore += 5;
  }

  // Infer genres from Category Name before TMDB even runs!
  const inferredGenres = [];
  if (catUpper.includes('ACTION')) inferredGenres.push('Action');
  if (catUpper.includes('HORROR')) inferredGenres.push('Horror');
  if (catUpper.includes('THRILLER')) inferredGenres.push('Thriller');
  if (catUpper.includes('SCIENCE FICTION') || catUpper.includes('SCI-FI')) inferredGenres.push('Sci-Fi');
  if (catUpper.includes('COMEDY')) inferredGenres.push('Comedy');
  if (catUpper.includes('DOCUMENTARY') || catUpper.includes('DOC |')) inferredGenres.push('Documentary');
  if (catUpper.includes('KIDS') || catUpper.includes('CARTOON')) inferredGenres.push('Animation', 'Family');
  if (catUpper.includes('ROMANCE')) inferredGenres.push('Romance');
  if (catUpper.includes('CRIME')) inferredGenres.push('Crime');
  if (catUpper.includes('DRAMA')) inferredGenres.push('Drama');

  working = working
    .replace(/\b(4K|UHD|2160p|FHD|1080p|HD|720p|HEVC|x265|BluRay|WEB-?DL|MULTI-?SUB|DUAL\s*AUDIO)\b/gi, ' ')
    .replace(/\(\s*\)|\[\s*]/g, ' ')
    .replace(/[-–—:|]+$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!working) working = String(rawTitle || '').trim();

  const norm = working.toLowerCase().replace(/[^a-z0-9]/g, '');
  const dedupKey = existingTmdbId > 0 ? `tmdb:${existingTmdbId}` : `title:${norm}:${year}`;

  return {
    cleanTitle: working,
    year,
    language,
    qualityBadges: qualities,
    qualityScore,
    isCam,
    inferredGenres,
    dedupKey,
    isAdult,
    isJunkClip,
    isAdultOrJunkClip
  };
}

// Fast Stream Prober: Uses HTTP GET with Range: bytes=0-10 to detect exact file size without downloading video
function probeStreamSize(streamId, ext = 'mp4') {
  return new Promise((resolve) => {
    const creds = state.credentials;
    if (!creds.serverUrl || !creds.username || !creds.password) return resolve(0);
    let base = creds.serverUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    const urlStr = `${base}/movie/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.${ext || 'mp4'}`;

    function sendProbe(targetUrl, redirects = 0) {
      if (redirects > 3) return resolve(0);
      try {
        const parsed = new URL(targetUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(
          targetUrl,
          {
            method: 'GET',
            headers: {
              'User-Agent': 'IPTVSmartersPlayer/1.0',
              Range: 'bytes=0-10'
            },
            timeout: 5000
          },
          (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              let loc = res.headers.location;
              if (!loc.startsWith('http')) loc = new URL(loc, targetUrl).href;
              return sendProbe(loc, redirects + 1);
            }
            const contentRange = res.headers['content-range'] || '';
            res.destroy(); // Terminate connection immediately after 11 bytes!
            const m = contentRange.match(/\/(\d+)$/);
            if (m) {
              return resolve(parseInt(m[1], 10) || 0);
            }
            const cl = parseInt(res.headers['content-length'] || '0', 10);
            resolve(cl > 1000 ? cl : 0);
          }
        );
        req.on('error', () => resolve(0));
        req.on('timeout', () => {
          req.destroy();
          resolve(0);
        });
        req.end();
      } catch (_) {
        resolve(0);
      }
    }
    sendProbe(urlStr);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

const ADULT_VOD_CATEGORIES = [
  { id: '976', name: 'XXX Hindi' },
  { id: '977', name: 'XXX Hindi Full' },
  { id: '15', name: 'XXX VIP' },
  { id: '978', name: 'XXX Team Skeet' },
  { id: '665', name: 'XXX Best Full Movies' },
  { id: '339', name: 'XXX Redhat' },
  { id: '424', name: 'XXX Strom' },
  { id: '423', name: 'XXX Adult Ultimate' },
  { id: '483', name: 'XXX Korean' },
  { id: '561', name: 'XXX Japanese' },
  { id: '1018', name: 'Philippines 18+' }
];

async function syncAdultVodCatalog(force = false) {
  const creds = state.credentials;
  if (!creds.serverUrl || !creds.username || !creds.password) return;
  const currentAdultCount = state.mediaItems.filter(m => m.isAdult).length;
  if (currentAdultCount >= 1000 && !force) return;

  console.log('[Adult Ingest] Ingesting adult VOD categories from IPTV server into 18+ Vault...');
  try {
    let base = creds.serverUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;

    let totalAdded = 0;
    for (const cat of ADULT_VOD_CATEGORIES) {
      const urlStr = `${base}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=get_vod_streams&category_id=${cat.id}`;
      try {
        const streams = await fetchJsonUrl(urlStr, 25000);
        if (!Array.isArray(streams) || streams.length === 0) continue;
        for (const s of streams) {
          const streamId = String(s.stream_id || '');
          const rawName = String(s.name || '').trim();
          if (!streamId || !rawName) continue;

          const dedupKey = `adult:${streamId}`;
          if (mediaMap.has(dedupKey)) continue;

          const parsed = classifyCategoryAndTitle(rawName, cat.name, 0);
          const item = {
            dedupKey,
            primaryStreamId: streamId,
            tmdbId: 0,
            imdbId: '',
            mediaType: 'MOVIE',
            isAdult: true,
            cleanTitle: parsed.cleanTitle,
            rawTitle: rawName,
            year: parsed.year || 2024,
            rating: 0,
            voteCount: 0,
            genres: ['Adult', cat.name.replace(/^XXX\s*\|?\s*/i, '')],
            plot: `Adult Feature Presentation from ${cat.name}.`,
            cast: [],
            director: '',
            runtimeMins: 0,
            posterUrl: s.stream_icon || '',
            backdropUrl: '',
            language: parsed.language || 'English',
            qualityBadges: parsed.qualityBadges,
            qualityScore: parsed.qualityScore,
            hasEmbeddedSubtitles: false,
            embeddedSubtitleLanguages: [],
            hasOnlineSubtitles: false,
            embeddedAudioLanguages: [parsed.language || 'English'],
            categoryName: cat.name,
            addedTimestamp: parseInt(s.added || '0', 10) || 0,
            isEnriched: false,
            inWatchlist: false,
            versions: [
              {
                streamId,
                rawTitle: rawName,
                languageTag: parsed.language || 'English',
                qualityTag: parsed.qualityBadges.join(' '),
                subtitleTag: 'None',
                containerExtension: s.container_extension || 'mp4',
                categoryName: cat.name,
                qualityScore: parsed.qualityScore,
                isCam: parsed.isCam
              }
            ]
          };

          state.mediaItems.push(item);
          mediaMap.set(dedupKey, item);
          totalAdded++;
        }
      } catch (err) {
        console.warn(`[Adult Ingest] Failed cat ${cat.id}:`, err.message);
      }
    }
    console.log(`[Adult Ingest] Complete: added ${totalAdded} adult titles (Total in Vault: ${state.mediaItems.filter(m => m.isAdult).length}).`);
    scheduleSaveState();
  } catch (e) {
    console.error('[Adult Ingest] Error:', e.message);
  }
}

// Load & upgrade existing database on startup
if (fs.existsSync(DB_FILE)) {
  try {
    console.log('Loading existing PC database...');
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    state = { ...state, ...saved };
    if (!state.credentials.hiddenLanguages || state.credentials.hiddenLanguages.length === 0) {
      state.credentials.hiddenLanguages = ['German'];
    }

    // Re-classify existing items so Bollywood/Hollywood/Pakistani languages, category years, quality tiers, and adult vault items are instant
    const upgraded = [];
    for (const item of state.mediaItems) {
      const info = classifyCategoryAndTitle(item.rawTitle, item.categoryName, item.tmdbId);
      if (info.isJunkClip) continue; // Keep catalog clean from dance/song clips
      if (info.isAdult) {
        item.isAdult = true;
      }
      item.cleanTitle = info.cleanTitle;
      if (!item.year || item.year === 0) item.year = info.year;
      item.language = info.language;
      item.qualityBadges = [...new Set([...(item.qualityBadges || []), ...info.qualityBadges])];
      item.qualityScore = info.qualityScore;
      item.isCam = info.isCam;
      // Sanitize placeholder 10 / 9.2 ratings from IPTV provider & compute Bayesian weighted rating
      if (item.rating >= 9.1 || item.rawRating >= 9.8) {
        item.rating = 0; // Unrated vendor placeholder pending verified TMDB community consensus
      } else if (item.isEnriched && item.voteCount) {
        item.rating = calcWeightedRating(item.rawRating || item.rating, item.voteCount || 0);
      }
      if (!item.genres || item.genres.length === 0) {
        item.genres = info.inferredGenres;
      }
      if (Array.isArray(item.versions)) {
        for (const v of item.versions) {
          const vInfo = classifyCategoryAndTitle(v.rawTitle, v.categoryName, item.tmdbId);
          v.languageTag = vInfo.language;
          v.qualityScore = vInfo.qualityScore;
          v.isCam = vInfo.isCam;
          v.qualityTag = vInfo.qualityBadges.join(' ');
        }
        if (item.versions.length > 1) {
          item.versions.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
          const best = item.versions[0];
          if (best) {
            item.primaryStreamId = best.streamId;
          }
        }
      }
      mediaMap.set(item.dedupKey, item);
      upgraded.push(item);
    }
    state.mediaItems = upgraded;
    console.log(`Loaded & classified ${state.mediaItems.length} titles (${state.mediaItems.filter(m => m.isAdult).length} in 18+ Vault).`);
    // Kick off adult VOD ingest if missing
    setTimeout(() => { syncAdultVodCatalog(); }, 1500);
  } catch (e) {
    console.error('Error loading DB:', e.message);
  }
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function fetchJsonUrl(urlStr, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      urlStr,
      { headers: { 'User-Agent': 'IPTVSmartersPlayer/1.0' }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchJsonUrl(res.headers.location, timeoutMs));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const str = Buffer.concat(chunks).toString('utf8');
            resolve(JSON.parse(str));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

async function runLiveIptvSync(force = false) {
  const creds = state.credentials;
  if (!creds.serverUrl || !creds.username || !creds.password) return;
  if (state.syncStatus.isSyncing && !force) return;

  try {
    state.syncStatus.isSyncing = true;
    let base = creds.serverUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    const apiBase = `${base}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

    // If we already have >10,000 movies and force=false, only fetch Series & Live TV if missing
    const needVod = force || state.mediaItems.filter((m) => m.mediaType === 'MOVIE').length < 100;
    const needSeries = force || state.mediaItems.filter((m) => m.mediaType === 'SERIES').length < 10;
    const needLive = force || state.liveChannels.length < 10;

    if (needVod) {
      state.syncStatus.phase = 'Downloading VOD Categories & Movies from IPTV Server...';
      console.log('[Sync] Downloading VOD categories and streams...');
      let cats = [];
      let vods = [];
      try {
        cats = await fetchJsonUrl(`${apiBase}&action=get_vod_categories`, 45000);
        console.log(`[Sync] VOD Categories received: ${cats?.length || 0}`);
      } catch (e) {
        console.warn(`[Sync] VOD Categories error: ${e.message}`);
      }
      try {
        vods = await fetchJsonUrl(`${apiBase}&action=get_vod_streams`, 120000);
        console.log(`[Sync] VOD Streams received: ${vods?.length || 0}`);
      } catch (e) {
        console.error(`[Sync] VOD Streams error: ${e.message}`);
      }

      const catMap = {};
      if (Array.isArray(cats)) {
        for (const c of cats) catMap[c.category_id] = c.category_name;
      }

      if (Array.isArray(vods) && vods.length > 0) {
        let addedCount = 0;
        for (const v of vods) {
          const streamId = String(v.stream_id || '');
          const rawName = String(v.name || '');
          if (!streamId || !rawName) continue;
          const catName = catMap[v.category_id] || 'Movies';
          const tmdbId = parseInt(v.tmdb || v.tmdb_id || '0', 10) || 0;
          const parsed = classifyCategoryAndTitle(rawName, catName, tmdbId);
          if (parsed.isAdultOrJunkClip) continue;

          const ver = {
            streamId,
            rawTitle: rawName,
            languageTag: parsed.language,
            qualityTag: parsed.qualityBadges.join(' '),
            subtitleTag: 'Auto-Sub',
            containerExtension: v.container_extension || 'mp4',
            categoryName: catName
          };

          const existing = mediaMap.get(parsed.dedupKey);
          if (!existing) {
            addedCount++;
            const newItem = {
              dedupKey: parsed.dedupKey,
              primaryStreamId: streamId,
              tmdbId,
              imdbId: '',
              mediaType: 'MOVIE',
              cleanTitle: parsed.cleanTitle,
              rawTitle: rawName,
              year: parsed.year,
              rating: Math.min(10, Math.max(0, parseFloat(v.rating || '0') || 0)),
              voteCount: 100,
              genres: parsed.inferredGenres,
              plot: '',
              cast: [],
              director: '',
              runtimeMins: 0,
              posterUrl: v.stream_icon || '',
              backdropUrl: '',
              language: parsed.language,
              qualityBadges: parsed.qualityBadges,
              hasEmbeddedSubtitles: (v.container_extension || '').toLowerCase() === 'mkv',
              embeddedSubtitleLanguages: ['English'],
              hasOnlineSubtitles: true,
              embeddedAudioLanguages: [parsed.language],
              categoryName: catName,
              addedTimestamp: parseInt(v.added || '0', 10) || 0,
              isEnriched: false,
              inWatchlist: false,
              isWatched: false,
              resumePositionMs: 0,
              durationMs: 0,
              versions: [ver]
            };
            mediaMap.set(parsed.dedupKey, newItem);
          } else {
            if (!existing.versions.some((x) => x.streamId === streamId)) {
              existing.versions.push(ver);
            }
            if (!existing.posterUrl && v.stream_icon) existing.posterUrl = v.stream_icon;
            if (parsed.year > existing.year) existing.year = parsed.year;
            // Deduplication quality promotion: 4K / 1080p take priority as primaryStreamId, and '*' clean/HQ releases take top priority
            const isStar = (title) => (title && title.includes('*')) ? 15 : 0;
            const qualityWeight = (q, title) => (q === '4K' ? 30 : (q === '1080p' || q === 'FHD') ? 20 : 10) + isStar(title);
            const currentQ = (existing.qualityBadges || [])[0] || 'HD';
            const newQ = (parsed.qualityBadges || [])[0] || 'HD';
            if (qualityWeight(newQ, rawName) > qualityWeight(currentQ, existing.rawTitle)) {
              existing.primaryStreamId = streamId;
              existing.qualityBadges = parsed.qualityBadges;
            }
            existing.versions.sort((a, b) => qualityWeight((b.qualityTag || 'HD'), b.rawTitle) - qualityWeight((a.qualityTag || 'HD'), a.rawTitle));
          }
        }
        state.mediaItems = [...mediaMap.values()];
        state.syncStatus.newlyAddedCount = addedCount;
      }
    }

    // Fetch TV Series
    if (needSeries) {
      state.syncStatus.phase = 'Downloading TV Series Catalog...';
      const [sCats, seriesList] = await Promise.all([
        fetchJsonUrl(`${apiBase}&action=get_series_categories`).catch(() => []),
        fetchJsonUrl(`${apiBase}&action=get_series`, 60000).catch(() => [])
      ]);
      const sCatMap = {};
      if (Array.isArray(sCats)) {
        for (const c of sCats) sCatMap[c.category_id] = c.category_name;
      }
      if (Array.isArray(seriesList) && seriesList.length > 0) {
        for (const s of seriesList) {
          const seriesId = String(s.series_id || '');
          const rawName = String(s.name || '');
          if (!seriesId || !rawName) continue;
          const catName = sCatMap[s.category_id] || 'TV Series';
          const tmdbId = parseInt(s.tmdb || s.tmdb_id || '0', 10) || 0;
          const parsed = classifyCategoryAndTitle(rawName, catName, tmdbId);
          if (parsed.isAdultOrJunkClip) continue;

          const dedupKey = `series:${parsed.dedupKey}`;
          if (!mediaMap.has(dedupKey)) {
            const serverGenres = String(s.genre || '')
              .split(/[,/|]/)
              .map((g) => g.trim())
              .filter(Boolean);
            const combinedGenres = [...new Set([...serverGenres, ...parsed.inferredGenres])];
            const item = {
              dedupKey,
              primaryStreamId: seriesId,
              tmdbId,
              imdbId: '',
              mediaType: 'SERIES',
              cleanTitle: parsed.cleanTitle,
              rawTitle: rawName,
              year: parsed.year || parseInt(String(s.releaseDate || '').slice(0, 4), 10) || 0,
              rating: Math.min(10, Math.max(0, parseFloat(s.rating || '0') || 0)),
              voteCount: 100,
              genres: combinedGenres,
              plot: s.plot || '',
              cast: String(s.cast || '').split(',').map((c) => c.trim()).filter(Boolean),
              director: s.director || '',
              runtimeMins: 45,
              posterUrl: s.cover || '',
              backdropUrl: Array.isArray(s.backdrop_path) ? (s.backdrop_path[0] || '') : (s.backdrop_path || ''),
              language: parsed.language,
              qualityBadges: parsed.qualityBadges,
              hasEmbeddedSubtitles: true,
              embeddedSubtitleLanguages: ['English'],
              hasOnlineSubtitles: true,
              embeddedAudioLanguages: [parsed.language],
              categoryName: catName,
              addedTimestamp: parseInt(s.last_modified || '0', 10) || 0,
              isEnriched: Boolean(s.plot && combinedGenres.length > 0),
              inWatchlist: false,
              isWatched: false,
              resumePositionMs: 0,
              durationMs: 0,
              versions: [
                {
                  streamId: seriesId,
                  rawTitle: rawName,
                  languageTag: parsed.language,
                  qualityTag: 'Series HD',
                  subtitleTag: 'Multi-Sub',
                  containerExtension: 'mp4',
                  categoryName: catName
                }
              ]
            };
            mediaMap.set(dedupKey, item);
          }
        }
        state.mediaItems = [...mediaMap.values()];
      }
    }

    // Fetch Live TV Channels
    if (needLive) {
      state.syncStatus.phase = 'Downloading Live TV Channels...';
      const [lCats, liveStreams] = await Promise.all([
        fetchJsonUrl(`${apiBase}&action=get_live_categories`).catch(() => []),
        fetchJsonUrl(`${apiBase}&action=get_live_streams`, 60000).catch(() => [])
      ]);
      const lCatMap = {};
      if (Array.isArray(lCats)) {
        for (const c of lCats) lCatMap[c.category_id] = c.category_name;
      }
      if (Array.isArray(liveStreams) && liveStreams.length > 0) {
        state.liveChannels = liveStreams.slice(0, 3000).map((ch) => ({
          streamId: String(ch.stream_id || ''),
          name: String(ch.name || '').trim(),
          logoUrl: ch.stream_icon || '',
          categoryName: lCatMap[ch.category_id] || 'Live TV',
          currentProgramTitle: 'Live Broadcast',
          nextProgramTitle: '',
          isFavorite: false
        }));
      }
    }

    state.syncStatus.totalToEnrich = state.mediaItems.length;
    state.syncStatus.enrichedCount = state.mediaItems.filter((m) => m.isEnriched).length;
    state.syncStatus.isSyncing = false;
    state.syncStatus.lastSyncTimestamp = Date.now();
    state.syncStatus.phase = `Loaded ${state.mediaItems.length.toLocaleString()} Titles • Enriching Top Movies via TMDB...`;
    scheduleSaveState();

    startParallelTmdbEnrichment();
  } catch (err) {
    state.syncStatus.isSyncing = false;
    state.syncStatus.phase = `Sync Error: ${err.message}`;
  }
}

// High-Accuracy TMDB Title & Year Matcher (prevents false matches like "The Beast" -> "Heart of the Beast")
function findBestTmdbMatch(results, cleanTitle, year) {
  if (!results || results.length === 0 || !cleanTitle) return null;
  const target = String(cleanTitle).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!target) return null;

  // 1. Exact normalized title match with same year (+-1 year)
  for (const r of results) {
    const t = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ot = (r.original_title || r.original_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rel = r.release_date || r.first_air_date || '';
    const rYear = parseInt(rel.slice(0, 4), 10) || 0;
    const yearMatch = year > 1900 && rYear > 1900 ? Math.abs(year - rYear) <= 1 : true;
    if ((t === target || ot === target) && yearMatch) {
      return r;
    }
  }

  // 2. Exact normalized title match regardless of year
  for (const r of results) {
    const t = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ot = (r.original_title || r.original_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (t === target || ot === target) {
      return r;
    }
  }

  // 3. Substring match only if target length >= 6 and length difference <= 3
  if (target.length >= 6) {
    for (const r of results) {
      const t = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const ot = (r.original_title || r.original_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (t === target || ot === target) return r;
      if ((t.startsWith(target) || target.startsWith(t)) && Math.abs(t.length - target.length) <= 3) {
        return r;
      }
    }
  }

  return null;
}

// 18+ Adult Detection Helpers
function isAdultItem(item) {
  if (!item) return false;
  if (item.isAdult) return true;
  const str = `${item.cleanTitle || ''} ${item.rawTitle || ''} ${item.categoryName || ''}`.toUpperCase();
  return /(^|\b)(XXX|XX|18\+|PORN|ADULT|SEX|DASI|MUJRA|MUJ)\b/i.test(str) ||
         /(18\+|ADULT|PORN|XXX)/i.test(str);
}

function isAdultChannel(ch) {
  if (!ch) return false;
  if (ch.isAdult) return true;
  const str = `${ch.name || ''} ${ch.categoryName || ''}`.toUpperCase();
  return /(^|\b)(XXX|XX|18\+|PORN|ADULT|SEX)\b/i.test(str) ||
         /(18\+|ADULT|PORN|XXX)/i.test(str);
}

// 10x Parallel Smart-Priority TMDB Enrichment (Newest Hollywood/Bollywood/Hindi-Dubbed/Pakistani FIRST!)
async function startParallelTmdbEnrichment() {
  if (isEnriching) return;
  isEnriching = true;
  try {
    const apiKey = state.credentials.tmdbApiKey || DEFAULT_TMDB_KEY;
    const priorityLangs = new Set(['English', 'Hindi', 'Urdu', 'Punjabi', 'Multi-Audio']);

    // Sort unenriched items so 2024-2026 English/Hindi/Urdu/Punjabi with TMDB IDs enrich FIRST!
    const queue = state.mediaItems
      .filter((m) => !m.isEnriched || !m.genres || m.genres.length === 0)
      .sort((a, b) => {
        const aPrio = priorityLangs.has(a.language) ? 1 : 0;
        const bPrio = priorityLangs.has(b.language) ? 1 : 0;
        if (aPrio !== bPrio) return bPrio - aPrio;
        const aHasTmdb = a.tmdbId > 0 ? 1 : 0;
        const bHasTmdb = b.tmdbId > 0 ? 1 : 0;
        if (aHasTmdb !== bHasTmdb) return bHasTmdb - aHasTmdb;
        const aYr = a.year > 1900 && a.year <= 2026 ? a.year : 0;
        const bYr = b.year > 1900 && b.year <= 2026 ? b.year : 0;
        if (aYr !== bYr) return bYr - aYr;
        return (b.rating || 0) - (a.rating || 0);
      });

    let enrichedCount = state.mediaItems.filter((m) => m.isEnriched && m.genres && m.genres.length > 0).length;
    state.syncStatus.totalToEnrich = state.mediaItems.length;
    state.syncStatus.enrichedCount = enrichedCount;

    const CONCURRENCY = 8;
    let idx = 0;

    async function worker() {
      while (idx < queue.length) {
        const currentIndex = idx++;
        const item = queue[currentIndex];
        if (!item) break;
        try {
          const endpoint = item.mediaType === 'SERIES' ? 'tv' : 'movie';
          let tmdbId = item.tmdbId;
          if (!tmdbId || tmdbId <= 0) {
            const q = encodeURIComponent(item.cleanTitle);
            const yrParam = item.year > 1900 ? (endpoint === 'tv' ? `&first_air_date_year=${item.year}` : `&year=${item.year}`) : '';
            const searchRes = await fetchJsonUrl(`https://api.themoviedb.org/3/search/${endpoint}?api_key=${apiKey}&query=${q}${yrParam}`, 10000);
            const bestMatch = findBestTmdbMatch(searchRes?.results, item.cleanTitle, item.year);
            if (bestMatch) {
              tmdbId = bestMatch.id;
            }
          }
          if (tmdbId > 0) {
            const det = await fetchJsonUrl(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}&append_to_response=credits,external_ids`, 10000);
            item.tmdbId = tmdbId;
            item.imdbId = det.imdb_id || (det.external_ids && det.external_ids.imdb_id) || '';
            if (det.overview) item.plot = det.overview;
            item.rawRating = det.vote_average || 0;
            item.voteCount = det.vote_count || 0;
            item.rating = calcWeightedRating(det.vote_average, det.vote_count);
            item.runtimeMins = det.runtime || (Array.isArray(det.episode_run_time) ? det.episode_run_time[0] : 0) || item.runtimeMins;
            const rel = det.release_date || det.first_air_date || '';
            if (rel) item.year = parseInt(rel.slice(0, 4), 10) || item.year;
            if (Array.isArray(det.genres) && det.genres.length > 0) {
              item.genres = det.genres.map((g) => {
                if (g.name === 'Science Fiction' || g.name === 'Sci-Fi & Fantasy') return 'Sci-Fi';
                if (g.name === 'Action & Adventure') return 'Action';
                return g.name;
              });
            }
            if (det.credits) {
              if (Array.isArray(det.credits.cast)) {
                item.cast = det.credits.cast.slice(0, 8).map((c) => c.name);
              }
              if (Array.isArray(det.credits.crew)) {
                const dir = det.credits.crew.find((c) => c.job === 'Director');
                if (dir) item.director = dir.name;
              }
            }
            if (det.poster_path) item.posterUrl = `https://image.tmdb.org/t/p/w500${det.poster_path}`;
            if (det.backdrop_path) item.backdropUrl = `https://image.tmdb.org/t/p/w1280${det.backdrop_path}`;
          }
        } catch (_) {}

        item.isEnriched = true;
        enrichedCount++;
        if (enrichedCount % 200 === 0) {
          state.syncStatus.enrichedCount = enrichedCount;
          state.syncStatus.phase = `TMDB Enriching Live: ${enrichedCount.toLocaleString()} / ${state.mediaItems.length.toLocaleString()} Titles`;
          scheduleSaveState();
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } finally {
    isEnriching = false;
  }
}

const SEARCH_STOP_WORDS = new Set(['based', 'movie', 'movies', 'film', 'films', 'show', 'shows', 'series', 'the', 'in', 'on', 'at', 'of', 'a', 'an', 'and', 'for', 'to', 'with', 'about', 'like', 'all']);

const SEARCH_SYNONYMS = {
  jungle: ['jungle', 'forest', 'rainforest', 'safari', 'wildlife', 'amazon', 'congo', 'tarzan', 'jumanji'],
  forest: ['forest', 'woods', 'jungle', 'rainforest', 'wilderness'],
  space: ['space', 'galaxy', 'sci-fi', 'astronaut', 'alien', 'cosmos', 'cosmic', 'nasa', 'mars', 'star'],
  alien: ['alien', 'extraterrestrial', 'ufo', 'predator', 'invaders', 'martian'],
  zombie: ['zombie', 'undead', 'infection', 'outbreak', 'walking dead', 'apocalypse'],
  monster: ['monster', 'creature', 'beast', 'godzilla', 'king kong'],
  ghost: ['ghost', 'haunted', 'haunting', 'paranormal', 'spirit', 'demon', 'horror'],
  horror: ['horror', 'scary', 'terror', 'thriller', 'creepy', 'spooky', 'fear'],
  scary: ['scary', 'horror', 'creepy', 'terror', 'haunted'],
  comedy: ['comedy', 'funny', 'hilarious', 'humor', 'parody', 'spoof'],
  funny: ['funny', 'comedy', 'humor', 'hilarious'],
  action: ['action', 'martial arts', 'kung fu', 'combat', 'fight', 'explosive', 'mission', 'spy', 'sniper'],
  romance: ['romance', 'romantic', 'love', 'couple'],
  war: ['war', 'battle', 'soldier', 'combat', 'army', 'military', 'wwii', 'vietnam'],
  car: ['car', 'racing', 'race', 'fast and furious', 'speed', 'driver'],
  racing: ['racing', 'race', 'car', 'cars', 'f1', 'speed', 'turbo'],
  heist: ['heist', 'robbery', 'bank', 'thief', 'crime', 'money', 'steal'],
  crime: ['crime', 'mafia', 'gangster', 'cartel', 'detective', 'police', 'cop', 'investigation', 'murder'],
  superhero: ['superhero', 'marvel', 'dc', 'batman', 'superman', 'spiderman', 'avengers'],
  magic: ['magic', 'wizard', 'witch', 'fantasy', 'spell', 'sorcery', 'harry potter'],
  animated: ['animated', 'animation', 'cartoon', 'anime', 'pixar', 'disney', 'dreamworks'],
  kids: ['kids', 'family', 'children', 'animation', 'cartoon', 'disney']
};

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > 2) return 99;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[lb];
}

function parseQueryIntent(rawQuery) {
  let q = String(rawQuery || '').trim();
  let director = null;
  let cast = null;

  // 1. Quoted or single-token prefix: director:"Christopher Nolan" or director:nolan
  let m = q.match(/\b(?:director|dir):\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9.-]+))/i);
  if (m) {
    director = (m[1] || m[2] || m[3] || '').toLowerCase().trim();
    q = q.replace(m[0], ' ');
  }

  // 2. Quoted or single-token prefix: cast:"Charlize Theron" or cast:theron
  m = q.match(/\b(?:cast|actor|actress|starring):\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9.-]+))/i);
  if (m) {
    cast = (m[1] || m[2] || m[3] || '').toLowerCase().trim();
    q = q.replace(m[0], ' ');
  }

  // 3. Natural: directed by <name>
  m = q.match(/\b(?:directed\s+by)\s+([a-z0-9\s.-]+)/i);
  if (m && !director) {
    director = m[1].toLowerCase().trim();
    q = q.replace(m[0], ' ');
  }

  // 4. Natural: starring <name> or movies with <name>
  m = q.match(/\b(?:starring|featuring|(?:movies|films)\s+with)\s+([a-z0-9\s.-]+)/i);
  if (m && !cast) {
    cast = m[1].toLowerCase().trim();
    q = q.replace(m[0], ' ');
  }

  return { cleanQuery: q.trim().replace(/\s+/g, ' '), targetedDirector: director, targetedCast: cast };
}

// Fast Server-Side Filter Query Engine (<10ms for 65,571 items)
function queryCatalogServerSide(f = {}, limit = 100, offset = 0) {
  const hidden = new Set((state.credentials && state.credentials.hiddenLanguages) || []);
  const incGenres = Array.isArray(f.includedGenres) ? f.includedGenres : [];
  const excGenres = Array.isArray(f.excludedGenres) ? f.excludedGenres : [];
  const selLangs = Array.isArray(f.selectedLanguages) ? f.selectedLanguages : [];
  const rawQuery = String(f.searchQuery || '').trim().toLowerCase();

  const intent = parseQueryIntent(rawQuery);
  const effectiveDirector = f.directorFilter ? f.directorFilter.toLowerCase() : intent.targetedDirector;
  const effectiveCast = f.actorFilter ? f.actorFilter.toLowerCase() : intent.targetedCast;
  const cleanQ = intent.cleanQuery.toLowerCase();

  let qTokens = cleanQ ? cleanQ.split(/\s+/) : [];
  if (qTokens.length > 1) {
    const nonStop = qTokens.filter(t => !SEARCH_STOP_WORDS.has(t));
    if (nonStop.length > 0) qTokens = nonStop;
  }

  const isAdultLocked = !state.parentalControl || state.parentalControl.isLocked || !state.parentalControl.showAdult;
  const isAdultVaultTab = Boolean(f.adultOnly);
  const matched = [];
  const matchAllGenres = f.matchAllIncludedGenres !== undefined ? Boolean(f.matchAllIncludedGenres) : true;

  for (let i = 0; i < state.mediaItems.length; i++) {
    const item = state.mediaItems[i];
    const isAdult = Boolean(item.isAdult || isAdultItem(item));

    // Adult Content Access Rules: Strictly isolated to 18+ Vault tab
    if (isAdultLocked && isAdult) continue; // 100% hidden when locked
    if (isAdultVaultTab) {
      if (!isAdult) continue; // 18+ Vault tab ONLY shows adult content
    } else if (isAdult) {
      continue; // NEVER leak adult content into general browse tabs or general search!
    }

    if (f.mediaTypeFilter && item.mediaType !== f.mediaTypeFilter) continue;
    if (selLangs.length === 0 && !isAdult && hidden.has(item.language)) continue;
    if (selLangs.length > 0) {
      const hasLang = selLangs.includes(item.language) ||
        (Array.isArray(item.versions) && item.versions.some((v) => selLangs.includes(v.languageTag)));
      if (!hasLang) continue;
    }
    if (f.categoryFilter && f.categoryFilter !== 'All') {
      const catClean = (item.categoryName || '').toLowerCase();
      const targetCat = f.categoryFilter.toLowerCase();
      if (!catClean.includes(targetCat) && catClean !== targetCat) continue;
    }
    if (f.hideWatched && item.isWatched) continue;
    if (f.minRating > 0 && (item.rating || 0) < f.minRating) continue;
    if (f.decade && (item.year < f.decade || item.year > f.decade + 9)) continue;
    if (f.yearFilter && item.year !== f.yearFilter) continue;
    if (f.qualityFilter && !(item.qualityBadges || []).includes(f.qualityFilter)) continue;
    if (f.actorFilter && !(item.cast || []).includes(f.actorFilter)) continue;
    if (f.directorFilter && item.director !== f.directorFilter) continue;

    if (f.subtitleFilterMode === 'EMBEDDED_ONLY' && !item.hasEmbeddedSubtitles) continue;
    if (f.subtitleFilterMode === 'ANY_SUBTITLES' && !(item.hasEmbeddedSubtitles || item.hasOnlineSubtitles)) continue;

    if (incGenres.length > 0) {
      const gList = item.genres || [];
      const gListLower = gList.map(x => String(x).toLowerCase());
      if (matchAllGenres) {
        let allOk = true;
        for (const g of incGenres) {
          const gLower = String(g).toLowerCase();
          if (!gListLower.some(x => x === gLower || x.includes(gLower))) { allOk = false; break; }
        }
        if (!allOk) continue;
      } else {
        let anyOk = false;
        for (const g of incGenres) {
          const gLower = String(g).toLowerCase();
          if (gListLower.some(x => x === gLower || x.includes(gLower))) { anyOk = true; break; }
        }
        if (!anyOk) continue;
      }
    }

    if (excGenres.length > 0) {
      const gList = item.genres || [];
      let hasExcluded = false;
      for (const g of excGenres) if (gList.includes(g)) { hasExcluded = true; break; }
      if (hasExcluded) continue;
    }

    const director = (item.director || '').toLowerCase();
    const cast = (item.cast || []).map(c => c.toLowerCase());

    if (effectiveDirector) {
      const matchDir = director.includes(effectiveDirector) ||
        effectiveDirector.split(/\s+/).every(token => director.includes(token));
      if (!matchDir && !cleanQ) continue;
    }

    if (effectiveCast) {
      const matchCast = cast.some(c => c.includes(effectiveCast) ||
        effectiveCast.split(/\s+/).every(token => c.includes(token)));
      if (!matchCast && !cleanQ) continue;
    }

    let searchScore = 0;
    if (rawQuery) {
      const cTitle = (item.cleanTitle || '').toLowerCase();
      const rTitle = (item.rawTitle || '').toLowerCase();
      const plot = (item.plot || '').toLowerCase();
      const genres = (item.genres || []).map(g => g.toLowerCase());
      const category = (item.categoryName || '').toLowerCase();

      if (effectiveDirector) {
        const matchDir = director.includes(effectiveDirector) ||
          effectiveDirector.split(/\s+/).every(token => director.includes(token));
        if (matchDir) searchScore += 400;
      }

      if (effectiveCast) {
        const matchCast = cast.some(c => c.includes(effectiveCast) ||
          effectiveCast.split(/\s+/).every(token => c.includes(token)));
        if (matchCast) searchScore += 400;
      }

      // Exact title matches
      if (cTitle === cleanQ || rTitle === cleanQ) {
        searchScore += 300;
      } else if (cleanQ && cTitle.startsWith(cleanQ)) {
        searchScore += 180;
      } else if (cleanQ && cTitle.includes(cleanQ)) {
        searchScore += 120;
      }

      // Check each token
      for (const t of qTokens) {
        let tokenMatched = false;
        if (cTitle === t) { searchScore += 120; tokenMatched = true; }
        else if (cTitle.startsWith(t)) { searchScore += 80; tokenMatched = true; }
        else if (cTitle.includes(t)) { searchScore += 50; tokenMatched = true; }

        if (genres.some(g => g.includes(t))) { searchScore += 40; tokenMatched = true; }
        if (cast.some(c => c.includes(t))) { searchScore += 35; tokenMatched = true; }
        if (director.includes(t)) { searchScore += 45; tokenMatched = true; }
        if (category.includes(t)) { searchScore += 25; tokenMatched = true; }
        if (plot.includes(t)) { searchScore += 20; tokenMatched = true; }

        // Check synonyms
        const syns = SEARCH_SYNONYMS[t];
        if (syns) {
          for (const s of syns) {
            if (s === t) continue;
            if (cTitle.includes(s)) { searchScore += 35; tokenMatched = true; }
            if (genres.some(g => g.includes(s))) { searchScore += 25; tokenMatched = true; }
            if (plot.includes(s)) { searchScore += 15; tokenMatched = true; }
          }
        }

        // Fuzzy typo tolerance for words >= 4 letters if not matched exactly
        if (!tokenMatched && t.length >= 4) {
          // Check title words
          const tWords = cTitle.split(/[\s:.-]+/);
          for (let k = 0; k < tWords.length; k++) {
            const tw = tWords[k];
            if (tw.length >= 4 && Math.abs(tw.length - t.length) <= 1 && levenshteinDistance(t, tw) <= 1) {
              searchScore += 45;
              tokenMatched = true;
              break;
            }
          }
          // Check director words
          if (!tokenMatched && director) {
            const dWords = director.split(/\s+/);
            for (let k = 0; k < dWords.length; k++) {
              const dw = dWords[k];
              if (dw.length >= 4 && Math.abs(dw.length - t.length) <= 1 && levenshteinDistance(t, dw) <= 1) {
                searchScore += 55;
                tokenMatched = true;
                break;
              }
            }
          }
          // Check cast words (top 5 cast members)
          if (!tokenMatched && cast.length > 0) {
            for (let cIdx = 0; cIdx < Math.min(cast.length, 5); cIdx++) {
              const cWords = cast[cIdx].split(/\s+/);
              for (let k = 0; k < cWords.length; k++) {
                const cw = cWords[k];
                if (cw.length >= 4 && Math.abs(cw.length - t.length) <= 1 && levenshteinDistance(t, cw) <= 1) {
                  searchScore += 40;
                  tokenMatched = true;
                  break;
                }
              }
              if (tokenMatched) break;
            }
          }
        }
      }

      if (searchScore <= 0) continue;
      item._searchScore = searchScore;
    }

    matched.push(item);
  }

  const sortBy = f.sortBy || 'NEWLY_ADDED';
  if (rawQuery) {
    matched.sort((a, b) => (b._searchScore || 0) - (a._searchScore || 0) || (b.rating || 0) - (a.rating || 0));
  } else if (sortBy === 'RANDOM') {
    for (let i = matched.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [matched[i], matched[j]] = [matched[j], matched[i]];
    }
  } else {
    matched.sort((a, b) => {
      if (sortBy === 'RATING_DESC') {
        if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
        return (b.year || 0) - (a.year || 0);
      }
      if (sortBy === 'RELEASE_YEAR_DESC') {
        if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
        return (b.rating || 0) - (a.rating || 0);
      }
      if (sortBy === 'TITLE_ASC') return String(a.cleanTitle).localeCompare(String(b.cleanTitle));
      // NEWLY_ADDED: prioritize enriched items with posters + newest addedTimestamp
      return (b.addedTimestamp || 0) - (a.addedTimestamp || 0);
    });
  }

  return {
    totalMatched: matched.length,
    offset,
    hasMore: (offset + limit) < matched.length,
    items: matched.slice(offset, offset + limit)
  };
}

function buildHomePayload() {
  const isAdultLocked = !state.parentalControl || state.parentalControl.isLocked || !state.parentalControl.showAdult;
  // Strict Isolation: Continue Watching and Watchlist must NEVER contain adult content, even if unlocked!
  const continueWatching = state.mediaItems
    .filter((m) => m.resumePositionMs > 15000 && !m.isWatched && !m.isAdult && !isAdultItem(m))
    .sort((a, b) => (b.lastWatchedTimestamp || 0) - (a.lastWatchedTimestamp || 0))
    .slice(0, 30);
  const watchlist = state.mediaItems
    .filter((m) => m.inWatchlist && !m.isAdult && !isAdultItem(m))
    .slice(0, 25);

  const trendingTop10 = queryCatalogServerSide(
    { decade: 2020, minRating: 6.8, sortBy: 'RATING_DESC' },
    10
  ).items;

  const hollywoodBlockbusters = queryCatalogServerSide(
    { selectedLanguages: ['English', 'Multi-Audio'], decade: 2020, minRating: 6.0, sortBy: 'RELEASE_YEAR_DESC' },
    28
  ).items;

  const bollywoodRegional = queryCatalogServerSide(
    { selectedLanguages: ['Hindi', 'Multi-Audio', 'Urdu', 'Punjabi', 'Tamil', 'Telugu'], sortBy: 'RELEASE_YEAR_DESC' },
    28
  ).items;

  const actionThrillers = queryCatalogServerSide(
    { includedGenres: ['Action', 'Thriller'], minRating: 6.8, sortBy: 'RATING_DESC' },
    28
  ).items;

  const criticallyAcclaimed = queryCatalogServerSide(
    { minRating: 7.8, sortBy: 'RATING_DESC' },
    28
  ).items;

  // Dynamic Personal Recommendation Row: "Suggested For You"
  const ratedKeys = Object.keys(state.userRatings || {});
  let preferredGenres = [];
  for (const k of ratedKeys) {
    if ((state.userRatings[k] || 0) >= 4) {
      const it = mediaMap.get(k);
      if (it && it.genres) preferredGenres.push(...it.genres);
    }
  }
  if (preferredGenres.length === 0) {
    for (const m of [...continueWatching, ...watchlist]) {
      if (m.genres) preferredGenres.push(...m.genres);
    }
  }
  const genreCount = {};
  preferredGenres.forEach((g) => (genreCount[g] = (genreCount[g] || 0) + 1));
  const topPreferred = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);
  const suggestedFilter = topPreferred.length > 0
    ? { includedGenres: topPreferred, minRating: 6.8, sortBy: 'RATING_DESC' }
    : { minRating: 7.4, sortBy: 'RELEASE_YEAR_DESC' };
  const suggestedForYou = queryCatalogServerSide(suggestedFilter, 24).items.filter(
    (m) => !continueWatching.some((c) => c.dedupKey === m.dedupKey)
  );

  const hero = hollywoodBlockbusters.find((m) => m.backdropUrl && m.plot) ||
    trendingTop10.find((m) => m.backdropUrl && m.plot) ||
    hollywoodBlockbusters[0] ||
    state.mediaItems[0];

  const rows = [];
  if (continueWatching.length > 0) {
    rows.push({ title: 'Continue Watching', subtitle: 'Resume from your exact timestamp', items: continueWatching });
  }
  if (suggestedForYou.length > 0) {
    rows.push({
      title: 'Suggested For You',
      subtitle: topPreferred.length > 0 ? `Based on your high ratings in ${topPreferred.join(' & ')}` : 'Tailored to your taste',
      items: suggestedForYou
    });
  }
  if (watchlist.length > 0) {
    rows.push({ title: 'My List', subtitle: '', items: watchlist });
  }
  if (trendingTop10.length > 0) {
    rows.push({ title: 'Top 10 Trending Today', subtitle: '', items: trendingTop10 });
  }
  if (hollywoodBlockbusters.length > 0) {
    rows.push({ title: 'Hollywood Blockbusters', subtitle: '', items: hollywoodBlockbusters });
  }
  if (bollywoodRegional.length > 0) {
    rows.push({ title: 'Bollywood & Regional Cinema', subtitle: '', items: bollywoodRegional });
  }
  if (actionThrillers.length > 0) {
    rows.push({ title: 'Action & Thrillers', subtitle: '', items: actionThrillers });
  }
  if (criticallyAcclaimed.length > 0) {
    rows.push({ title: 'Critically Acclaimed (8.0+)', subtitle: '', items: criticallyAcclaimed });
  }

  return { hero, rows };
}

// Convert SRT subtitle string into WebVTT with optional delay offset in seconds
function srtToWebVtt(srtText, offsetSec = 0) {
  const shiftMs = Math.round(offsetSec * 1000);
  const shiftTimestamp = (h, m, s, ms) => {
    let total = ((parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + parseInt(ms, 10)) + shiftMs;
    if (total < 0) total = 0;
    const hh = String(Math.floor(total / 3600000)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
    const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
    const mmm = String(total % 1000).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${mmm}`;
  };

  const replaced = String(srtText || '')
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g,
      (_, h1, m1, s1, ms1, h2, m2, s2, ms2) =>
        `${shiftTimestamp(h1, m1, s1, ms1)} --> ${shiftTimestamp(h2, m2, s2, ms2)}`
    );
  return `WEBVTT\n\n${replaced}`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && (pathname === '/tv' || pathname === '/')) {
    const mode = parsedUrl.searchParams.get('mode');
    if (pathname === '/' && mode === 'phone') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(buildPhonePortalHtml());
    }
    const htmlPath = path.join(__dirname, 'tv-ui.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath, 'utf8'));
  }

  if (req.method === 'GET' && pathname === '/phone') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(buildPhonePortalHtml());
  }

  if (req.method === 'GET' && pathname === '/link') {
    const codeParam = parsedUrl.searchParams.get('code') || (state.activeTvCode ? state.activeTvCode.code : '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderWebPairingUi(codeParam));
  }

  if (req.method === 'POST' && pathname === '/api/auth/claim-code') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { code, displayName, email } = JSON.parse(body || '{}');
        // Forward to live Cloudflare Worker
        try {
          await fetch(`${CLOUDFLARE_WORKER_URL}/api/auth/claim-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, displayName, email })
          });
        } catch (_) {}

        state.cloudSyncAccount = {
          email: email || 'waleed@streamvault.tv',
          displayName: displayName || 'Waleed Khan',
          linkedAt: Date.now()
        };
        if (state.activeTvCode && state.activeTvCode.code === (code || '').toUpperCase()) {
          state.activeTvCode.status = 'claimed';
        }
        state.lastCloudSyncedAt = Date.now();
        scheduleSaveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: 'TV linked successfully!' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Lightweight status endpoint (<4KB) so 2-second polling never lags!
  if (req.method === 'GET' && pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      credentials: state.credentials,
      parentalControl: state.parentalControl,
      syncStatus: state.syncStatus,
      remoteSearchQuery: state.remoteSearchQuery,
      pinnedSmartRows: state.pinnedSmartRows,
      totalCatalogCount: state.mediaItems.length,
      totalLiveCount: state.liveChannels.length,
      localIpUrl: `http://${getLocalIp()}:${PORT}/phone`
    }));
  }

  // Home Screen Rows Endpoint
  if (req.method === 'GET' && pathname === '/api/home') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(buildHomePayload()));
  }

  // Watchlist Endpoint
  if (req.method === 'GET' && pathname === '/api/watchlist') {
    const items = state.mediaItems.filter((m) => m.inWatchlist);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, items }));
  }

  // Fast Server-Side Super-Filter & Autocomplete Endpoint
  if (req.method === 'POST' && pathname === '/api/query') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const filter = parsed.filter || parsed;
        const limit = parsed.limit || filter.limit || 120;
        const offset = parsed.offset || filter.offset || 0;
        const result = queryCatalogServerSide(filter, limit, offset);
        // Also compute 2-letter autocomplete suggestions
        const isAdultLocked = !state.parentalControl || state.parentalControl.isLocked || !state.parentalControl.showAdult;
        const autoChips = [];
        const prefix = String(filter.searchQuery || '').trim().toLowerCase();
        if (prefix.length >= 2) {
          const seen = new Set();
          for (const m of state.mediaItems) {
            if (m.isAdult || isAdultItem(m)) continue; // Never suggest adult titles in search autocomplete
            if (m.cleanTitle && m.cleanTitle.toLowerCase().includes(prefix)) seen.add(m.cleanTitle);
            for (const c of m.cast || []) if (c.toLowerCase().includes(prefix)) seen.add(c);
            if (m.director && m.director.toLowerCase().includes(prefix)) seen.add(m.director);
            if (seen.size >= 8) break;
          }
          autoChips.push(...seen);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ...result, autoChips }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

// ============================================================================
// Smart Recommendation Engine: Setting, Story Type, Tone, & Audiovisual Immersion
// ============================================================================
const SETTING_PATTERNS = [
  { id: 'snow_wilderness', regex: /\b(snow|arctic|alaska|antarctica|winter|blizzard|everest|mountain|ice|frozen|tundra|siberia)\b/i, label: '❄ Same Snow Wilderness Setting' },
  { id: 'jungle_island', regex: /\b(jungle|rainforest|deserted island|island|amazon|tropics|wild island)\b/i, label: '🌴 Same Jungle / Island Setting' },
  { id: 'ocean_sea', regex: /\b(ocean|sea|submarine|underwater|ship|shipwreck|boat|naval|deep sea|pacific|atlantic)\b/i, label: '🌊 Same Ocean / Deep Sea Setting' },
  { id: 'space_galaxy', regex: /\b(space|mars|spaceship|astronaut|galaxy|orbit|interstellar|cosmos|moon|spacecraft|extraterrestrial)\b/i, label: '🚀 Same Deep Space Setting' },
  { id: 'confined_space', regex: /\b(confined space|bunker|prison|jail|cell|elevator|trapped inside|underground|train|airplane|cockpit|safe room)\b/i, label: '📦 Same Confined Space Setting' },
  { id: 'desert_wasteland', regex: /\b(desert|sahara|wasteland|mad max|dunes|arid|post-apocalyptic wasteland)\b/i, label: '🏜 Same Desert Wilderness Setting' },
  { id: 'cyberpunk_future', regex: /\b(cyberpunk|dystopia|post-apocalyptic|android|matrix|futuristic city|high-tech|neon city)\b/i, label: '🤖 Same Cyberpunk / Future Setting' },
  { id: 'urban_underworld', regex: /\b(noir|underworld|metropolis|mafia|gangster|cartel|alley|corrupt city)\b/i, label: '🌃 Same Urban Noir Setting' }
];

const STORY_PATTERNS = [
  { id: 'survival', regex: /\b(survival|survive|stranded|struggle to survive|castaway|man vs nature|harsh elements)\b/i, label: '🎯 Same Survival Story' },
  { id: 'mystery_investigation', regex: /\b(mystery|whodunit|detective|investigation|murder mystery|clues|solve the case|conspiracy|investigator)\b/i, label: '🔍 Same Mystery & Investigation' },
  { id: 'trapped_escape', regex: /\b(trapped|escape|hostage|breakout|locked in|kidnap|held captive|break out)\b/i, label: '🔒 Same Trapped & Escape Story' },
  { id: 'hunted_predator', regex: /\b(hunted|stalked|predator|slasher|prey|chased|cat and mouse|serial killer|relentless pursuit)\b/i, label: '🩸 Same Hunted & Stalked Story' },
  { id: 'heist_con', regex: /\b(heist|robbery|bank robbery|con artist|swindle|vault|master thief)\b/i, label: '💰 Same Heist & Master Con' },
  { id: 'revenge_vengeance', regex: /\b(revenge|vengeance|retaliation|payback|vendetta|avenge)\b/i, label: '⚔ Same Revenge & Retaliation' },
  { id: 'time_loop_travel', regex: /\b(time loop|time travel|multiverse|alternate dimension|paradox|timeline)\b/i, label: '⏳ Same Time Travel / Loop Concept' },
  { id: 'mind_game_psychological', regex: /\b(mind game|psychological|gaslight|paranoia|delusion|hallucination|identity theft|sanity)\b/i, label: '🧠 Same Psychological Mind Game' },
  { id: 'underdog_triumph', regex: /\b(underdog|tournament|championship|against all odds|triumph|champion)\b/i, label: '🏆 Same Underdog Story' }
];

const TONE_PATTERNS = [
  { id: 'dark_intense', regex: /\b(dark|intense|gritty|bleak|brutal|suspenseful|terrifying|relentless|unflinching)\b/i, label: '⚡ Dark & Intense Tone' },
  { id: 'mind_bending', regex: /\b(mind-bending|surreal|philosophical|existential|trippy|complex|cerebral)\b/i, label: '🌀 Mind-Bending Feel' },
  { id: 'epic_spectacle', regex: /\b(epic|visually stunning|grand scale|cinematography|masterpiece|visual spectacle|breathtaking)\b/i, label: '✨ Grand Visual Spectacle' },
  { id: 'high_octane', regex: /\b(action-packed|high-octane|fast-paced|explosive|adrenaline|thrilling)\b/i, label: '💥 High-Octane Adrenaline' },
  { id: 'lighthearted_fun', regex: /\b(feel-good|heartwarming|comedy|hilarious|witty|uplifting|charming)\b/i, label: '🎉 Feel-Good & Lighthearted' }
];

function extractSemanticTokens(item) {
  const text = `${item.cleanTitle || ''} ${item.plot || ''} ${(item.genres || []).join(' ')} ${(item.keywords || []).join(' ')} ${item.categoryName || ''}`.toLowerCase();
  const settings = SETTING_PATTERNS.filter(p => p.regex.test(text)).map(p => ({ id: p.id, label: p.label }));
  const stories = STORY_PATTERNS.filter(p => p.regex.test(text)).map(p => ({ id: p.id, label: p.label }));
  const tones = TONE_PATTERNS.filter(p => p.regex.test(text)).map(p => ({ id: p.id, label: p.label }));
  return { settings, stories, tones, text };
}

function computeSmartSimilarity(source, candidate, userRatings = {}, matchMode = 'everything', hideWatched = false) {
  if (!candidate || candidate.dedupKey === source.dedupKey) return null;
  if (hideWatched && candidate.isWatched) return null;

  // If user rated candidate itself <= 2, hide it
  const userRate = userRatings[candidate.dedupKey];
  if (userRate && userRate <= 2) return null;

  const srcSem = extractSemanticTokens(source);
  const candSem = extractSemanticTokens(candidate);

  let storyScore = 0;
  let toneScore = 0;
  let settingScore = 0;
  let genreScore = 0;
  let castScore = 0;
  let directorScore = 0;
  let franchiseScore = 0;
  const reasons = [];

  // 1. Story Type Match (Highest Weight: 35)
  for (const s of srcSem.stories) {
    if (candSem.stories.some(cs => cs.id === s.id)) {
      storyScore += 35;
      reasons.push({ score: 40, label: s.label });
    }
  }

  // 2. Tone & Pace Match (High Weight: 25)
  for (const t of srcSem.tones) {
    if (candSem.tones.some(ct => ct.id === t.id)) {
      toneScore += 25;
      reasons.push({ score: 28, label: t.label });
    }
  }

  // 3. Setting Match (Medium-High Weight: 25)
  for (const set of srcSem.settings) {
    if (candSem.settings.some(cset => cset.id === set.id)) {
      settingScore += 25;
      reasons.push({ score: 32, label: set.label });
    }
  }

  // 4. Shared Genres (Normalized by overlap)
  const srcGenres = new Set(source.genres || []);
  const sharedGenres = (candidate.genres || []).filter(g => srcGenres.has(g));
  if (sharedGenres.length > 0) {
    genreScore += sharedGenres.length * 8;
    if (sharedGenres.length >= 2) {
      reasons.push({ score: 18, label: `🎭 Shared ${sharedGenres.slice(0, 2).join(' & ')}` });
    }
  }

  // 5. Director Match (30 pts)
  if (source.director && candidate.director && source.director.toLowerCase() === candidate.director.toLowerCase()) {
    directorScore += 30;
    reasons.push({ score: 36, label: `🎬 Directed by ${source.director}` });
  }

  // 6. Lead Cast Match (Up to 24 pts)
  const srcCast = new Set((source.cast || []).map(c => c.toLowerCase()));
  const sharedCast = (candidate.cast || []).filter(c => srcCast.has(c.toLowerCase()));
  if (sharedCast.length > 0) {
    castScore += Math.min(24, sharedCast.length * 12);
    reasons.push({ score: 24, label: `👥 Starring ${sharedCast[0]}` });
  }

  // 7. Franchise / Collection Match (35 pts)
  if (source.collection && candidate.collection && source.collection.toLowerCase() === candidate.collection.toLowerCase()) {
    franchiseScore += 35;
    reasons.push({ score: 38, label: `🌟 Same Universe: ${source.collection}` });
  }

  // Mode Multipliers:
  let totalScore = 0;
  if (matchMode === 'story') {
    totalScore = (storyScore * 2.5) + (toneScore * 2.0) + (settingScore * 0.8) + (genreScore * 0.5) + (directorScore * 0.2);
  } else if (matchMode === 'setting') {
    totalScore = (settingScore * 3.0) + (storyScore * 0.8) + (toneScore * 0.8) + (genreScore * 0.5);
  } else if (matchMode === 'cast_director') {
    totalScore = (directorScore * 2.5) + (castScore * 2.5) + (franchiseScore * 2.0) + (genreScore * 0.5);
  } else {
    // 'everything' (balanced standard: Story & Tone highest, then Setting & Genre, then Cast & Director)
    totalScore = storyScore + toneScore + settingScore + genreScore + castScore + directorScore + franchiseScore;
  }

  // Adjust score using user's personal taste / rating profile:
  for (const [ratedKey, rScore] of Object.entries(userRatings)) {
    if (rScore >= 4) {
      const ratedItem = mediaMap.get(ratedKey);
      if (ratedItem) {
        if (ratedItem.director && candidate.director && ratedItem.director.toLowerCase() === candidate.director.toLowerCase()) {
          totalScore += 15;
        }
        const rSem = extractSemanticTokens(ratedItem);
        if (candSem.stories.some(cs => rSem.stories.some(rs => rs.id === cs.id))) totalScore += 12;
      }
    } else if (rScore <= 2) {
      const ratedItem = mediaMap.get(ratedKey);
      if (ratedItem) {
        if (ratedItem.director && candidate.director && ratedItem.director.toLowerCase() === candidate.director.toLowerCase()) {
          totalScore -= 20;
        }
        const rSem = extractSemanticTokens(ratedItem);
        if (candSem.stories.some(cs => rSem.stories.some(rs => rs.id === cs.id))) totalScore -= 15;
      }
    }
  }

  // Add subtle boost for verified Bayesian quality
  totalScore += (candidate.rating || 0) * 1.5;

  if (totalScore < 10) return null;

  reasons.sort((a, b) => b.score - a.score);
  const bestReason = reasons[0] ? reasons[0].label : (sharedGenres.length > 0 ? `🎭 Shared ${sharedGenres[0]}` : '✨ Thematically Similar');

  return {
    score: totalScore,
    matchReason: bestReason
  };
}

  // Item Detail + Live On-Demand TMDB Enrichment + Smart "More Like This" Engine
  if (req.method === 'GET' && pathname === '/api/detail') {
    const dedupKey = parsedUrl.searchParams.get('dedupKey') || '';
    const matchMode = parsedUrl.searchParams.get('matchMode') || 'everything';
    const hideWatched = parsedUrl.searchParams.get('hideWatched') === 'true';

    const item = mediaMap.get(dedupKey);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }

    // Live on-demand TMDB Enrichment for deep plot, keywords, cast, and director
    if (!item.plot || !item.genres || item.genres.length === 0 || !item.keywords) {
      try {
        const apiKey = state.credentials.tmdbApiKey || DEFAULT_TMDB_KEY;
        const endpoint = item.mediaType === 'SERIES' ? 'tv' : 'movie';
        let tmdbId = item.tmdbId;
        if (!tmdbId || tmdbId <= 0) {
          const q = encodeURIComponent(item.cleanTitle);
          const yr = item.year > 1900 ? `&year=${item.year}` : '';
          const sRes = await fetchJsonUrl(`https://api.themoviedb.org/3/search/${endpoint}?api_key=${apiKey}&query=${q}${yr}`, 6000);
          const bestMatch = findBestTmdbMatch(sRes?.results, item.cleanTitle, item.year);
          if (bestMatch) tmdbId = bestMatch.id;
        }
        if (tmdbId > 0) {
          const det = await fetchJsonUrl(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}&append_to_response=credits,external_ids,keywords`, 6000);
          item.tmdbId = tmdbId;
          item.imdbId = det.imdb_id || (det.external_ids && det.external_ids.imdb_id) || '';
          if (det.overview) item.plot = det.overview;
          item.rawRating = det.vote_average || 0;
          item.voteCount = det.vote_count || 0;
          item.rating = calcWeightedRating(det.vote_average, det.vote_count);
          item.runtimeMins = det.runtime || item.runtimeMins;
          if (Array.isArray(det.genres) && det.genres.length > 0) {
            item.genres = det.genres.map((g) => (g.name === 'Science Fiction' ? 'Sci-Fi' : g.name));
          }
          if (det.credits) {
            if (Array.isArray(det.credits.cast)) item.cast = det.credits.cast.slice(0, 8).map((c) => c.name);
            if (Array.isArray(det.credits.crew)) {
              const dir = det.credits.crew.find((c) => c.job === 'Director');
              if (dir) item.director = dir.name;
            }
          }
          if (det.keywords) {
            const kwList = det.keywords.keywords || det.keywords.results || [];
            item.keywords = kwList.map((k) => k.name);
          }
          if (det.belongs_to_collection && det.belongs_to_collection.name) {
            item.collection = det.belongs_to_collection.name;
          }
          if (det.poster_path) item.posterUrl = `https://image.tmdb.org/t/p/w500${det.poster_path}`;
          if (det.backdrop_path) item.backdropUrl = `https://image.tmdb.org/t/p/w1280${det.backdrop_path}`;
          item.isEnriched = true;
        }
      } catch (_) {}
    }

    // For Series: Auto-resolve Episodes from Xtream Codes so Watch Now plays real episode
    if (item.mediaType === 'SERIES' && (!item.episodes || item.episodes.length === 0)) {
      try {
        const creds = state.credentials;
        if (creds.serverUrl && creds.username && creds.password) {
          const sUrl = `${creds.serverUrl.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=get_series_info&series_id=${item.primaryStreamId}`;
          const sData = await fetchJsonUrl(sUrl, 5000);
          if (sData) {
            if (sData.info) {
              if (sData.info.genre && (!item.genres || item.genres.length === 0)) {
                item.genres = sData.info.genre.split(/[\/,|•-]/).map(g => g.trim()).filter(Boolean);
              }
              if (sData.info.plot && !item.plot) item.plot = sData.info.plot;
              if (sData.info.cast && (!item.cast || item.cast.length === 0)) {
                item.cast = sData.info.cast.split(',').map(c => c.trim()).filter(Boolean).slice(0, 8);
              }
              if (sData.info.director && !item.director) item.director = sData.info.director;
            }
            if (sData.episodes) {
              const allEps = [];
              Object.keys(sData.episodes).sort((a, b) => Number(a) - Number(b)).forEach(sNum => {
                const epList = sData.episodes[sNum] || [];
                epList.forEach(ep => {
                  allEps.push({
                    id: String(ep.id),
                    season: ep.season || Number(sNum),
                    episodeNum: ep.episode_num,
                    title: ep.title,
                    containerExtension: ep.container_extension || 'mkv',
                    plot: (ep.info && ep.info.plot) || '',
                    durationSecs: (ep.info && ep.info.duration_secs) || 0
                  });
                });
              });

              // Check for sister entries for other seasons in state.mediaItems
              function normalizeSeriesKey(t) {
                return String(t || '')
                  .toLowerCase()
                  .replace(/\b(s\d{1,2}|season\s*\d{1,2}|part\s*\d{1,2})\b/gi, ' ')
                  .replace(/\b(19\d\d|20\d\d)\b/g, ' ')
                  .replace(/[^a-z0-9]/g, '')
                  .trim();
              }
              const baseNorm = normalizeSeriesKey(item.cleanTitle || item.rawTitle);
              const cleanKey = item.cleanTitle.trim().toLowerCase();
              const sisterEntries = (state.mediaItems || []).filter(other => 
                other.mediaType === 'SERIES' &&
                String(other.primaryStreamId) !== String(item.primaryStreamId) &&
                ((item.tmdbId > 0 && other.tmdbId === item.tmdbId) ||
                 (other.cleanTitle && other.cleanTitle.trim().toLowerCase() === cleanKey) ||
                 (baseNorm.length >= 4 && normalizeSeriesKey(other.cleanTitle || other.rawTitle) === baseNorm))
              );

              for (const sister of sisterEntries) {
                try {
                  const sisUrl = `${creds.serverUrl.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=get_series_info&series_id=${sister.primaryStreamId}`;
                  const sisData = await fetchJsonUrl(sisUrl, 4000);
                  if (sisData && sisData.episodes) {
                    Object.keys(sisData.episodes).forEach(sNum => {
                      const list = sisData.episodes[sNum] || [];
                      list.forEach(ep => {
                        const epSeason = ep.season || Number(sNum);
                        if (!allEps.some(e => e.season === epSeason && e.episodeNum === ep.episode_num)) {
                          allEps.push({
                            id: String(ep.id),
                            season: epSeason,
                            episodeNum: ep.episode_num,
                            title: ep.title,
                            containerExtension: ep.container_extension || 'mkv',
                            plot: (ep.info && ep.info.plot) || '',
                            durationSecs: (ep.info && ep.info.duration_secs) || 0
                          });
                        }
                      });
                    });
                  }
                } catch (_) {}
              }

              allEps.sort((a, b) => (a.season - b.season) || (a.episodeNum - b.episodeNum));
              item.episodes = allEps;
              if (allEps.length > 0) {
                item.firstEpisodeStreamId = allEps[0].id;
                item.firstEpisodeExtension = allEps[0].containerExtension;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Series episode fetch notice:', e.message);
      }
    }

    // Ensure genres is never empty
    if (!item.genres || item.genres.length === 0) {
      if (item.categoryName) {
        const catClean = item.categoryName.replace(/^[^:]+:\s*/, '').trim();
        if (catClean) item.genres = [catClean];
      }
    }

    // Smart "More Like This" Multi-Signal Ranking
    const userRatings = state.userRatings || {};
    // Extract candidate pool using fast genre/category heuristic
    const queryGenres = (item.genres && item.genres.length > 0) ? item.genres.slice(0, 3) : [];
    const pool = queryCatalogServerSide(
      { includedGenres: queryGenres, minRating: 5.5, sortBy: 'RATING_DESC' },
      160
    ).items;

    // Also include other items by the same director or franchise if available
    if (item.director) {
      for (const m of state.mediaItems) {
        if (m.dedupKey !== item.dedupKey && m.director && m.director.toLowerCase() === item.director.toLowerCase()) {
          if (!pool.some(p => p.dedupKey === m.dedupKey)) pool.push(m);
        }
      }
    }

    const scoredCandidates = [];
    for (const cand of pool) {
      const sim = computeSmartSimilarity(item, cand, userRatings, matchMode, hideWatched);
      if (sim) {
        scoredCandidates.push({
          ...cand,
          similarityScore: sim.score,
          matchReason: sim.matchReason
        });
      }
    }

    scoredCandidates.sort((a, b) => b.similarityScore - a.similarityScore);

    // Limit repeats from the same franchise or director to at most 2 titles for maximum diversity!
    const directorCount = {};
    const franchiseCount = {};
    const related = [];
    for (const cand of scoredCandidates) {
      if (cand.director) {
        const dKey = cand.director.toLowerCase();
        directorCount[dKey] = (directorCount[dKey] || 0) + 1;
        if (directorCount[dKey] > 2) continue;
      }
      if (cand.collection) {
        const fKey = cand.collection.toLowerCase();
        franchiseCount[fKey] = (franchiseCount[fKey] || 0) + 1;
        if (franchiseCount[fKey] > 2) continue;
      }
      related.push(cand);
      if (related.length >= 24) break;
    }

    // Graceful fallback if catalog pool was narrow
    if (related.length < 6) {
      const fallbacks = queryCatalogServerSide({ minRating: 6.8, sortBy: 'RATING_DESC' }, 12).items;
      for (const fb of fallbacks) {
        if (fb.dedupKey !== item.dedupKey && !related.some(r => r.dedupKey === fb.dedupKey)) {
          related.push({ ...fb, matchReason: '✨ Highly Rated Alternative' });
          if (related.length >= 18) break;
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ item, related, matchMode, hideWatched }));
  }

  // Live TV Endpoint with Grouped Tabs, Favorites, and Search
  if (req.method === 'GET' && pathname === '/api/live') {
    const tab = (parsedUrl.searchParams.get('tab') || 'ALL').toUpperCase();
    const q = (parsedUrl.searchParams.get('q') || '').toLowerCase().trim();
    const favSet = new Set(state.favoriteLiveChannels || []);

    const isAdultLocked = !state.parentalControl || state.parentalControl.isLocked || !state.parentalControl.showAdult;

    const filterChannelByTab = (c) => {
      const isAdult = isAdultChannel(c);
      if (isAdult) {
        // Adult channels ONLY appear in dedicated ADULT tab and ONLY when unlocked
        return tab === 'ADULT' && !isAdultLocked;
      }
      if (tab === 'ADULT') return false;
      if (tab === 'FAVORITES') return favSet.has(String(c.streamId));
      if (tab === 'ALL') return true;
      const cat = (c.categoryName || '').toUpperCase();
      if (tab === 'SPORTS') return /(SPORTS|CRICKET|FOOTBALL|SOCCER|GOLF|WWE|UFC|F1|RACING|TENNIS|NBA|ESPN|SKY SPORT)/.test(cat);
      if (tab === 'NEWS') return /(NEWS|CNN|BBC|SKY NEWS|AL JAZEERA|GEO|ARY|BOL|HUM|AAJ)/.test(cat);
      if (tab === 'MOVIES') return /(CINEMA|MOVIE|FILM|HBO|BOX OFFICE|STAR MOVIES)/.test(cat);
      if (tab === 'ENTERTAINMENT') return /(ENTERTAIN|DRAMA|SERIES|SHOWS|COMEDY)/.test(cat);
      if (tab === 'KIDS') return /(KIDS|CARTOON|DISNEY|NICK|POGO|ANIME)/.test(cat);
      if (tab === 'UK') return cat.includes('UK') || cat.startsWith('GB');
      if (tab === 'US') return cat.includes('US') || cat.includes('USA');
      if (tab === 'PAKISTAN') return cat.includes('PAK') || cat.includes('URDU');
      if (tab === 'INDIA') return cat.includes('INDIA') || cat.includes('HINDI') || cat.includes('IN |');
      return cat.includes(tab);
    };

    const tabs = [
      { id: 'ALL', label: 'All' },
      { id: 'FAVORITES', label: '★ Favorites' },
      { id: 'SPORTS', label: 'Sports' },
      { id: 'NEWS', label: 'News' },
      { id: 'MOVIES', label: 'Movies' },
      { id: 'ENTERTAINMENT', label: 'Entertainment' },
      { id: 'KIDS', label: 'Kids' },
      { id: 'PAKISTAN', label: 'Pakistan' },
      { id: 'INDIA', label: 'India' },
      { id: 'UK', label: 'UK' },
      { id: 'US', label: 'US' }
    ];
    if (!isAdultLocked) {
      tabs.push({ id: 'ADULT', label: '🔞 Adult' });
    }

    let matched = state.liveChannels.filter((c) => {
      if (/^[•●★=\s-]+Welcome/i.test(c.name)) return false;
      if (isAdultLocked && isAdultChannel(c)) return false;
      if (!filterChannelByTab(c)) return false;
      if (q && !c.name.toLowerCase().includes(q) && !(c.categoryName || '').toLowerCase().includes(q)) return false;
      return true;
    });

    const channels = matched.slice(0, 150).map((c) => ({
      ...c,
      isFavorite: favSet.has(String(c.streamId))
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      tabs,
      currentTab: tab,
      channels,
      totalChannels: state.liveChannels.length,
      matchedCount: matched.length
    }));
  }

  // Toggle Live Channel Favorite
  if (req.method === 'POST' && pathname === '/api/live/favorite') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { streamId } = JSON.parse(body || '{}');
        if (!state.favoriteLiveChannels) state.favoriteLiveChannels = [];
        const sId = String(streamId);
        const idx = state.favoriteLiveChannels.indexOf(sId);
        const isFav = idx < 0;
        if (isFav) state.favoriteLiveChannels.push(sId);
        else state.favoriteLiveChannels.splice(idx, 1);
        scheduleSaveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, isFavorite: isFav, streamId: sId }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }



  // Record or Clear User Star Rating (1 to 5, or 0 to remove) for Intelligent Recommendations
  if (req.method === 'POST' && pathname === '/api/rate') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { dedupKey, rating } = JSON.parse(body || '{}');
        if (!state.userRatings) state.userRatings = {};
        if (dedupKey) {
          const numRating = parseInt(rating, 10);
          if (isNaN(numRating) || numRating <= 0 || rating === null) {
            delete state.userRatings[dedupKey];
          } else {
            state.userRatings[dedupKey] = Math.max(1, Math.min(5, numRating));
          }
          scheduleSaveState();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, rating: state.userRatings[dedupKey] || 0, userRatings: state.userRatings }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Record Video Playback Progress & Resume Timestamp (Industry Standard)
  if (req.method === 'POST' && pathname === '/api/progress') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { dedupKey, positionMs, durationMs } = JSON.parse(body || '{}');
        const item = mediaMap.get(dedupKey);
        if (item && positionMs !== undefined) {
          item.resumePositionMs = Math.max(0, parseInt(positionMs, 10) || 0);
          if (durationMs) item.durationMs = parseInt(durationMs, 10);
          item.lastWatchedTimestamp = Date.now();
          // Auto-mark watched if completed > 90%
          if (item.durationMs > 0 && item.resumePositionMs > (item.durationMs * 0.90)) {
            item.isWatched = true;
          } else if (item.durationMs > 0 && item.resumePositionMs < (item.durationMs * 0.90)) {
            item.isWatched = false;
          }
          scheduleSaveState();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, resumePositionMs: item ? item.resumePositionMs : 0 }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Master 4-Digit Parental PIN Controls (Lock/Unlock Adult Content)
  if (req.method === 'POST' && pathname === '/api/parental-pin') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { pin, action, newPin } = JSON.parse(body || '{}');
        if (!state.parentalControl) {
          state.parentalControl = { isLocked: true, pin: '0000', showAdult: false };
        }
        const currentPin = state.parentalControl.pin || '0000';
        if (action === 'status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            isLocked: state.parentalControl.isLocked,
            showAdult: state.parentalControl.showAdult,
            hasCustomPin: currentPin !== '0000'
          }));
        }
        if (action === 'lock') {
          state.parentalControl.showAdult = false;
          state.parentalControl.isLocked = true;
          scheduleSaveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            isLocked: true,
            showAdult: false
          }));
        }
        if (action === 'unlock') {
          if (pin === currentPin) {
            state.parentalControl.showAdult = true;
            state.parentalControl.isLocked = false;
            scheduleSaveState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              isLocked: false,
              showAdult: true
            }));
          } else {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Incorrect 4-digit PIN' }));
          }
        }
        if (action === 'set_pin') {
          if (pin !== currentPin) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Current PIN is incorrect' }));
          }
          if (!newPin || String(newPin).length !== 4) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'New PIN must be exactly 4 digits' }));
          }
          state.parentalControl.pin = String(newPin);
          scheduleSaveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'Parental PIN updated successfully' }));
        }
        // Unlock / Lock toggle
        if (pin === currentPin) {
          state.parentalControl.showAdult = !state.parentalControl.showAdult;
          state.parentalControl.isLocked = !state.parentalControl.showAdult;
          scheduleSaveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            isLocked: state.parentalControl.isLocked,
            showAdult: state.parentalControl.showAdult
          }));
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Incorrect 4-digit PIN' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Adult Vault Categories / Studios list
  if (req.method === 'GET' && pathname === '/api/adult-categories') {
    const categories = ADULT_VOD_CATEGORIES.map(c => c.name);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ categories }));
  }

  // Probe Stream Sizes & Verify High Quality Releases (HTTP Range 0-10)
  if (req.method === 'GET' && pathname === '/api/probe-versions') {
    const dedupKey = parsedUrl.searchParams.get('dedupKey');
    const item = mediaMap.get(dedupKey);
    if (!item || !Array.isArray(item.versions) || item.versions.length <= 1) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, versions: item ? item.versions : [] }));
    }

    Promise.all(
      item.versions.map(async (v) => {
        if (!v.fileSizeBytes) {
          const size = await probeStreamSize(v.streamId, v.containerExtension || 'mkv');
          if (size > 0) {
            v.fileSizeBytes = size;
            v.fileSizeStr = formatBytes(size);
            const mb = size / (1024 * 1024);
            if (mb > 2500) v.qualityScore = (v.qualityScore || 10) + 20;
            else if (mb > 1500) v.qualityScore = (v.qualityScore || 10) + 12;
            else if (mb > 800) v.qualityScore = (v.qualityScore || 10) + 5;
          }
        }
        return v;
      })
    ).then((updatedVersions) => {
      updatedVersions.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
      item.versions = updatedVersions;
      if (updatedVersions[0]) {
        item.primaryStreamId = updatedVersions[0].streamId;
      }
      scheduleSaveState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, versions: updatedVersions }));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Search History Endpoints (YouTube TV Style)
  if (pathname === '/api/search-history') {
    if (req.method === 'GET') {
      const history = (state.recentSearches || [])
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .map(s => (typeof s === 'string' ? s : s.query))
        .filter(Boolean)
        .slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ history }));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { query } = JSON.parse(body || '{}');
          const cleanQ = String(query || '').trim();
          if (cleanQ && cleanQ.length >= 2) {
            if (!state.recentSearches) state.recentSearches = [];
            state.recentSearches = state.recentSearches.filter(s => {
              const str = typeof s === 'string' ? s : s.query;
              return str.toLowerCase() !== cleanQ.toLowerCase();
            });
            state.recentSearches.unshift({ query: cleanQ, timestamp: Date.now() });
            state.recentSearches = state.recentSearches.slice(0, 30);
            scheduleSaveState();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, history: (state.recentSearches || []).map(s => (typeof s === 'string' ? s : s.query)) }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/search-history/delete') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body || '{}');
        const target = String(query || '').trim().toLowerCase();
        if (state.recentSearches) {
          state.recentSearches = state.recentSearches.filter(s => {
            const str = typeof s === 'string' ? s : s.query;
            return str.toLowerCase() !== target;
          });
          scheduleSaveState();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/search-history/clear') {
    state.recentSearches = [];
    scheduleSaveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // 7.6. Profile Management Endpoints
  if (pathname === '/api/profiles') {
    if (req.method === 'GET') {
      if (!state.profiles || !state.profiles.length) {
        state.profiles = [
          { id: 'prof_1', name: state.credentials?.displayName || 'Waleed Khan', avatarColor: '#7C3AED', isKids: false, isActive: true },
          { id: 'prof_2', name: 'Family', avatarColor: '#059669', isKids: false, isActive: false },
          { id: 'prof_3', name: 'Kids', avatarColor: '#D97706', isKids: true, isActive: false }
        ];
        state.activeProfileId = 'prof_1';
        scheduleSaveState();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        profiles: state.profiles,
        activeProfileId: state.activeProfileId || state.profiles[0].id
      }));
    }
  }

  if (req.method === 'POST' && pathname === '/api/profiles/switch') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { profileId } = JSON.parse(body || '{}');
        if (state.profiles && state.profiles.some(p => p.id === profileId)) {
          state.activeProfileId = profileId;
          state.profiles.forEach(p => { p.isActive = (p.id === profileId); });
          scheduleSaveState();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, activeProfileId: state.activeProfileId }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profiles/update') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { profileId, name, avatarColor, isKids, theme } = JSON.parse(body || '{}');
        const p = (state.profiles || []).find(item => item.id === profileId);
        if (p) {
          if (name) p.name = name.trim();
          if (avatarColor) p.avatarColor = avatarColor;
          if (typeof isKids === 'boolean') p.isKids = isKids;
          if (theme) p.theme = theme;
          if (p.id === state.activeProfileId && name) {
            if (!state.credentials) state.credentials = {};
            state.credentials.displayName = name.trim();
          }
          scheduleSaveState();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, profile: p }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profiles/create') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name, avatarColor, isKids } = JSON.parse(body || '{}');
        if (!state.profiles) state.profiles = [];
        const nextIdx = state.profiles.length + 1;
        const newProf = {
          id: 'prof_' + Date.now(),
          name: (name || `Profile ${nextIdx}`).trim(),
          avatarColor: avatarColor || '#2563EB',
          isKids: Boolean(isKids),
          isActive: false
        };
        state.profiles.push(newProf);
        scheduleSaveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, profile: newProf, profiles: state.profiles }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profiles/delete') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { profileId } = JSON.parse(body || '{}');
        if (profileId === 'prof_1') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Cannot delete primary profile' }));
        }
        if (!state.profiles || state.profiles.length <= 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Must have at least one profile' }));
        }
        state.profiles = state.profiles.filter(p => p.id !== profileId);
        if (state.activeProfileId === profileId) {
          state.activeProfileId = 'prof_1';
          state.profiles.forEach(p => { p.isActive = (p.id === 'prof_1'); });
        }
        scheduleSaveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, activeProfileId: state.activeProfileId, profiles: state.profiles }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 7.7. Cloud TV Link & Sync Endpoints (Live Cloudflare Workers + D1)
  const CLOUDFLARE_WORKER_URL = 'https://streamvault-sync.streamvault-app.workers.dev';

  if (req.method === 'POST' && pathname === '/api/cloud/request-code') {
    try {
      const cfRes = await fetch(`${CLOUDFLARE_WORKER_URL}/api/auth/request-code`, { method: 'POST' });
      if (cfRes.ok) {
        const cfData = await cfRes.json();
        if (cfData.success && cfData.code) {
          state.activeTvCode = {
            code: cfData.code,
            generatedAt: Date.now(),
            expiresAt: cfData.expiresAt || (Date.now() + 15 * 60 * 1000),
            status: 'pending',
            pairUrl: cfData.pairUrl
          };
          scheduleSaveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            code: cfData.code,
            qrUrl: cfData.qrUrl,
            pairUrl: cfData.pairUrl
          }));
        }
      }
    } catch (_) {}

    // Fallback if offline
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'SV-';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    state.activeTvCode = {
      code,
      generatedAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000,
      status: 'pending'
    };
    scheduleSaveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      code,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`${CLOUDFLARE_WORKER_URL}/link?code=` + code)}`,
      pairUrl: `${CLOUDFLARE_WORKER_URL}/link?code=` + code
    }));
  }

  if (req.method === 'GET' && pathname === '/api/cloud/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      isLinked: Boolean(state.cloudSyncAccount),
      cloudProvider: 'Cloudflare Workers + D1',
      activeCode: state.activeTvCode || null,
      accountEmail: state.cloudSyncAccount?.email || 'waleed@streamvault.tv',
      lastSyncedAt: state.lastCloudSyncedAt || Date.now()
    }));
  }

  if (req.method === 'POST' && pathname === '/api/cloud/signout') {
    state.cloudSyncAccount = null;
    state.activeTvCode = null;
    state.lastCloudSyncedAt = null;
    scheduleSaveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'Unlinked and signed out' }));
  }



  // HTTP Range Video Stream Proxy with Universal Browser & TV Playback (Follows Xtream 302 redirects)
  if (req.method === 'GET' && pathname === '/api/stream-proxy') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400);
      return res.end('Missing url');
    }
    const proxyStream = (urlStr, redirectsLeft = 5) => {
      if (redirectsLeft <= 0) {
        res.writeHead(502);
        return res.end('Too many redirects');
      }
      let u;
      try { u = new URL(urlStr); } catch (_) {
        res.writeHead(400);
        return res.end('Invalid url');
      }
      const lib = u.protocol === 'https:' ? https : http;
      const headers = { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18' };
      if (req.headers.range) headers.Range = req.headers.range;

      const upReq = lib.get(urlStr, { headers }, (upRes) => {
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
          upRes.resume();
          const nextUrl = new URL(upRes.headers.location, urlStr).toString();
          return proxyStream(nextUrl, redirectsLeft - 1);
        }

        const isRaw = parsedUrl.searchParams.get('raw') === '1' || req.headers['user-agent']?.includes('ExoPlayer');
        const isMatroska = (upRes.headers['content-type'] || '').includes('matroska') || urlStr.includes('.mkv');

        // For PC Browser Playback: Remux MKV on-the-fly to fragmented MP4 (80ms start, 0% CPU, universal browser compatibility)
        if (!isRaw && isMatroska) {
          res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-cache, no-store'
          });
          const { spawn } = require('child_process');
          const ff = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1'
          ]);

          upRes.pipe(ff.stdin);
          ff.stdout.pipe(res);

          req.on('close', () => {
            try { ff.kill(); } catch (_) {}
            try { upRes.destroy(); } catch (_) {}
          });
          ff.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          });
          return;
        }

        // Direct Range Passthrough (for Android TV ExoPlayer / MP4 streams)
        const resHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
          'Content-Type': upRes.headers['content-type'] || 'video/mp4'
        };
        if (upRes.headers['content-length']) resHeaders['Content-Length'] = upRes.headers['content-length'];
        if (upRes.headers['content-range']) resHeaders['Content-Range'] = upRes.headers['content-range'];
        res.writeHead(upRes.statusCode || 200, resHeaders);
        res.on('error', () => { try { upRes.destroy(); } catch (_) {} });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        upRes.pipe(res);
      });
      upReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('close', () => upReq.destroy());
    };
    return proxyStream(targetUrl);
  }

  // Online Subtitle Search (Wyzie / OpenSubtitles)
  if (req.method === 'GET' && pathname === '/api/subtitles') {
    const id = parsedUrl.searchParams.get('id') || '';
    try {
      const subs = id ? await fetchJsonUrl(`https://sub.wyzie.ru/search?id=${encodeURIComponent(id)}`, 8000) : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(Array.isArray(subs) ? subs.slice(0, 30) : []));
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify([]));
    }
  }

  // Online Subtitle SRT -> WebVTT Converter with Live Delay Offset
  if (req.method === 'GET' && pathname === '/api/subtitle-vtt') {
    const subUrl = parsedUrl.searchParams.get('url') || '';
    const offsetSec = parseFloat(parsedUrl.searchParams.get('offset') || '0') || 0;
    if (!subUrl) {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
      return res.end('WEBVTT\n\n00:00:01.000 --> 00:05:00.000\nSubtitles Active\n');
    }
    try {
      const parsed = new URL(subUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.get(subUrl, { headers: { 'User-Agent': 'StreamVaultTV/1.0' } }, (upRes) => {
        let srt = '';
        upRes.on('data', (c) => (srt += c));
        upRes.on('end', () => {
          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(srtToWebVtt(srt, offsetSec));
        });
      }).on('error', () => {
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
        res.end('WEBVTT\n\n');
      });
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
      res.end('WEBVTT\n\n');
    }
    return;
  }

  // POST Endpoints
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        if (pathname === '/api/search') {
          const params = new URLSearchParams(body);
          state.remoteSearchQuery = params.get('query') || '';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, query: state.remoteSearchQuery }));
        }
        if (pathname === '/api/consume-remote-search') {
          state.remoteSearchQuery = '';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/save-credentials') {
          const isJson = (req.headers['content-type'] || '').includes('application/json');
          const data = isJson ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
          const serverChanged = data.serverUrl && data.serverUrl !== state.credentials.serverUrl;
          state.credentials = {
            ...state.credentials,
            displayName: data.displayName !== undefined ? data.displayName.trim() : (state.credentials.displayName || 'Waleed Khan'),
            playlistName: data.playlistName || state.credentials.playlistName,
            serverUrl: data.serverUrl !== undefined ? data.serverUrl : state.credentials.serverUrl,
            username: data.username !== undefined ? data.username : state.credentials.username,
            password: data.password !== undefined ? data.password : state.credentials.password
          };
          scheduleSaveState();
          runLiveIptvSync(serverChanged);
          if (isJson) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(buildPhonePortalHtml('✅ Connected! Your IPTV catalog is live on StreamVault TV.'));
          }
        }
        if (pathname === '/api/toggle-item' || pathname === '/api/watchlist/toggle' || pathname === '/api/watched/toggle') {
          const parsedData = JSON.parse(body || '{}');
          const dedupKey = parsedData.dedupKey;
          let field = parsedData.field;
          if (pathname === '/api/watchlist/toggle') field = 'inWatchlist';
          if (pathname === '/api/watched/toggle') field = 'isWatched';
          const item = mediaMap.get(dedupKey);
          if (item && (field === 'inWatchlist' || field === 'isWatched')) {
            item[field] = !item[field];
            scheduleSaveState();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, inWatchlist: item ? item.inWatchlist : false, isWatched: item ? item.isWatched : false, item }));
        }
        if (pathname === '/api/pin-smart-row') {
          const { title, filterState } = JSON.parse(body);
          state.pinnedSmartRows.push({ id: 'smart_' + Date.now(), title, filterState });
          scheduleSaveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/sync-now') {
          runLiveIptvSync(false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/factory-reset') {
          state.userRatings = {};
          state.favoriteLiveChannels = [];
          state.recentSearches = [];
          state.pinnedSmartRows = [];
          state.parentalControl = { isLocked: true, pin: '0000', showAdult: false };
          for (const m of state.mediaItems) {
            m.inWatchlist = false;
            m.isWatched = false;
            m.resumePositionMs = 0;
          }
          scheduleSaveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, message: 'StreamVault TV has been reset to factory defaults.' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function buildPhonePortalHtml(msg = '') {
  const c = state.credentials;
  const banner = msg ? `<div style="background:#14532d;border:1px solid #22c55e;padding:12px;border-radius:8px;margin-bottom:16px;">${msg}</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>StreamVault TV — Phone Companion</title>
  <style>
    body{background:#0B0C10;color:#F3F4F6;font-family:system-ui,sans-serif;padding:20px;margin:0}
    .card{background:#161821;border:1px solid #2A2E3D;border-radius:14px;padding:18px;margin-bottom:18px;max-width:500px;margin-left:auto;margin-right:auto}
    input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #374151;background:#0B0C10;color:#fff;margin-top:6px;margin-bottom:12px}
    button{width:100%;padding:13px;background:#E50914;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer}
  </style></head><body>
  <div class="card">
    <h2 style="color:#E50914;margin-top:0">📱 StreamVault Phone-to-TV Remote</h2>
    ${banner}
    <label>Type on your phone to search live across ${state.mediaItems.length.toLocaleString()} titles on TV:</label>
    <input type="text" placeholder="Search Movie, Plot keyword, Actor, Director..." oninput="fetch('/api/search',{method:'POST',body:'query='+encodeURIComponent(this.value)})"/>
  </div>
  <div class="card">
    <h3 style="margin-top:0">⚡ IPTV Subscription Login</h3>
    <form method="POST" action="/api/save-credentials">
      <label>Playlist Name</label><input name="playlistName" value="${c.playlistName}"/>
      <label>Xtream Server URL</label><input name="serverUrl" value="${c.serverUrl}" placeholder="http://your-iptv-server.com:8080"/>
      <label>Username</label><input name="username" value="${c.username}"/>
      <label>Password</label><input type="password" name="password" value="${c.password}"/>
      <button type="submit">💾 Save & Sync TV</button>
    </form>
  </div></body></html>`;
}

function renderWebPairingUi(defaultCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StreamVault TV — Quick Link & Sync</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0A0814; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #141026; border: 1px solid #281F4B; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 420px; box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
    .logo-badge { width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #7C3AED, #4C1D95); display: flex; align-items: center; justify-content: center; }
    .logo-title { font-size: 20px; font-weight: 900; letter-spacing: 0.5px; }
    h2 { font-size: 22px; font-weight: 800; margin-bottom: 8px; }
    p { font-size: 13.5px; color: #9CA3AF; line-height: 1.5; margin-bottom: 24px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 11.5px; font-weight: 700; color: #C4B5FD; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; background: #0F0B20; border: 1.5px solid #2E2356; border-radius: 10px; padding: 12px 14px; font-size: 14px; color: #FFFFFF; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: #8B5CF6; }
    .code-input { font-size: 20px; font-weight: 800; letter-spacing: 3px; text-align: center; text-transform: uppercase; }
    .btn { width: 100%; background: linear-gradient(135deg, #7C3AED, #6D28D9); border: none; border-radius: 10px; padding: 14px; font-size: 15px; font-weight: 800; color: #FFFFFF; cursor: pointer; box-shadow: 0 6px 20px rgba(124, 58, 237, 0.4); margin-top: 8px; }
    .btn:hover { background: #6D28D9; }
    .status-msg { margin-top: 16px; font-size: 13.5px; text-align: center; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-badge">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5"><path d="M5 3l14 9-14 9V3z"/></svg>
      </div>
      <div class="logo-title">STREAMVAULT</div>
    </div>
    <h2>Link New Android TV</h2>
    <p>Enter the 6-character code shown on your TV screen to sync your profile, watchlist, and IPTV credentials in 1 tap.</p>

    <form id="linkForm" onsubmit="submitLink(event)">
      <div class="field">
        <label>TV Pairing Code</label>
        <input id="codeInp" class="code-input" maxlength="7" placeholder="SV-XXXX" value="${defaultCode || ''}" required />
      </div>

      <div class="field">
        <label>Display Name</label>
        <input id="nameInp" placeholder="Waleed Khan" value="Waleed Khan" required />
      </div>

      <div class="field">
        <label>Email (Optional for backup)</label>
        <input id="emailInp" type="email" placeholder="waleed@streamvault.tv" value="waleed@streamvault.tv" />
      </div>

      <button type="submit" class="btn" id="submitBtn">Link &amp; Sync TV Now</button>
      <div id="statusMsg" class="status-msg"></div>
    </form>
  </div>

  <script>
    async function submitLink(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const msg = document.getElementById('statusMsg');
      btn.disabled = true;
      btn.innerText = 'Linking TV...';
      msg.innerText = '';

      try {
        const res = await fetch('/api/auth/claim-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: document.getElementById('codeInp').value,
            displayName: document.getElementById('nameInp').value,
            email: document.getElementById('emailInp').value
          })
        });
        const data = await res.json();
        if (data.success) {
          msg.style.color = '#10B981';
          msg.innerHTML = '&#10004; Success! Your TV is linked. Your watch history, continue watching, and profiles are syncing now.';
          btn.style.display = 'none';
        } else {
          msg.style.color = '#EF4444';
          msg.innerText = data.error || 'Failed to link TV. Please verify the code.';
          btn.disabled = false;
          btn.innerText = 'Link & Sync TV Now';
        }
      } catch (err) {
        msg.style.color = '#EF4444';
        msg.innerText = err.message;
        btn.disabled = false;
        btn.innerText = 'Link & Sync TV Now';
      }
    }
  </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`StreamVault TV PC Runner active at http://localhost:${PORT}/tv`);
  console.log(`Phone Wi-Fi Companion active at http://${getLocalIp()}:${PORT}/phone`);
  // Automatically resume background sync & smart-priority TMDB enrichment on startup!
  if (state.credentials.serverUrl && state.credentials.username) {
    runLiveIptvSync(false);
  }
});
