/**
 * StreamVault TV — Local PC Runner & Companion Server (Zero-Dependency Node.js)
 *
 * Mirrors the exact Android TV SQLite/Xtream/TMDB/Wyzie architecture so you can
 * test 100% of StreamVault TV locally on your Windows PC screen (with keyboard
 * arrow keys Acting as your TCL TV remote + mouse) before beaming the APK over
 * Wi-Fi to your TCL 55P635 TV.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = 8765;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'streamvault_pc_db.json');
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';

// Default database state with rich showcase catalog pre-seeded
let state = {
  credentials: {
    playlistName: 'My IPTV',
    serverUrl: '',
    username: '',
    password: '',
    tmdbApiKey: DEFAULT_TMDB_KEY,
    preferredLanguages: ['English', 'Hindi', 'Urdu', 'Multi-Audio'],
    hiddenLanguages: [],
    preferredSubtitleLanguages: ['en', 'ur', 'hi', 'ar']
  },
  syncStatus: {
    isSyncing: false,
    phase: 'Showcase Mode Ready (Enter IPTV Login in QR & Sync tab to load your live provider)',
    newlyAddedCount: 0,
    enrichedCount: 7,
    totalToEnrich: 7,
    lastSyncTimestamp: 0
  },
  remoteSearchQuery: '',
  recentSearches: ['Christopher Nolan', 'Dune', 'Sci-Fi'],
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
      id: 'smart_recent_action_2020',
      title: '2020s Action & Adventure Hits',
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
  mediaItems: getInitialShowcaseCatalog(),
  liveChannels: [
    { streamId: 'live1', name: 'BBC World News HD', categoryName: 'News', currentProgramTitle: 'World News Today', nextProgramTitle: 'The Context', isFavorite: true },
    { streamId: 'live2', name: 'Sky Sports Main Event 4K', categoryName: 'Sports', currentProgramTitle: 'Premier League Live', nextProgramTitle: 'Post-Match Analysis', isFavorite: true },
    { streamId: 'live3', name: 'HBO Cinema HD', categoryName: 'Movies Live', currentProgramTitle: 'Dune: Part Two', nextProgramTitle: 'The Last of Us', isFavorite: false },
    { streamId: 'live4', name: 'Geo News HD', categoryName: 'Pakistan / Urdu', currentProgramTitle: 'Prime Time Headlines', nextProgramTitle: 'Capital Talk', isFavorite: false }
  ]
};

if (fs.existsSync(DB_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    state = { ...state, ...saved };
  } catch (_) {}
}

function saveState() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

function getInitialShowcaseCatalog() {
  return [
    {
      dedupKey: 'tmdb:693134',
      primaryStreamId: '1001',
      tmdbId: 693134,
      imdbId: 'tt15239678',
      mediaType: 'MOVIE',
      cleanTitle: 'Dune: Part Two',
      rawTitle: '|EN| [4K-HEVC] Dune: Part Two (2024) [MULTI-SUB]',
      year: 2024,
      rating: 8.4,
      voteCount: 5400,
      genres: ['Sci-Fi', 'Adventure', 'Action', 'Drama'],
      plot: 'Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen while on a warpath of revenge against the conspirators who destroyed his family.',
      cast: ['Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Javier Bardem', 'Austin Butler'],
      director: 'Denis Villeneuve',
      runtimeMins: 166,
      posterUrl: 'https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg',
      language: 'English',
      qualityBadges: ['4K', 'HEVC', 'HDR', '1080p'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English', 'Arabic', 'Spanish'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English', 'Hindi'],
      categoryName: '2024 4K UHD Releases',
      addedTimestamp: 1712000000,
      isEnriched: true,
      inWatchlist: false,
      isWatched: false,
      resumePositionMs: 1420000,
      durationMs: 9960000,
      versions: [
        { streamId: '1001', rawTitle: '|EN| [4K-HEVC] Dune: Part Two (2024) [MULTI-SUB]', languageTag: 'English', qualityTag: '4K HEVC HDR', subtitleTag: 'Multi-Sub', containerExtension: 'mkv', categoryName: '4K UHD' },
        { streamId: '1002', rawTitle: 'EN - Dune: Part Two (2024) 1080p FHD', languageTag: 'English', qualityTag: '1080p FHD', subtitleTag: 'English Sub', containerExtension: 'mp4', categoryName: '2024 Movies' },
        { streamId: '1003', rawTitle: 'HI - Dune: Part Two (2024) Dual Audio', languageTag: 'Hindi', qualityTag: '1080p Dual-Audio', subtitleTag: 'English Sub', containerExtension: 'mkv', categoryName: 'Hindi Dubbed' }
      ]
    },
    {
      dedupKey: 'tmdb:872585',
      primaryStreamId: '1004',
      tmdbId: 872585,
      imdbId: 'tt15398776',
      mediaType: 'MOVIE',
      cleanTitle: 'Oppenheimer',
      rawTitle: 'EN - Oppenheimer (2023) 4K UHD',
      year: 2023,
      rating: 8.1,
      voteCount: 8200,
      genres: ['Drama', 'History', 'Thriller'],
      plot: "The story of J. Robert Oppenheimer's role in the development of the atomic bomb during World War II.",
      cast: ['Cillian Murphy', 'Emily Blunt', 'Matt Damon', 'Robert Downey Jr.', 'Florence Pugh'],
      director: 'Christopher Nolan',
      runtimeMins: 181,
      posterUrl: 'https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg',
      language: 'English',
      qualityBadges: ['4K', '1080p'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English', 'Urdu'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English', 'Hindi'],
      categoryName: 'Oscars Winners',
      addedTimestamp: 1711000000,
      isEnriched: true,
      inWatchlist: true,
      isWatched: false,
      resumePositionMs: 0,
      durationMs: 10860000,
      versions: [
        { streamId: '1004', rawTitle: 'EN - Oppenheimer (2023) 4K UHD', languageTag: 'English', qualityTag: '4K UHD', subtitleTag: 'Multi-Sub', containerExtension: 'mkv', categoryName: '4K UHD' },
        { streamId: '1005', rawTitle: 'HI - Oppenheimer (2023) 1080p', languageTag: 'Hindi', qualityTag: '1080p', subtitleTag: 'English Sub', containerExtension: 'mp4', categoryName: 'Hindi Dubbed' }
      ]
    },
    {
      dedupKey: 'tmdb:157336',
      primaryStreamId: '1006',
      tmdbId: 157336,
      imdbId: 'tt0816692',
      mediaType: 'MOVIE',
      cleanTitle: 'Interstellar',
      rawTitle: 'EN - Interstellar (2014) [4K HEVC]',
      year: 2014,
      rating: 8.7,
      voteCount: 34000,
      genres: ['Sci-Fi', 'Drama', 'Adventure'],
      plot: 'The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel and conquer the vast distances involved in an interstellar voyage.',
      cast: ['Matthew McConaughey', 'Anne Hathaway', 'Jessica Chastain', 'Michael Caine', 'Matt Damon'],
      director: 'Christopher Nolan',
      runtimeMins: 169,
      posterUrl: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
      language: 'English',
      qualityBadges: ['4K', 'HEVC', '1080p'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English', 'Arabic'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English'],
      categoryName: '2014 Classics',
      addedTimestamp: 1710000000,
      isEnriched: true,
      inWatchlist: true,
      isWatched: false,
      resumePositionMs: 0,
      durationMs: 10140000,
      versions: [
        { streamId: '1006', rawTitle: 'EN - Interstellar (2014) [4K HEVC]', languageTag: 'English', qualityTag: '4K HEVC', subtitleTag: 'English Sub', containerExtension: 'mkv', categoryName: 'Sci-Fi Classics' }
      ]
    },
    {
      dedupKey: 'tmdb:27205',
      primaryStreamId: '1007',
      tmdbId: 27205,
      imdbId: 'tt1375666',
      mediaType: 'MOVIE',
      cleanTitle: 'Inception',
      rawTitle: 'EN - Inception (2010) 1080p BluRay',
      year: 2010,
      rating: 8.8,
      voteCount: 36000,
      genres: ['Action', 'Sci-Fi', 'Thriller', 'Adventure'],
      plot: 'Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious of his targets is offered a chance to regain his old life as payment for a task considered to be impossible: inception.',
      cast: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Ken Watanabe', 'Tom Hardy', 'Cillian Murphy'],
      director: 'Christopher Nolan',
      runtimeMins: 148,
      posterUrl: 'https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
      language: 'English',
      qualityBadges: ['1080p', '4K'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English', 'Urdu', 'Hindi'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English', 'Hindi'],
      categoryName: 'Top Rated',
      addedTimestamp: 1709000000,
      isEnriched: true,
      inWatchlist: false,
      isWatched: false,
      resumePositionMs: 0,
      durationMs: 8880000,
      versions: [
        { streamId: '1007', rawTitle: 'EN - Inception (2010) 4K HDR', languageTag: 'English', qualityTag: '4K HDR', subtitleTag: 'Multi-Sub', containerExtension: 'mkv', categoryName: '4K UHD' },
        { streamId: '1008', rawTitle: 'HI - Inception (2010) Dual Audio', languageTag: 'Hindi', qualityTag: '1080p', subtitleTag: 'English Sub', containerExtension: 'mp4', categoryName: 'Hindi Dubbed' }
      ]
    },
    {
      dedupKey: 'tmdb:155',
      primaryStreamId: '1009',
      tmdbId: 155,
      imdbId: 'tt0468569',
      mediaType: 'MOVIE',
      cleanTitle: 'The Dark Knight',
      rawTitle: 'EN - The Dark Knight (2008) [4K UHD]',
      year: 2008,
      rating: 9.0,
      voteCount: 32000,
      genres: ['Action', 'Crime', 'Drama', 'Thriller'],
      plot: 'Batman raises the stakes in his war on crime. With the help of Lt. Jim Gordon and District Attorney Harvey Dent, Batman sets out to dismantle the remaining criminal organizations that plague the streets.',
      cast: ['Christian Bale', 'Heath Ledger', 'Aaron Eckhart', 'Michael Caine', 'Gary Oldman'],
      director: 'Christopher Nolan',
      runtimeMins: 152,
      posterUrl: 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg',
      language: 'English',
      qualityBadges: ['4K', '1080p'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English', 'Hindi'],
      categoryName: '2008 Releases',
      addedTimestamp: 1708000000,
      isEnriched: true,
      inWatchlist: false,
      isWatched: false,
      resumePositionMs: 0,
      durationMs: 9120000,
      versions: [
        { streamId: '1009', rawTitle: 'EN - The Dark Knight (2008) [4K UHD]', languageTag: 'English', qualityTag: '4K UHD', subtitleTag: 'Multi-Sub', containerExtension: 'mkv', categoryName: '2008 Releases' }
      ]
    },
    {
      dedupKey: 'tmdb:98',
      primaryStreamId: '1010',
      tmdbId: 98,
      imdbId: 'tt0172495',
      mediaType: 'MOVIE',
      cleanTitle: 'Gladiator',
      rawTitle: 'EN - Gladiator (2000) Extended 4K',
      year: 2000,
      rating: 8.5,
      voteCount: 19000,
      genres: ['Action', 'Drama', 'Adventure', 'History'],
      plot: 'In the year 180, the death of emperor Marcus Aurelius throws the Roman Empire into chaos. Maximus is betrayed and reduced to slavery, rising through the gladiatorial ranks to avenge his family.',
      cast: ['Russell Crowe', 'Joaquin Phoenix', 'Connie Nielsen', 'Oliver Reed'],
      director: 'Ridley Scott',
      runtimeMins: 155,
      posterUrl: 'https://image.tmdb.org/t/p/w500/ty8TGRuvJLPUmAR1H1nRIsgwvim.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/Ar7QuJ7sJEiC0oP3I8fG8QD9uGn.jpg',
      language: 'English',
      qualityBadges: ['4K', '1080p'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English', 'Arabic'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English'],
      categoryName: '2000 Movies',
      addedTimestamp: 1707000000,
      isEnriched: true,
      inWatchlist: false,
      isWatched: false,
      resumePositionMs: 0,
      durationMs: 9300000,
      versions: [
        { streamId: '1010', rawTitle: 'EN - Gladiator (2000) Extended 4K', languageTag: 'English', qualityTag: '4K UHD', subtitleTag: 'Multi-Sub', containerExtension: 'mkv', categoryName: '2000 Movies' }
      ]
    },
    {
      dedupKey: 'tmdb:1396',
      primaryStreamId: '2001',
      tmdbId: 1396,
      imdbId: 'tt0903747',
      mediaType: 'SERIES',
      cleanTitle: 'Breaking Bad',
      rawTitle: 'EN - Breaking Bad (2008) Complete Series FHD',
      year: 2008,
      rating: 9.5,
      voteCount: 14000,
      genres: ['Crime', 'Drama', 'Thriller'],
      plot: 'Walter White, a New Mexico chemistry teacher, is diagnosed with Stage III cancer and given a prognosis of only two years left to live. He chooses to enter a dangerous world of drugs and crime.',
      cast: ['Bryan Cranston', 'Aaron Paul', 'Anna Gunn', 'Bob Odenkirk', 'Giancarlo Esposito'],
      director: 'Vince Gilligan',
      runtimeMins: 47,
      posterUrl: 'https://image.tmdb.org/t/p/w500/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
      language: 'English',
      qualityBadges: ['1080p', 'HEVC'],
      hasEmbeddedSubtitles: true,
      embeddedSubtitleLanguages: ['English', 'Spanish'],
      hasOnlineSubtitles: true,
      embeddedAudioLanguages: ['English'],
      categoryName: 'Top TV Series',
      addedTimestamp: 1706000000,
      isEnriched: true,
      inWatchlist: false,
      isWatched: false,
      resumePositionMs: 0,
      durationMs: 2820000,
      versions: [
        { streamId: '2001', rawTitle: 'EN - Breaking Bad (2008) FHD', languageTag: 'English', qualityTag: '1080p', subtitleTag: 'English Sub', containerExtension: 'mkv', categoryName: 'Crime Series' }
      ]
    }
  ];
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

function fetchJsonUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, { headers: { 'User-Agent': 'StreamVaultTV/1.0' }, timeout: 25000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJsonUrl(res.headers.location));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function parseRawIptvTitle(rawTitle, categoryName = '', tmdbId = 0) {
  let working = String(rawTitle || '').trim();
  let language = 'English';
  const langMap = {
    EN: 'English', ENG: 'English', HI: 'Hindi', HIN: 'Hindi', HINDI: 'Hindi',
    UR: 'Urdu', URDU: 'Urdu', PK: 'Urdu', AR: 'Arabic', ARA: 'Arabic',
    TR: 'Turkish', KR: 'Korean', KOR: 'Korean', ES: 'Spanish', FR: 'French',
    MULTI: 'Multi-Audio', DUAL: 'Multi-Audio'
  };
  const upperCat = String(categoryName || '').toUpperCase();
  for (const [k, v] of Object.entries(langMap)) {
    if (new RegExp(`(^|[\\s|\\[\\-_:])${k}([\\s|\\]\\-_:]|$)`).test(upperCat)) {
      language = v;
      break;
    }
  }
  const mPrefix = working.match(/^\s*\|?([A-Za-z]{2,8})\|?\s*[-:|]\s*/);
  if (mPrefix && langMap[mPrefix[1].toUpperCase()]) {
    language = langMap[mPrefix[1].toUpperCase()];
    working = working.slice(mPrefix[0].length);
  }
  working = working.replace(/\[([^\]]+)]|\|([^|]+)\|/g, ' ');
  const yearMatches = [...working.matchAll(/(?:^|[\s(\[._-])((?:19[2-9]\d|20[0-2]\d))(?:[\s)\]._-]|$)/g)];
  let year = 0;
  if (yearMatches.length > 0) {
    const last = yearMatches[yearMatches.length - 1];
    year = parseInt(last[1], 10);
    if (last.index > 2) working = working.slice(0, last.index);
  }
  const qualities = [];
  const up = String(rawTitle || '').toUpperCase();
  if (up.includes('4K') || up.includes('UHD') || up.includes('2160P')) qualities.push('4K');
  if (up.includes('1080P') || up.includes('FHD')) qualities.push('1080p');
  if (up.includes('HEVC') || up.includes('265')) qualities.push('HEVC');
  if (qualities.length === 0) qualities.push('HD');

  working = working
    .replace(/\b(4K|UHD|2160p|FHD|1080p|HD|720p|HEVC|x265|BluRay|WEB-?DL|MULTI-?SUB|DUAL\s*AUDIO)\b/gi, ' ')
    .replace(/\(\s*\)|\[\s*]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!working) working = String(rawTitle || '').trim();

  const norm = working.toLowerCase().replace(/[^a-z0-9]/g, '');
  const dedupKey = tmdbId > 0 ? `tmdb:${tmdbId}` : `title:${norm}:${year}`;
  return { cleanTitle: working, year, language, qualityBadges: qualities, dedupKey };
}

