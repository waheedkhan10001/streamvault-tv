'use strict';
// StreamVault - Count my titles
// Reads your IPTV provider's lists and applies the SAME title-cleaning and merging rules the TV app uses
// (copied from TitleParser.kt / CatalogSyncEngine.kt / StreamVaultDatabase.kt), then writes a short summary.
// Your login is typed here, used only to talk to your provider, and is NEVER written to any file.

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ===================== port of TitleParser.kt =====================
const LANGUAGE_PREFIX_MAP = new Map(Object.entries({
  EN: 'English', ENG: 'English', US: 'English', UK: 'English',
  HI: 'Hindi', HIN: 'Hindi', HINDI: 'Hindi', BOLLYWOOD: 'Hindi', IND: 'Hindi', IN: 'Hindi',
  UR: 'Urdu', URDU: 'Urdu', PK: 'Urdu', PAK: 'Urdu', PUNJABI: 'Punjabi',
  AR: 'Arabic', ARA: 'Arabic', ARABIC: 'Arabic', TR: 'Turkish', TUR: 'Turkish', TURKISH: 'Turkish',
  KR: 'Korean', KOR: 'Korean', KOREAN: 'Korean', JA: 'Japanese', JP: 'Japanese', JAP: 'Japanese', ANIME: 'Japanese',
  ES: 'Spanish', ESP: 'Spanish', LAT: 'Spanish', SPA: 'Spanish', FR: 'French', FRE: 'French', VF: 'French',
  DE: 'German', GER: 'German', IT: 'Italian', ITA: 'Italian', PT: 'Portuguese', BR: 'Portuguese',
  RU: 'Russian', PL: 'Polish', NL: 'Dutch', FA: 'Persian', IR: 'Persian',
  TA: 'Tamil', TAMIL: 'Tamil', TE: 'Telugu', TELUGU: 'Telugu', ML: 'Malayalam', MULTI: 'Multi-Audio', DUAL: 'Multi-Audio'
}));
const LANG_CAT_REGEXES = [...LANGUAGE_PREFIX_MAP.entries()].map(([code, lang]) =>
  [new RegExp('(^|[\\s|\\[\\-_:])' + code + '([\\s|\\]\\-_:]|$)'), lang]);

const GENRE_KEYWORDS_IN_FOLDER = Object.entries({
  action: 'Action', adventure: 'Adventure', animat: 'Animation', anime: 'Animation', kids: 'Family', children: 'Family',
  family: 'Family', disney: 'Family', pixar: 'Animation', comedy: 'Comedy', standup: 'Comedy', 'stand-up': 'Comedy',
  crime: 'Crime', mafia: 'Crime', documentary: 'Documentary', docu: 'Documentary', nature: 'Documentary', drama: 'Drama',
  fantasy: 'Fantasy', history: 'History', biograph: 'History', horror: 'Horror', scary: 'Horror', music: 'Music',
  mystery: 'Mystery', romance: 'Romance', romantic: 'Romance', 'sci-fi': 'Sci-Fi', scifi: 'Sci-Fi',
  'science fiction': 'Sci-Fi', marvel: 'Action', 'dc ': 'Action', superhero: 'Action', thriller: 'Thriller',
  suspense: 'Thriller', war: 'War', western: 'Western'
});

const YEAR_G = /(?:^|[\s(\[._-])((?:19[2-9]\d|20[0-2]\d))(?:[\s)\]._-]|$)/g;
const YEAR_1 = /(?:^|[\s(\[._-])((?:19[2-9]\d|20[0-2]\d))(?:[\s)\]._-]|$)/;
const BRACKET_TAG = /\[([^\]]+)\]|\|([^|]+)\|/g;
const LEADING_PREFIX = /^\s*(?:\|?([A-Za-z]{2,10})\|?\s*([-:|])\s*)+/;
const COLON_AMBIGUOUS = new Set(['IT', 'IN', 'US', 'UK', 'BR', 'DE', 'PL', 'ML', 'TA', 'TE', 'FA', 'IR', 'AR', 'ES']);
const QUALITY_NOISE = /\b(4K|UHD|2160p|FHD|1080p|HD|720p|480p|HEVC|x265|H\.?265|x264|H\.?264|HDR|HDR10|DV|Dolby\s*Vision|BluRay|WEB-?DL|WEBRip|BRRip|HDTS|CAM|MULTI-?SUB|ESUB|E-?SUB|SUBBED|DUBBED|DUAL\s*AUDIO|MULTI\s*AUDIO)\b/gi;