async function runLiveIptvSync() {
  const creds = state.credentials;
  if (!creds.serverUrl || !creds.username || !creds.password) return;
  if (state.syncStatus.isSyncing) return;

  try {
    state.syncStatus.isSyncing = true;
    state.syncStatus.phase = 'Connecting to Xtream IPTV Server...';
    let base = creds.serverUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    const apiBase = `${base}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

    state.syncStatus.phase = 'Downloading VOD Categories & Movies...';
    const [cats, vods] = await Promise.all([
      fetchJsonUrl(`${apiBase}&action=get_vod_categories`).catch(() => []),
      fetchJsonUrl(`${apiBase}&action=get_vod_streams`).catch(() => [])
    ]);

    const catMap = {};
    if (Array.isArray(cats)) {
      for (const c of cats) catMap[c.category_id] = c.category_name;
    }

    const existingMap = new Map(state.mediaItems.map((m) => [m.dedupKey, m]));
    const dedupMap = new Map();
    let newCount = 0;

    if (Array.isArray(vods)) {
      for (const v of vods) {
        const streamId = String(v.stream_id || '');
        const rawName = String(v.name || '');
        if (!streamId || !rawName) continue;
        const catName = catMap[v.category_id] || 'Movies';
        const tmdbId = parseInt(v.tmdb || v.tmdb_id || '0', 10) || 0;
        const parsed = parseRawIptvTitle(rawName, catName, tmdbId);
        const ver = {
          streamId,
          rawTitle: rawName,
          languageTag: parsed.language,
          qualityTag: parsed.qualityBadges.join(' '),
          subtitleTag: 'Auto-Sub',
          containerExtension: v.container_extension || 'mp4',
          categoryName: catName
        };

        const prev = dedupMap.get(parsed.dedupKey) || existingMap.get(parsed.dedupKey);
        if (!prev) {
          newCount++;
          dedupMap.set(parsed.dedupKey, {
            dedupKey: parsed.dedupKey,
            primaryStreamId: streamId,
            tmdbId,
            imdbId: '',
            mediaType: 'MOVIE',
            cleanTitle: parsed.cleanTitle,
            rawTitle: rawName,
            year: parsed.year,
            rating: parseFloat(v.rating || '0') || 0,
            voteCount: 100,
            genres: [],
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
          });
        } else {
          const hasVer = prev.versions.some((x) => x.streamId === streamId);
          if (!hasVer) prev.versions.push(ver);
          dedupMap.set(parsed.dedupKey, prev);
        }
      }
    }

    if (dedupMap.size > 0) {
      state.mediaItems = [...dedupMap.values()];
    }
    state.syncStatus.newlyAddedCount = newCount;
    state.syncStatus.totalToEnrich = state.mediaItems.length;
    state.syncStatus.isSyncing = false;
    state.syncStatus.phase = `Synced ${state.mediaItems.length} Unique Movies • Enriching via TMDB...`;
    saveState();

    enrichFromTmdbBackground();
  } catch (err) {
    state.syncStatus.isSyncing = false;
    state.syncStatus.phase = `Sync Error: ${err.message}`;
  }
}

async function enrichFromTmdbBackground() {
  const apiKey = state.credentials.tmdbApiKey || DEFAULT_TMDB_KEY;
  let enriched = state.mediaItems.filter((m) => m.isEnriched).length;
  for (const item of state.mediaItems) {
    if (item.isEnriched) continue;
    try {
      let tmdbId = item.tmdbId;
      if (!tmdbId) {
        const q = encodeURIComponent(item.cleanTitle);
        const y = item.year > 1900 ? `&year=${item.year}` : '';
        const searchRes = await fetchJsonUrl(`https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${q}${y}`);
        if (searchRes.results && searchRes.results.length > 0) {
          tmdbId = searchRes.results[0].id;
        }
      }
      if (tmdbId) {
        const det = await fetchJsonUrl(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&append_to_response=credits,external_ids`);
        item.tmdbId = tmdbId;
        item.imdbId = det.imdb_id || (det.external_ids && det.external_ids.imdb_id) || '';
        item.plot = det.overview || item.plot;
        item.rating = det.vote_average || item.rating;
        item.runtimeMins = det.runtime || 0;
        if (det.release_date) item.year = parseInt(det.release_date.slice(0, 4), 10) || item.year;
        if (Array.isArray(det.genres)) {
          item.genres = det.genres.map((g) => g.name === 'Science Fiction' ? 'Sci-Fi' : g.name);
        }
        if (det.credits) {
          if (Array.isArray(det.credits.cast)) {
            item.cast = det.credits.cast.slice(0, 7).map((c) => c.name);
          }
          if (Array.isArray(det.credits.crew)) {
            const dir = det.credits.crew.find((c) => c.job === 'Director');
            if (dir) item.director = dir.name;
          }
        }
        if (det.poster_path) item.posterUrl = `https://image.tmdb.org/t/p/w500${det.poster_path}`;
        if (det.backdrop_path) item.backdropUrl = `https://image.tmdb.org/t/p/w1280${det.backdrop_path}`;
      }
      item.isEnriched = true;
      enriched++;
      state.syncStatus.enrichedCount = enriched;
      state.syncStatus.phase = `TMDB Enriched: ${enriched} / ${state.mediaItems.length}`;
      if (enriched % 20 === 0) saveState();
      await new Promise((r) => setTimeout(r, 35));
    } catch (_) {
      item.isEnriched = true;
    }
  }
  saveState();
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

  if (req.method === 'GET' && pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ...state,
      localIpUrl: `http://${getLocalIp()}:${PORT}/phone`
    }));
  }

  if (req.method === 'GET' && pathname === '/api/subtitles') {
    const id = parsedUrl.searchParams.get('id') || '693134';
    try {
      const subs = await fetchJsonUrl(`https://sub.wyzie.ru/search?id=${encodeURIComponent(id)}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(Array.isArray(subs) ? subs.slice(0, 25) : []));
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify([
        { id: 'en1', display: 'English (Official BluRay SRT)', language: 'en', format: 'srt', url: '' },
        { id: 'ur1', display: 'Urdu (Synced SRT)', language: 'ur', format: 'srt', url: '' },
        { id: 'hi1', display: 'Hindi (Synced SRT)', language: 'hi', format: 'srt', url: '' },
        { id: 'ar1', display: 'Arabic (Synced SRT)', language: 'ar', format: 'srt', url: '' }
      ]));
    }
  }

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
          state.credentials = {
            ...state.credentials,
            playlistName: data.playlistName || state.credentials.playlistName,
            serverUrl: data.serverUrl !== undefined ? data.serverUrl : state.credentials.serverUrl,
            username: data.username !== undefined ? data.username : state.credentials.username,
            password: data.password !== undefined ? data.password : state.credentials.password,
            tmdbApiKey: data.tmdbApiKey || state.credentials.tmdbApiKey,
            hiddenLanguages: data.hiddenLanguages || state.credentials.hiddenLanguages
          };
          saveState();
          runLiveIptvSync();
          if (isJson) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(buildPhonePortalHtml('✅ Saved! Your TV is now syncing your IPTV catalog.'));
          }
        }
        if (pathname === '/api/toggle-item') {
          const { dedupKey, field } = JSON.parse(body);
          const item = state.mediaItems.find((m) => m.dedupKey === dedupKey);
          if (item && (field === 'inWatchlist' || field === 'isWatched')) {
            item[field] = !item[field];
            saveState();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, item }));
        }
        if (pathname === '/api/pin-smart-row') {
          const { title, filterState } = JSON.parse(body);
          state.pinnedSmartRows.push({
            id: 'smart_' + Date.now(),
            title,
            filterState
          });
          saveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/sync-now') {
          runLiveIptvSync();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
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
    <label>Type on your phone to search live on TV:</label>
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

server.listen(PORT, () => {
  console.log(`StreamVault TV PC Runner active at http://localhost:${PORT}/tv`);
  console.log(`Phone Wi-Fi Companion active at http://${getLocalIp()}:${PORT}/phone`);
});