const Q_4K = /(?<![A-Z0-9])(4K|UHD|2160P)(?![A-Z0-9])/;
const Q_1080 = /(?<![A-Z0-9])(1080P|FHD)(?![A-Z0-9])/;
const Q_720 = /(?<![A-Z0-9])720P(?![A-Z0-9])/;
const Q_HEVC = /(?<![A-Z0-9])(HEVC|X265|H\.?265)(?![A-Z0-9])/;
const Q_HDR = /(?<![A-Z0-9])(HDR10?|DOLBY\s*VISION|DV)(?![A-Z0-9])/;
const Q_MULTI_AUDIO = /(?<![A-Z0-9])(DUAL[\s-]*AUDIO|MULTI[\s-]*AUDIO|DUAL)(?![A-Z0-9])/;
const SUB_MULTI = /(?<![A-Z0-9])MULTI[\s-]?SUBS?(?![A-Z0-9])/;
const SUB_ENGLISH = /(?<![A-Z0-9])(E-?SUBS?|ENG(LISH)?[\s-]*SUBS?)(?![A-Z0-9])/;
const SUB_ANY = /(?<![A-Z0-9])(SUBS|SUBBED|SUBTITLED)(?![A-Z0-9])/;

function extractQualityAndSub(upper, qualities) {
  if (Q_4K.test(upper)) qualities.add('4K');
  if (Q_1080.test(upper)) qualities.add('1080p');
  else if (Q_720.test(upper)) qualities.add('720p');
  if (Q_HEVC.test(upper)) qualities.add('HEVC');
  if (Q_HDR.test(upper)) qualities.add('HDR');
  if (Q_MULTI_AUDIO.test(upper)) qualities.add('Multi-Audio');
  if (SUB_MULTI.test(upper)) return 'Multi-Sub';
  if (SUB_ENGLISH.test(upper)) return 'English Sub';
  if (SUB_ANY.test(upper)) return 'Subtitled';
  return null;
}

function javaHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }

function parse(rawTitle, categoryName = '', tmdbId = 0) {
  let working = rawTitle.trim();
  let detectedLanguage = null;
  const qualities = new Set();
  let subtitleHint = '';
  const upperCat = categoryName.toUpperCase();
  for (const [re, lang] of LANG_CAT_REGEXES) { if (re.test(upperCat)) { detectedLanguage = lang; break; } }
  const inferredGenres = [];
  const lowerCat = categoryName.toLowerCase();
  for (const [kw, genre] of GENRE_KEYWORDS_IN_FOLDER) { if (lowerCat.includes(kw) && !inferredGenres.includes(genre)) inferredGenres.push(genre); }

  working = working.replace(/\[\s*((?:19[2-9]\d|20[0-2]\d))\s*\]/g, ' ($1) ');

  for (const m of working.matchAll(BRACKET_TAG)) {
    const token = ((m[1] !== undefined ? m[1] : m[2]) || '').trim().toUpperCase();
    if (LANGUAGE_PREFIX_MAP.has(token)) detectedLanguage = LANGUAGE_PREFIX_MAP.get(token);
    const s = extractQualityAndSub(token, qualities);
    if (s) subtitleHint = s;
  }
  working = working.replace(BRACKET_TAG, ' ');

  const pm = LEADING_PREFIX.exec(working);
  if (pm) {
    const token = (pm[1] || '').trim().toUpperCase();
    const sep = pm[2] || '';
    const colonOnWord = sep === ':' && COLON_AMBIGUOUS.has(token);
    if (LANGUAGE_PREFIX_MAP.has(token) && !colonOnWord) {
      detectedLanguage = LANGUAGE_PREFIX_MAP.get(token);
      working = working.substring(pm.index + pm[0].length);
    }
  }

  let extractedYear = 0;
  const yearMatches = [...working.matchAll(YEAR_G)];
  if (yearMatches.length > 0) {
    const last = yearMatches[yearMatches.length - 1];
    extractedYear = parseInt(last[1], 10) || 0;
    const idx = last.index;
    if (idx > 2) working = working.substring(0, idx);
  } else {
    const cm = YEAR_1.exec(categoryName);
    if (cm) extractedYear = parseInt(cm[1], 10) || 0;
  }

  const s5 = extractQualityAndSub(rawTitle.toUpperCase(), qualities);
  if (s5 && !subtitleHint) subtitleHint = s5;

  working = working.replace(QUALITY_NOISE, ' ');
  working = working.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/_/g, ' ').replace(/\s+[-:|]\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  if (working === '') working = rawTitle.trim();

  const finalLanguage = detectedLanguage || 'English';
  const normalized = working.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let dedupKey;
  if (tmdbId > 0) dedupKey = 'tmdb:' + tmdbId;
  else if (extractedYear > 0 && normalized.length >= 2) dedupKey = 'title:' + normalized + ':' + extractedYear;
  else if (normalized.length >= 2) dedupKey = 'title:' + normalized;
  else dedupKey = 'raw:' + javaHash(rawTitle);
  return { cleanTitle: working, year: extractedYear, language: finalLanguage, qualityBadges: qualities.size ? [...qualities] : ['HD'], subtitleHint, inferredGenres, dedupKey, normalized };
}

// ===================== port of the adult / extras rules (StreamVaultDatabase.kt) =====================
const ADULT_TOKENS = ['xxx', '18+', 'adult', 'porn', 'erotic', 'nsfw', 'redhat', 'team skeet', 'brazzers', 'playboy', 'hustler', 'penthouse', 'bangbros', 'naughty'];
function checkIsAdult(cleanTitle, rawTitle, categoryName, genresText) {
  const text = (cleanTitle + ' ' + rawTitle + ' ' + categoryName + ' ' + genresText).toLowerCase();
  return ADULT_TOKENS.some((t) => text.includes(t));
}
const EXTRA_TOKENS = ['naat', 'islamic', 'dance |', 'dance mix', 'stage drama', 'dasi muj', 'songs |', 'explained movies', 'motu patlu',
  'chacha bhatija', 'vir: the robot boy', 'chhota bheem', 'tom & jerry', 'scooby-doo', 'wwe', '24/7 dance', 'vibe stage drama', 'cartoon kids'];
function checkIsExtra(categoryName) {
  const c = (categoryName || '').toLowerCase();
  if (!c.trim()) return false;
  return EXTRA_TOKENS.some((t) => c.includes(t));
}

// ===================== download =====================
function redact(msg, secret) { return secret ? String(msg).split(secret).join('***') : String(msg); }

function getJson(urlStr, secret, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = lib.get(u, { headers: { 'User-Agent': 'okhttp/4.12.0', 'Accept-Encoding': 'gzip', 'Accept': '*/*' }, timeout: 600000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, u).toString(), secret, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('The provider answered with code ' + res.statusCode + (res.statusCode === 403 ? ' (it refused this request)' : '')));
      }
      const chunks = [];
      let wire = 0;
      res.on('data', (c) => { chunks.push(c); wire += c.length; });
      res.on('end', () => {
        try {
          let buf = Buffer.concat(chunks);
          if ((res.headers['content-encoding'] || '').includes('gzip')) buf = zlib.gunzipSync(buf);
          const secs = (Date.now() - t0) / 1000;
          resolve({ data: JSON.parse(buf.toString('utf8')), wireBytes: wire, rawBytes: buf.length, secs });
        } catch (e) { reject(new Error('The answer could not be read: ' + redact(e.message, secret))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('The provider took too long to answer')); });
    req.on('error', (e) => reject(new Error(redact(e.message, secret))));
  });
}

function ask(rl, q, def) {
  return new Promise((res) => rl.question(q + (def ? ' [' + def + ']' : '') + ': ', (a) => res((a || '').trim() || def || '')));
}

// ===================== analysis =====================
const fmt = (n) => Number(n).toLocaleString('en-US');
const MB = (b) => (b / 1048576).toFixed(1);

// Mirrors CatalogSyncEngine.streamAndSaveMedia + StreamVaultDatabase.foldLooseDuplicates
function analyse(entries, catMap, idField) {
  const main = new Map();
  const vault = new Map();
  let withTmdb = 0;
  const now = Math.floor(Date.now() / 1000);
  let added1 = 0, added7 = 0, added14 = 0, starMarked = 0;
  for (const e of entries) {
    const streamId = String(e[idField] ?? '');
    const name = String(e.name ?? e.title ?? '');
    if (!streamId || !name) continue;
    const catName = catMap.get(String(e.category_id)) || 'Movies';
    const tmdb = parseInt(e.tmdb ?? e.tmdb_id ?? 0, 10) || 0;
    if (tmdb > 0) withTmdb++;
    const added = parseInt(e.added ?? e.last_modified ?? 0, 10) || 0;
    if (added > 0) { const age = now - added; if (age <= 86400) added1++; if (age <= 7 * 86400) added7++; if (age <= 14 * 86400) added14++; }
    if (/\*\s*$/.test(name)) starMarked++;
    const p = parse(name, catName, tmdb);
    const genreStr = String(e.genre ?? '');
    const serverGenres = genreStr.split(/[,\/|]/).map((x) => x.trim()).filter(Boolean);
    const combined = [...new Set([...serverGenres, ...p.inferredGenres])];
    const adult = checkIsAdult(p.cleanTitle, name, catName, combined.join(' '));
    const extra = checkIsExtra(catName);
    const target = (adult || extra) ? vault : main;
    let g = target.get(p.dedupKey);
    if (!g) { g = { key: p.dedupKey, raw: name, clean: p.cleanTitle, year: p.year, norm: p.normalized, tmdb, copies: 0, adult: false, cat: catName, cats: new Set() }; target.set(p.dedupKey, g); }
    g.copies++; g.adult = g.adult || adult; g.cats.add(catName);
    if (!g.tmdb && tmdb) g.tmdb = tmdb;
  }
  // fold loose duplicates into tmdb rows (same rule as the app), per map
  let folded = 0; let foldCollisions = [];
  function fold(map) {
    const tmap = new Map();
    for (const g of map.values()) {
      if (!g.key.startsWith('tmdb:')) continue;
      const pk = parse(g.raw, g.cat).dedupKey;
      if (tmap.has(pk) && tmap.get(pk) !== g.key) foldCollisions.push([pk, tmap.get(pk), g.key, g.raw]);
      tmap.set(pk, g.key);
    }
    for (const g of [...map.values()]) {
      if (g.key.startsWith('tmdb:')) continue;
      const t = tmap.get(g.key);
      if (t && map.has(t)) { map.get(t).copies += g.copies; map.delete(g.key); folded++; }
    }
  }
  fold(main); fold(vault);
  return { main, vault, rawCount: entries.length, withTmdb, added1, added7, added14, starMarked, folded, foldCollisions };
}

function buckets(map) {
  const b = { '1 copy': 0, '2 copies': 0, '3 copies': 0, '4-5 copies': 0, '6-10 copies': 0, 'more than 10': 0 };
  for (const g of map.values()) {
    const c = g.copies;
    if (c === 1) b['1 copy']++; else if (c === 2) b['2 copies']++; else if (c === 3) b['3 copies']++;
    else if (c <= 5) b['4-5 copies']++; else if (c <= 10) b['6-10 copies']++; else b['more than 10']++;
  }
  return b;
}

// Risky merges: loose titles WITHOUT a year that match several different films that DO have ids/years
function riskChecks(main) {
  const byNorm = new Map(); // normalised title -> set of distinct years / ids among rows that know them
  for (const g of main.values()) {
    if (g.key.startsWith('title:') && g.year === 0) continue;
    const k = g.norm || g.clean.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!byNorm.has(k)) byNorm.set(k, new Set());
    byNorm.get(k).add(g.key);
  }
  const noYear = []; const riskyNoYear = []; const looseDupes = [];
  for (const g of main.values()) {
    if (!g.key.startsWith('title:') || g.year !== 0) continue;
    noYear.push(g);
    const others = byNorm.get(g.norm);
    if (others && others.size >= 2) riskyNoYear.push([g, others.size]);
    else if (others && others.size === 1) looseDupes.push(g);
  }
  // same normalised title appearing under several different keys that carry years/ids = possible remakes (fine) or duplicates (not merged)
  let multiKeyTitles = 0;
  for (const s of byNorm.values()) if (s.size >= 2) multiKeyTitles++;
  return { noYear, riskyNoYear, looseDupes, multiKeyTitles };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let server = process.env.SV_SERVER || '';
  let user = process.env.SV_USER || '';
  let pass = process.env.SV_PASS || '';
  console.log('\nStreamVault - Count my titles');
  console.log('Your login is used only to read your provider\'s lists. It is never saved to any file.\n');
  if (!server) server = await ask(rl, 'Server address', 'http://aadiflix.online:8080');
  if (!user) user = await ask(rl, 'Username');
  if (!pass) pass = await ask(rl, 'Password');
  rl.close();
  server = server.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(server)) server = 'http://' + server;
  const base = server + '/player_api.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);

  const timings = [];
  async function fetchList(action, label) {
    process.stdout.write('Reading ' + label + ' ... ');
    const r = await getJson(base + '&action=' + action, pass);
    const arr = Array.isArray(r.data) ? r.data : [];
    console.log(fmt(arr.length) + ' entries, ' + MB(r.wireBytes) + ' MB downloaded in ' + r.secs.toFixed(1) + ' s');
    timings.push({ label, wire: r.wireBytes, raw: r.rawBytes, secs: r.secs, n: arr.length });
    return arr;
  }
  const catMapOf = (arr) => new Map(arr.map((c) => [String(c.category_id), String(c.category_name ?? '')]));

  let vodCats, vod, serCats, ser, liveCats, live;
  try {
    vodCats = await fetchList('get_vod_categories', 'movie categories');
    vod = await fetchList('get_vod_streams', 'movies');
    serCats = await fetchList('get_series_categories', 'series categories');
    ser = await fetchList('get_series', 'series');
    liveCats = await fetchList('get_live_categories', 'live categories');
    live = await fetchList('get_live_streams', 'live channels');
  } catch (e) {
    console.log('\nCould not read the list: ' + redact(e.message, pass));
    console.log('Please tell Claude exactly this message.');
    process.exitCode = 1;
    return;
  }

  console.log('\nApplying the app\'s own rules ... (this can take a minute)');
  const M = analyse(vod, catMapOf(vodCats), 'stream_id');
  const S = analyse(ser, catMapOf(serCats), 'series_id');
  const mainM = M.main.size, mainS = S.main.size;
  const adultM = [...M.vault.values()].filter((g) => g.adult).length, extraM = M.vault.size - adultM;
  const adultS = [...S.vault.values()].filter((g) => g.adult).length, extraS = S.vault.size - adultS;
  const risk = riskChecks(M.main);

  const L = [];
  const add = (s = '') => L.push(s);
  add('STREAMVAULT TITLE COUNT  (' + new Date().toISOString().slice(0, 10) + ')');
  add('No login is stored in this file.');
  add('');
  add('== WHAT THE PROVIDER LISTS ==');
  add('Movie entries: ' + fmt(M.rawCount) + '   in ' + fmt(vodCats.length) + ' categories');
  add('Series entries: ' + fmt(S.rawCount) + '   in ' + fmt(serCats.length) + ' categories');
  add('Live channels: ' + fmt(live.length) + '   in ' + fmt(liveCats.length) + ' categories');
  add('Movie entries that carry a TMDB id: ' + fmt(M.withTmdb) + ' (' + (100 * M.withTmdb / Math.max(1, M.rawCount)).toFixed(0) + '%)');
  add('Series entries that carry a TMDB id: ' + fmt(S.withTmdb) + ' (' + (100 * S.withTmdb / Math.max(1, S.rawCount)).toFixed(0) + '%)');
  add('');
  add('== AFTER THE APP\'S OWN MERGING (same title = one card with several versions) ==');
  add('MOVIES  mainstream: ' + fmt(mainM) + '   Adult: ' + fmt(adultM) + '   Extras: ' + fmt(extraM) + '   (merged away: ' + fmt(M.rawCount - mainM - M.vault.size) + ' copies)');
  add('SERIES  mainstream: ' + fmt(mainS) + '   Adult: ' + fmt(adultS) + '   Extras: ' + fmt(extraS) + '   (merged away: ' + fmt(S.rawCount - mainS - S.vault.size) + ' copies)');
  add('MAINSTREAM TOTAL (movies + series): ' + fmt(mainM + mainS) + '     <-- compare with the number your TV showed (15,331)');
  add('Duplicates folded into a TMDB-id title: movies ' + fmt(M.folded) + ', series ' + fmt(S.folded));
  add('Entries whose name ends with "*": ' + fmt(M.starMarked + S.starMarked));
  add('');
  add('== HOW MANY COPIES PER MOVIE (mainstream) ==');
  const bk = buckets(M.main);
  for (const k of Object.keys(bk)) add('  ' + k + ': ' + fmt(bk[k]));
  const top = [...M.main.values()].sort((a, b) => b.copies - a.copies).slice(0, 8);
  add('Titles with the most copies:');
  for (const g of top) add('  ' + g.copies + ' x  ' + g.clean + (g.year ? ' (' + g.year + ')' : ''));
  add('');
  add('== IS MERGING SAFE? (mainstream movies) ==');
  add('Titles with NO year (merged by name only): ' + fmt(risk.noYear.length));
  add('  of which the same name also exists with a year/id (possible remakes mixed together): ' + fmt(risk.riskyNoYear.length));
  add('  of which the same name exists once with a year/id (probably the same film, not merged): ' + fmt(risk.looseDupes.length));
  add('Names that exist under 2 or more different year/id titles (normal for remakes): ' + fmt(risk.multiKeyTitles));
  add('Merge collisions (two different TMDB-id titles with the same cleaned name): ' + fmt(M.foldCollisions.length + S.foldCollisions.length));
  add('Examples of no-year titles that could mix remakes:');
  for (const [g, n] of risk.riskyNoYear.slice(0, 12)) add('  ' + g.clean + '  (' + g.copies + ' copies, same name used by ' + n + ' other titles)');
  add('Examples of merge collisions:');
  for (const c of [...M.foldCollisions, ...S.foldCollisions].slice(0, 8)) add('  ' + c[3] + '  (' + c[1] + ' vs ' + c[2] + ')');
  add('');
  add('== DAILY CHECK ==');
  add('Movies added in the last 24 hours: ' + fmt(M.added1) + ', 7 days: ' + fmt(M.added7) + ', 14 days: ' + fmt(M.added14));
  add('Series updated in the last 24 hours: ' + fmt(S.added1) + ', 7 days: ' + fmt(S.added7) + ', 14 days: ' + fmt(S.added14));
  const t = timings.reduce((a, x) => ({ wire: a.wire + x.wire, raw: a.raw + x.raw, secs: a.secs + x.secs }), { wire: 0, raw: 0, secs: 0 });
  add('Downloading all lists: ' + MB(t.wire) + ' MB over the wire (' + MB(t.raw) + ' MB unpacked) in ' + t.secs.toFixed(0) + ' seconds');
  for (const x of timings) add('   ' + x.label + ': ' + fmt(x.n) + ' entries, ' + MB(x.wire) + ' MB, ' + x.secs.toFixed(1) + ' s');
  add('');
  add('== WHAT THIS MEANS FOR ENRICHMENTS (estimates built on measured poster sizes) ==');
  const U = mainM + mainS;
  add('Unique mainstream titles (movies + series): ' + fmt(U));
  add('Sharper posters at 44.7 KB average: ' + (U * 44.7 / 1048576).toFixed(2) + ' GB   ->  about ' + ((U * 44.7 / 1024) / 3 / 60).toFixed(1) + ' minutes at 3 MB/s');
  add('Database at about 0.7 to 1 KB per title (guess, not measured): ' + (U * 0.7 / 1024).toFixed(0) + ' to ' + (U * 1.0 / 1024).toFixed(0) + ' MB');
  add('');
  // ---- Extras breakdown: which categories the app hides as "Extras", and which rule hid them ----
  function extrasBreakdown(entries, catMap, label) {
    const perCat = new Map();
    for (const e of entries) {
      const cn = catMap.get(String(e.category_id)) || '';
      if (!checkIsExtra(cn)) continue;
      const name = String(e.name ?? '');
      if (checkIsAdult(name, name, cn, String(e.genre ?? ''))) continue; // adult stays unnamed
      const rule = EXTRA_TOKENS.find((t) => cn.toLowerCase().includes(t));
      const k = cn + '\u0001' + rule;
      perCat.set(k, (perCat.get(k) || 0) + 1);
    }
    const rows = [...perCat.entries()].map(([k, n]) => { const [c, r] = k.split('\u0001'); return { c, r, n }; }).sort((a, b) => b.n - a.n);
    add('');
    add('== EXTRAS: ' + label + ' categories hidden as Extras (not adult) ==');
    add('Total entries: ' + fmt(rows.reduce((a, x) => a + x.n, 0)) + ' in ' + rows.length + ' categories');
    const byRule = new Map();
    for (const x of rows) byRule.set(x.r, (byRule.get(x.r) || 0) + x.n);
    add('By rule: ' + [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => '"' + r + '"=' + fmt(n)).join(', '));
    for (const x of rows.slice(0, 60)) add('  ' + fmt(x.n) + ' x  ' + x.c + '   [rule: ' + x.r + ']');
    if (rows.length > 60) add('  ... and ' + (rows.length - 60) + ' more small categories');
  }
  extrasBreakdown(vod, catMapOf(vodCats), 'MOVIE');
  extrasBreakdown(ser, catMapOf(serCats), 'SERIES');
  // ---- biggest mainstream categories, so we see where the 51k come from ----
  add('');
  add('== BIGGEST MOVIE CATEGORIES (mainstream, entries) ==');
  const cc = new Map();
  for (const e of vod) { const cn = (catMapOf(vodCats).get(String(e.category_id)) || '?'); if (checkIsExtra(cn)) continue; cc.set(cn, (cc.get(cn) || 0) + 1); }
  for (const [c, n] of [...cc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) { if (!/xxx|18\+|adult|porn/i.test(c)) add('  ' + fmt(n) + ' x  ' + c); }
  add('Adult and Extras titles are not counted above because they are never sent to TMDB or the cloud.');

  const out = L.join('\n');
  console.log('\n' + out);
  const file = path.join(__dirname, 'streamvault-count-summary.txt');
  fs.writeFileSync(file, out + '\n', 'utf8');
  console.log('\nSaved: ' + file);
}

if (require.main === module) {
  main().catch((e) => { console.log('Something went wrong: ' + e.message); process.exitCode = 1; });
}
module.exports = { parse, checkIsAdult, checkIsExtra, analyse, EXTRA_TOKENS, getJson, redact };
