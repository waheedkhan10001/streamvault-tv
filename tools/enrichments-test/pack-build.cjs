'use strict';
// StreamVault ENRICHMENTS PACK BUILDER (development tool, runs on GitHub only, never after release).
//  1. reads the provider list, applies the app's own merging rules (Adult / Extras are never looked up or sent anywhere)
//  2. looks every mainstream title up on TMDB (provider id first, then name search; TVmaze for series TMDB does not know)
//  3. adds IMDb ratings, age ratings (US, UK, DE), extras, a name index and match confidence
//  4. downloads the posters (w342) and writes ONE pack file (see pack-format.cjs), then uploads it to Cloudflare R2
// Environment: IPTV_SERVER IPTV_USER IPTV_PASS TMDB_API_KEY, LIMIT (0 = all), POSTERS (true), UPLOAD (false),
//   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY, PACK_VERSION (optional), SELFTEST=1 (fake data, no network).
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { analyse, getJson, redact } = require('./count-my-titles.cjs');
const PF = require('./pack-format.cjs');

const SELFTEST = process.env.SELFTEST === '1';
const SERVER = (process.env.IPTV_SERVER || '').replace(/\/+$/, '');
const USER = process.env.IPTV_USER || '', PASS = process.env.IPTV_PASS || '';
const KEY = process.env.TMDB_API_KEY || '';
const LIMIT = parseInt(process.env.LIMIT || '0', 10) || 0;
const POSTERS = (process.env.POSTERS || 'true') !== 'false';
const UPLOAD = (process.env.UPLOAD || 'false') === 'true';
const CONC = parseInt(process.env.CONC || '12', 10);
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
if (!SELFTEST && (!SERVER || !USER || !PASS || !KEY)) { console.log('Missing one of IPTV_SERVER, IPTV_USER, IPTV_PASS, TMDB_API_KEY'); process.exit(1); }

const fmt = (n) => Number(n).toLocaleString('en-US');
const MB = (b) => (b / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log('[' + ((Date.now() - t0) / 60000).toFixed(1) + ' min] ' + s);
const today = new Date().toISOString().slice(0, 10);
const VERSION = process.env.PACK_VERSION || (today + '.' + new Date().toISOString().slice(11, 16).replace(':', ''));

// ---------------------------------------------------------------- TMDB
async function tmdb(p, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + p);
  u.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (r.status === 200) return await r.json();
      if (r.status === 404) return null;
      if (r.status === 429) { await sleep((parseInt(r.headers.get('retry-after') || '2', 10) + 1) * 1000); continue; }
      if (r.status >= 500) { await sleep(1000 * (a + 1)); continue; }
      return null;
    } catch (e) { await sleep(1000 * (a + 1)); }
  }
  return null;
}
async function pool(items, n, fn, every, label) {
  let i = 0, done = 0;
  async function worker() { while (i < items.length) { const k = i++; await fn(items[k], k); if (++done % every === 0) log(label + ': ' + fmt(done) + ' / ' + fmt(items.length)); } }
  await Promise.all(Array.from({ length: n }, worker));
}

// ---------------------------------------------------------------- names
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// the SAME normalisation the TV app uses for its own keys (TitleParser.kt: NFC, lower case, letters+digits only)
const appNorm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function sim(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean)), B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
const LANGS = 'hindi|tamil|telugu|malayalam|kannada|marathi|punjabi|pashto|bengali|bangla|urdu|english|gujarati|bhojpuri|dubbed|subbed|sub|subtitles|english-subbed|full|length|movie|film|hd|4k|uhd|latest|new|superhit|classic|old|awesome|comedy|thriller|romantic|action|telefilm|converted|scam|tv|netflix|voot|zee5|hotstar|amazon|prime';
const umlaut = (s) => s.replace(/ae/g, 'ä').replace(/oe/g, 'ö').replace(/ue/g, 'ü').replace(/Ae/g, 'Ä').replace(/Oe/g, 'Ö').replace(/Ue/g, 'Ü');
function variants(raw, clean, german) {
  const out = []; const add = (x) => { x = String(x || '').replace(/\s+/g, ' ').trim(); if (x.length > 1 && !out.includes(x)) out.push(x); };
  let c = String(clean || '').replace(/\*/g, ' ').replace(/^\s*[A-Z]{2,3}\s*:\s*/, '');
  c = c.split(/#EXT|https?:|tvg-/i)[0]; // leaked playlist text in a few provider names
  c = c.replace(/\((tv movie|netflix|voot|zee5|hotstar|amazon|prime|hd|scam|[^)]*movie[^)]*)\)/gi, ' ').replace(/-converted/gi, ' ').replace(/\s+S\d{1,2}$/i, ' ');
  add(c);
  const parts = c.split(/\s+[_|]+\s+|\s+-\s+/);
  if (parts.length > 1) add(parts[0]);
  const stripped = parts[0].replace(new RegExp('\\b(' + LANGS + ')\\b', 'gi'), ' ').replace(/[\[\]()]/g, ' ');
  add(stripped);
  const colon = c.split(/\s*:\s*/); if (colon.length > 1) add(colon[0]);
  add(c.replace(/'s\b/g, 's').replace(/([a-z])([A-Z])/g, '$1 $2'));
  if (german) { // German titles written with ae/oe/ue instead of ä/ö/ü
    const u = umlaut(c); if (u !== c) add(u);
    const u2 = umlaut(parts[0]); if (u2 !== parts[0]) add(u2);
  }
  return out.slice(0, 6);
}
const isGerman = (g) => /(^|[\s|\[\-_:])(DE|GER|GERMAN|DEUTSCH)([\s|\]\-_:]|$)/i.test(g.cat || '') || /^\s*DE\s*:/i.test(g.raw || '') || g.lang === 'German';

// ---------------------------------------------------------------- TMDB record
const CERT_COUNTRIES = ['US', 'GB', 'DE'];
const ALT_COUNTRIES = ['US', 'GB', 'DE', 'AT', 'CH', 'IN', 'PK'];
function certs(d, isTv) {
  const out = {};
  if (isTv) {
    for (const x of (d.content_ratings && d.content_ratings.results) || []) if (CERT_COUNTRIES.includes(x.iso_3166_1) && x.rating && !out[x.iso_3166_1]) out[x.iso_3166_1] = x.rating;
  } else {
    for (const x of (d.release_dates && d.release_dates.results) || []) {
      if (!CERT_COUNTRIES.includes(x.iso_3166_1) || out[x.iso_3166_1]) continue;
      const c = ((x.release_dates || []).find((q) => q.certification) || {}).certification;
      if (c) out[x.iso_3166_1] = c;
    }
  }
  return out;
}
function slim(d, type) {
  const isTv = type === 'series';
  const date = isTv ? d.first_air_date : d.release_date;
  const crew = (d.credits && d.credits.crew) || [];
  const alts = ((d.alternative_titles && (d.alternative_titles.titles || d.alternative_titles.results)) || []).filter((a) => ALT_COUNTRIES.includes(a.iso_3166_1) && a.title).map((a) => a.title);
  const kw = (d.keywords && (d.keywords.keywords || d.keywords.results)) || [];
  return {
    id: d.id, imdb: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || '', t: isTv ? d.name : d.title, ot: isTv ? d.original_name : d.original_title,
    y: date ? parseInt(date.slice(0, 4), 10) : 0, lang: d.original_language || '', ov: d.overview || '', tag: d.tagline || '',
    g: (d.genres || []).map((g) => g.name), rt: isTv ? ((d.episode_run_time && d.episode_run_time[0]) || 0) : (d.runtime || 0),
    r: d.vote_average || 0, v: d.vote_count || 0, certs: certs(d, isTv),
    dir: isTv ? ((d.created_by || []).map((c) => c.name).join(', ')) : ((crew.find((c) => c.job === 'Director') || {}).name || ''),
    cast: ((d.credits && d.credits.cast) || []).slice(0, 10).map((c) => c.name),
    p: d.poster_path || '', b: d.backdrop_path || '',
    coll: (d.belongs_to_collection && d.belongs_to_collection.name) || '',
    countries: (d.production_countries || []).map((c) => c.name).concat(isTv && !(d.production_countries || []).length ? (d.origin_country || []) : []),
    spoken: (d.spoken_languages || []).map((l) => l.english_name || l.name).filter(Boolean),
    kw: kw.slice(0, 15).map((k) => k.name), alts: [...new Set(alts)].slice(0, 8),
    seasons: d.number_of_seasons || 0, episodes: d.number_of_episodes || 0, status: d.status || '',
  };
}
const yr = (d) => (d ? parseInt(String(d).slice(0, 4), 10) : 0);
async function searchBest(isTv, gYear, names) {
  const ep = isTv ? '/search/tv' : '/search/movie';
  let best = null;
  for (const q of names) {
    for (const lang of ['en-US', 'de-DE']) {
      for (const withYear of gYear ? [true, false] : [false]) {
        const p = { query: q, language: lang };
        if (withYear) p[isTv ? 'first_air_date_year' : 'year'] = gYear;
        const s = await tmdb(ep, p);
        for (const h of ((s && s.results) || []).slice(0, 5)) {
          const hy = yr(isTv ? h.first_air_date : h.release_date);
          const ns = Math.max(sim(q, isTv ? h.name : h.title), sim(q, isTv ? h.original_name : h.original_title));
          const yOk = !gYear || !hy || (isTv ? gYear >= hy - 1 : Math.abs(gYear - hy) <= 1);
          const score = ns + (yOk ? 0.3 : 0) + (gYear && hy && gYear === hy ? 0.1 : 0) + Math.min(0.05, (h.popularity || 0) / 2000);
          if (!best || score > best.score) best = { id: h.id, score, ns, yOk };
        }
        if (best && best.ns >= 0.8 && best.yOk) return best;
      }
    }
  }
  return best && best.ns >= 0.34 ? best : (best && best.yOk && best.ns >= 0.2 ? best : null);
}

// TVmaze (free, no key) for series TMDB does not know
let tvmazeNext = 0;
async function tvmaze(q) {
  for (let a = 0; a < 4; a++) {
    const wait = tvmazeNext - Date.now(); tvmazeNext = Math.max(Date.now(), tvmazeNext) + 600; // about 1.6 requests/s, under their limit
    if (wait > 0) await sleep(wait);
    try {
      const r = await fetch('https://api.tvmaze.com/singlesearch/shows?embed=cast&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(30000) });
      if (r.status === 200) return await r.json();
      if (r.status === 404) return null;
      await sleep(2000 * (a + 1));
    } catch (e) { await sleep(2000 * (a + 1)); }
  }
  return null;
}
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
async function tvmazeFallback(item) {
  const g = item.g; const names = variants(g.raw, g.clean, isGerman(g)).slice(0, 2);
  for (const q of names) {
    const d = await tvmaze(q);
    if (!d) continue;
    const y = yr(d.premiered);
    const ts = Math.max(sim(q, d.name), sim(g.clean, d.name));
    const yearOk = !g.year || !y || g.year >= y - 1;
    if (ts >= 0.6 && yearOk) {
      item.rec = {
        id: 0, imdb: (d.externals && d.externals.imdb) || '', t: d.name, ot: d.name, y, lang: (d.language || '').slice(0, 2).toLowerCase(), ov: stripHtml(d.summary), tag: '',
        g: d.genres || [], rt: d.averageRuntime || d.runtime || 0, r: 0, v: 0, certs: {}, dir: '',
        cast: (((d._embedded && d._embedded.cast) || []).slice(0, 10)).map((c) => c.person && c.person.name).filter(Boolean),
        p: '', b: '', posterUrl: (d.image && (d.image.medium || d.image.original)) || '', coll: '', countries: [], spoken: d.language ? [d.language] : [], kw: [], alts: [], seasons: 0, episodes: 0, status: d.status || '',
      };
      item.status = 'doubtful'; item.method = 'tvmaze'; item.source = 'tvmaze'; item.sim = ts; item.yearOk = yearOk;
      return true;
    }
  }
  return false;
}

async function resolve(item) {
  const isTv = item.type === 'series', g = item.g;
  const german = isGerman(g);
  const append = (isTv ? 'credits,content_ratings,external_ids' : 'credits,release_dates') + ',keywords,alternative_titles';
  const names = variants(g.raw, g.clean, german);
  let id = g.tmdb > 0 ? g.tmdb : 0, method = id ? 'id' : 'search';
  if (!id) {
    const best = await searchBest(isTv, g.year || 0, names);
    if (!best) { item.status = 'notfound'; return; }
    id = best.id;
  }
  const judge = (rec) => {
    const ts = Math.max(0, ...names.map((n) => Math.max(sim(n, rec.t), sim(n, rec.ot))));
    const yearOk = !g.year || !rec.y || (isTv ? g.year >= rec.y - 1 : Math.abs(g.year - rec.y) <= 1);
    return { ts, yearOk };
  };
  const load = async (tid) => { const d = await tmdb((isTv ? '/tv/' : '/movie/') + tid, { append_to_response: append }); return d ? slim(d, item.type) : null; };
  const rec = await load(id);
  if (!rec) { item.status = 'notfound'; item.method = method; return; }
  let j = judge(rec);
  item.method = method; item.rec = rec; item.source = 'tmdb';
  if (method === 'id' && j.ts < 0.3) { // provider id names a different film: search by name instead
    const best = await searchBest(isTv, g.year || 0, names);
    if (best && best.id !== id) {
      const r2 = await load(best.id);
      if (r2) { const j2 = judge(r2); if (j2.ts >= 0.6 && j2.yearOk) { item.rec = r2; item.method = 'search'; item.fixedId = true; j = j2; } }
    }
  }
  item.sim = j.ts; item.yearOk = j.yearOk;
  item.status = (j.ts >= 0.6 && j.yearOk) ? 'good' : (item.method === 'id' && j.ts >= 0.9 && isTv) ? 'good' : 'doubtful';
}

// ---------------------------------------------------------------- IMDb ratings
async function loadImdbRatings(wanted) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch('https://datasets.imdbws.com/title.ratings.tsv.gz');
      if (r.status !== 200) { log('IMDb file answered ' + r.status + ', retrying'); await sleep(3000 * (a + 1)); continue; }
      const rl = readline.createInterface({ input: Readable.fromWeb(r.body).pipe(zlib.createGunzip()), crlfDelay: Infinity });
      const map = new Map(); let first = true, total = 0;
      for await (const line of rl) {
        if (first) { first = false; continue; }
        total++;
        const p = line.split('\t');
        if (wanted.has(p[0])) map.set(p[0], { r: parseFloat(p[1]), v: parseInt(p[2], 10) });
      }
      return { map, total };
    } catch (e) { log('IMDb file problem: ' + e.message); await sleep(3000 * (a + 1)); }
  }
  return null;
}

// ---------------------------------------------------------------- rules
const KIDS_US = new Set(['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'U']); // same list as Models.kt ContentCertifications
const NO_CERT = new Set(['', 'NR', 'NOT RATED', 'UNRATED', 'UR']);
function resolveCert(c) {
  const us = (c.US || '').trim();
  if (us && !NO_CERT.has(us.toUpperCase())) return { cert: us, country: 'US', kids: KIDS_US.has(us) };
  const gb = (c.GB || '').trim();
  if (gb && !NO_CERT.has(gb.toUpperCase())) return { cert: 'UK ' + gb, country: 'GB', kids: ['U', 'PG'].includes(gb) };
  const de = (c.DE || '').trim().replace(/^FSK[- ]?/i, '');
  if (de && !NO_CERT.has(de.toUpperCase())) return { cert: 'FSK ' + de, country: 'DE', kids: ['0', '6'].includes(de) };
  return { cert: '', country: '', kids: false };
}
// IMDb rating when it has at least 10 votes, else TMDB when it has at least 5 votes, else none
function pickRating(im, rec) {
  if (im && im.v >= 10) return { r: im.r, v: im.v, s: 'I' };
  if (rec.r > 0 && rec.v >= 5) return { r: Math.round(rec.r * 10) / 10, v: rec.v, s: 'T' };
  return { r: 0, v: 0, s: '' };
}
// same shape as the app's weightedRating() (m = 100, C = 6.4) but without its "under 10 votes" cut-off, so TMDB titles with 5-9 votes sort too
const sortScore = (r, v) => (r > 0 && v > 0 ? Math.round(((v / (v + 100)) * r + (100 / (v + 100)) * 6.4) * 100) / 100 : 0);

// ---------------------------------------------------------------- database
const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE titles (
  pid INTEGER PRIMARY KEY, type TEXT NOT NULL, tmdb_id INTEGER, imdb_id TEXT, source TEXT NOT NULL, confidence TEXT NOT NULL,
  title TEXT, original_title TEXT, year INTEGER, language TEXT, plot TEXT, tagline TEXT, genres TEXT, runtime INTEGER,
  cast_text TEXT, director TEXT, rating REAL, rating_votes INTEGER, rating_source TEXT, sort_score REAL,
  imdb_rating REAL, imdb_votes INTEGER, tmdb_rating REAL, tmdb_votes INTEGER,
  certification TEXT, cert_country TEXT, kids_ok INTEGER, cert_us TEXT, cert_gb TEXT, cert_de TEXT,
  collection TEXT, countries TEXT, spoken_languages TEXT, keywords TEXT, seasons INTEGER, episodes INTEGER, status TEXT,
  poster_path TEXT, backdrop_path TEXT, poster_off INTEGER, poster_len INTEGER
);
CREATE UNIQUE INDEX idx_titles_tmdb ON titles(type, tmdb_id) WHERE tmdb_id > 0;
CREATE TABLE aliases (norm TEXT NOT NULL, year INTEGER NOT NULL, pid INTEGER NOT NULL);
CREATE INDEX idx_aliases ON aliases(norm, year);
`;

// ---------------------------------------------------------------- pack steps
async function fetchPoster(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.status === 200) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404) return null;
      await sleep(800 * (a + 1));
    } catch (e) { await sleep(800 * (a + 1)); }
  }
  return 'fail';
}

async function loadItems() {
  const base = SERVER + '/player_api.php?username=' + encodeURIComponent(USER) + '&password=' + encodeURIComponent(PASS) + '&action=';
  const get = async (a) => {
    let last;
    for (let t = 0; t < 8; t++) {
      try { return (await getJson(base + a, PASS)).data; } catch (e) { last = e; log('Provider busy (' + redact(e.message, PASS) + '), retrying in ' + 15 * (t + 1) + ' s'); await sleep(15000 * (t + 1)); }
    }
    throw last;
  };
  log('Reading the provider list ...');
  const [vodCats, vod, serCats, ser] = await Promise.all([get('get_vod_categories'), get('get_vod_streams'), get('get_series_categories'), get('get_series')]).catch((e) => { console.log('Provider error: ' + redact(e.message, PASS)); process.exit(1); });
  const cm = (arr) => new Map(arr.map((c) => [String(c.category_id), String(c.category_name ?? '')]));
  const M = analyse(vod, cm(vodCats), 'stream_id'), S = analyse(ser, cm(serCats), 'series_id');
  const items = [...[...M.main.values()].map((g) => ({ type: 'movie', g })), ...[...S.main.values()].map((g) => ({ type: 'series', g }))];
  return { items, adultCount: M.vault.size + S.vault.size, rawCounts: { vod: vod.length, series: ser.length }, vault: { movies: M.vault.size, series: S.vault.size } };
}

function selftestItems() { // fake data so the file format and the database can be tested without any network
  const items = []; const genres = ['Drama', 'Comedy', 'Action'];
  for (let i = 1; i <= 300; i++) {
    const tv = i % 7 === 0, bad = i % 11 === 0;
    const g = { key: 'tmdb:' + i, raw: 'Test Film ' + i + ' (2020)', clean: 'Test Film ' + i, year: 2020, norm: 'testfilm' + i, tmdb: bad ? 0 : i, copies: 1, cat: 'EN | Movies', cats: new Set(), lang: 'English', prov: { plot: 'Provider plot ' + i, genre: 'Drama', rating: i % 5, cast: '', director: '', rel: '' } };
    const it = { type: tv ? 'series' : 'movie', g };
    if (bad) { it.status = 'notfound'; } else {
      it.status = i % 13 === 0 ? 'doubtful' : 'good'; it.method = 'id'; it.source = 'tmdb'; it.sim = 0.9; it.yearOk = true;
      it.rec = { id: i, imdb: 'tt' + String(1000000 + i), t: 'Test Film ' + i, ot: 'Testfilm ' + i, y: 2020, lang: 'en', ov: 'Plot ' + i, tag: 'Tag ' + i, g: [genres[i % 3]], rt: 100, r: 6 + (i % 4), v: i % 3 === 0 ? 3 : 500,
        certs: i % 4 === 0 ? {} : i % 4 === 1 ? { US: 'PG' } : i % 4 === 2 ? { GB: 'U' } : { DE: 'FSK 12' }, dir: 'Dir ' + i, cast: ['A', 'B'], p: '/p' + i + '.jpg', b: '/b' + i + '.jpg', coll: i % 10 === 0 ? 'Coll' : '', countries: ['United States'], spoken: ['English'], kw: ['k1', 'k2'], alts: ['Alt Title ' + i], seasons: tv ? 2 : 0, episodes: tv ? 20 : 0, status: '' };
    }
    items.push(it);
  }
  return { items, adultCount: 5, rawCounts: { vod: 400, series: 50 }, vault: { movies: 3, series: 2 } };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const loaded = SELFTEST ? selftestItems() : await loadItems();
  let items = loaded.items;
  const totalUnique = items.length;
  if (LIMIT && LIMIT < items.length) { // repeatable random sample
    let s = 12345; const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    items = items.slice(0, LIMIT);
  }
  log('Unique mainstream titles: ' + fmt(totalUnique) + '; building ' + fmt(items.length));
  const leaked = items.filter((x) => /#EXT|https?:|tvg-/i.test(x.g.raw)).length;

  if (!SELFTEST) {
    await pool(items, CONC, resolve, 500, 'TMDB lookups');
    const nf = items.filter((x) => x.status === 'notfound' && x.type === 'series');
    if (nf.length) { log('TVmaze for ' + fmt(nf.length) + ' series TMDB does not know'); await pool(nf, 1, tvmazeFallback, 100, 'TVmaze'); }
  }
  // titles still not found: keep the provider's own information so the pack is complete
  for (const x of items) if (!x.rec) { x.status = 'notfound'; x.source = 'provider'; x.method = x.method || 'none'; }

  // one row per TMDB title (two provider groups can point to the same film)
  const rows = []; const byKey = new Map(); let merged = 0;
  for (const x of items) {
    const k = x.rec && x.rec.id > 0 ? x.type + ':' + x.rec.id : null;
    if (k && byKey.has(k)) { const row = byKey.get(k); row.members.push(x); merged++; if (x.status === 'good' && row.status !== 'good') { row.status = 'good'; } continue; }
    const row = { type: x.type, rec: x.rec || null, status: x.status, source: x.source, members: [x] };
    if (k) byKey.set(k, row);
    rows.push(row);
  }

  // IMDb ratings (for TMDB and TVmaze titles that have an IMDb id)
  let imdb = null;
  if (!SELFTEST) {
    const wanted = new Set(rows.filter((r) => r.rec && r.rec.imdb).map((r) => r.rec.imdb));
    imdb = await loadImdbRatings(wanted);
    if (!imdb) { console.log('IMDb ratings file could NOT be downloaded; stopping so the pack is not built without IMDb ratings.'); process.exit(1); }
  } else imdb = { map: new Map(rows.filter((r) => r.rec).map((r, i) => [r.rec.imdb, { r: 7 + (i % 3) * 0.5, v: i % 5 === 0 ? 4 : 1200 }])), total: 0 };

  // stable order -> stable ids
  rows.sort((a, b) => (a.type === b.type ? 0 : a.type < b.type ? -1 : 1) || ((a.rec && a.rec.id) || 0) - ((b.rec && b.rec.id) || 0) || appNorm(a.members[0].g.clean).localeCompare(appNorm(b.members[0].g.clean)));
  rows.forEach((r, i) => { r.pid = i + 1; });

  // posters
  const postersTmp = path.join(OUT, 'posters.tmp');
  fs.writeFileSync(postersTmp, '');
  const pfd = fs.openSync(postersTmp, 'a');
  let pOff = 0, pCount = 0, pBytes = 0, pMissing = 0, pFail = 0, chain = Promise.resolve();
  const needPoster = rows.filter((r) => r.rec && (r.rec.p || r.rec.posterUrl));
  if (POSTERS) {
    await pool(needPoster, CONC, async (r) => {
      const url = r.rec.p ? 'https://image.tmdb.org/t/p/w342' + r.rec.p : r.rec.posterUrl;
      const buf = SELFTEST ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500 + (r.pid % 50) * 20, r.pid % 250), Buffer.from([0xff, 0xd9])]) : await fetchPoster(url);
      if (buf === 'fail') { pFail++; return; }
      if (!buf) { pMissing++; return; }
      await (chain = chain.then(() => { r.pOff = pOff; r.pLen = buf.length; fs.writeSync(pfd, buf); pOff += buf.length; pCount++; pBytes += buf.length; }));
    }, 500, 'Posters');
  }
  fs.closeSync(pfd);

  // database
  const dbPath = path.join(OUT, 'pack.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
  db.exec(SCHEMA);
  const insT = db.prepare(`INSERT INTO titles VALUES (${Array(41).fill('?').join(',')})`);
  const insA = db.prepare('INSERT INTO aliases VALUES (?,?,?)');
  const st = { src: { tmdb: 0, tvmaze: 0, provider: 0 }, conf: { good: 0, doubtful: 0, notfound: 0 }, rate: { I: 0, T: 0, none: 0 }, certUS: 0, certAny: 0, certNone: 0, kids: 0, kidsUS: 0, aliasRows: 0, provRating: 0, provPlot: 0 };
  db.exec('BEGIN');
  for (const r of rows) {
    const x = r.members[0], g = x.g, rec = r.rec;
    const isNF = !rec;
    const im = rec && rec.imdb ? imdb.map.get(rec.imdb) : null;
    const rt = rec ? pickRating(im, rec) : { r: 0, v: 0, s: '' };
    const c = rec ? resolveCert(rec.certs) : { cert: '', country: '', kids: false };
    const prov = g.prov || {};
    const title = rec ? rec.t : g.clean;
    const conf = isNF ? 'notfound' : r.status;
    st.src[r.source || 'provider']++; st.conf[conf]++; st.rate[rt.s || 'none']++;
    if (rec) {
      if (rec.certs.US && !NO_CERT.has(rec.certs.US.toUpperCase())) st.certUS++;
      if (c.cert) st.certAny++; else st.certNone++;
      if (c.kids) st.kids++;
      if (c.kids && c.country === 'US') st.kidsUS++;
    } else { st.certNone++; if (prov.rating > 0) st.provRating++; if (prov.plot) st.provPlot++; }
    insT.run(r.pid, r.type, rec ? rec.id : 0, rec ? rec.imdb : '', r.source || 'provider', conf,
      title, rec ? rec.ot : '', rec ? rec.y : (g.year || 0), rec ? rec.lang : '', rec ? rec.ov : (prov.plot || ''), rec ? rec.tag : '', rec ? rec.g.join(', ') : (prov.genre || ''), rec ? rec.rt : 0,
      rec ? rec.cast.join(', ') : (prov.cast || ''), rec ? rec.dir : (prov.director || ''), rt.r, rt.v, rt.s, sortScore(rt.r, rt.v),
      im ? im.r : 0, im ? im.v : 0, rec ? Math.round(rec.r * 10) / 10 : 0, rec ? rec.v : 0,
      c.cert, c.country, c.kids ? 1 : 0, rec ? (rec.certs.US || '') : '', rec ? (rec.certs.GB || '') : '', rec ? (rec.certs.DE || '') : '',
      rec ? rec.coll : '', rec ? rec.countries.join(', ') : '', rec ? rec.spoken.join(', ') : '', rec ? rec.kw.join(', ') : '', rec ? rec.seasons : 0, rec ? rec.episodes : 0, rec ? rec.status : '',
      rec ? rec.p : '', rec ? rec.b : '', r.pOff === undefined ? null : r.pOff, r.pLen === undefined ? null : r.pLen);
    // name index: what the provider calls it (every member), what TMDB calls it, alternative names
    const seen = new Set();
    const addA = (name, year) => { const n = appNorm(name); if (n.length < 2) return; const k = n + '|' + year; if (seen.has(k)) return; seen.add(k); insA.run(n, year, r.pid); st.aliasRows++; };
    for (const m of r.members) { addA(m.g.clean, m.g.year || 0); if (m.g.year) addA(m.g.clean, 0); }
    if (rec) for (const nm of [rec.t, rec.ot, ...rec.alts]) { addA(nm, rec.y || 0); addA(nm, 0); }
  }
  db.exec('COMMIT');
  const metaIns = db.prepare('INSERT INTO meta VALUES (?,?)');
  for (const [k, v] of Object.entries({ version: VERSION, built_at: new Date().toISOString(), titles: rows.length, schema: 1, rating_rule: 'IMDb>=10 votes else TMDB>=5 votes', poster_size: 'w342' })) metaIns.run(k, String(v));
  db.exec('VACUUM');
  db.close();

  const meta = { version: VERSION, builtAt: new Date().toISOString(), titles: rows.length, posters: pCount };
  const packPath = path.join(OUT, 'streamvault-pack.svpack');
  const header = await PF.assemble(packPath, dbPath, postersTmp, meta);
  const packSha = await PF.sha256File(packPath);
  const packSize = fs.statSync(packPath).size;
  const manifest = { version: VERSION, builtAt: meta.builtAt, titles: rows.length, size: packSize, sha256: packSha, format: 1, dbRawLength: header.dbRawLength, dbGzLength: header.dbGzLength, postersLength: header.postersLength };
  const prefix = (LIMIT || SELFTEST) ? 'test/' : 'packs/';
  manifest.key = prefix + VERSION + '/streamvault-pack.svpack';
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  log('Pack written: ' + MB(packSize) + ' MB, sha256 ' + packSha.slice(0, 12) + '...');

  // upload to Cloudflare R2
  let uploaded = 'not uploaded (UPLOAD was off)';
  if (UPLOAD && !SELFTEST) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { Upload } = require('@aws-sdk/lib-storage');
    const s3 = new S3Client({ region: 'auto', endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com', credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    const up = new Upload({ client: s3, params: { Bucket: 'streamvault-enrichments', Key: manifest.key, Body: fs.createReadStream(packPath), ContentType: 'application/octet-stream' }, queueSize: 4, partSize: 32 * 1024 * 1024 });
    let lastPct = -10; up.on('httpUploadProgress', (p) => { const pct = Math.floor(100 * (p.loaded || 0) / packSize); if (pct >= lastPct + 10) { lastPct = pct; log('Upload ' + pct + '%'); } });
    await up.done();
    await new Upload({ client: s3, params: { Bucket: 'streamvault-enrichments', Key: prefix + 'latest.json', Body: JSON.stringify(manifest), ContentType: 'application/json' } }).done();
    uploaded = 'uploaded to R2 bucket streamvault-enrichments as ' + manifest.key + ' (and ' + prefix + 'latest.json)';
    log(uploaded);
  }

  // ------------------------------------------------------------ report
  const out = []; const add = (s = '') => out.push(s);
  const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '0') + '%';
  const n = rows.length;
  add('ENRICHMENTS PACK BUILD  (' + today + ')' + (SELFTEST ? '  *** SELF-TEST WITH FAKE DATA ***' : ''));
  add('Pack version: ' + VERSION + '   built ' + fmt(items.length) + ' of ' + fmt(totalUnique) + ' unique mainstream titles' + (LIMIT && LIMIT < totalUnique ? ' (random sample)' : '') + '   = ' + fmt(n) + ' pack rows (' + fmt(merged) + ' provider titles merged into an existing TMDB row)');
  add('Never sent out: Adult + Extras titles (' + fmt(loaded.adultCount) + ' in this provider list). Provider names with leaked playlist text, cleaned: ' + fmt(leaked));
  add('');
  add('== MATCHING ==');
  add('Source: TMDB ' + fmt(st.src.tmdb) + '   TVmaze ' + fmt(st.src.tvmaze) + '   provider information only ' + fmt(st.src.provider));
  add('Confidence: good ' + fmt(st.conf.good) + ' (' + pct(st.conf.good, n) + ')   doubtful ' + fmt(st.conf.doubtful) + ' (' + pct(st.conf.doubtful, n) + ')   not found ' + fmt(st.conf.notfound) + ' (' + pct(st.conf.notfound, n) + ')');
  add('Provider TMDB id used ' + fmt(items.filter((x) => x.method === 'id').length) + '   found by name search ' + fmt(items.filter((x) => x.method === 'search').length) + '   provider id wrong and replaced ' + fmt(items.filter((x) => x.fixedId).length));
  add('Not found titles with provider plot: ' + fmt(st.provPlot) + '   with a provider rating: ' + fmt(st.provRating) + '  (provider rating is NOT used yet)');
  add('');
  add('== RATINGS (IMDb >= 10 votes, else TMDB >= 5 votes) ==');
  add('Shows I: ' + fmt(st.rate.I) + ' (' + pct(st.rate.I, n) + ')   shows T: ' + fmt(st.rate.T) + ' (' + pct(st.rate.T, n) + ')   Not rated: ' + fmt(st.rate.none) + ' (' + pct(st.rate.none, n) + ')');
  add('');
  add('== AGE RATINGS / KIDS ==');
  add('Titles with a US age rating: ' + fmt(st.certUS) + ' (' + pct(st.certUS, n) + ')   with ANY age rating (US, else UK, else DE): ' + fmt(st.certAny) + ' (' + pct(st.certAny, n) + ')   gained from UK/DE: ' + fmt(st.certAny - st.certUS));
  add('NO age rating at all (hidden from Kids): ' + fmt(st.certNone) + ' (' + pct(st.certNone, n) + ')');
  add('Visible in Kids: ' + fmt(st.kids) + ' (' + pct(st.kids, n) + ')   of those from the US rating alone: ' + fmt(st.kidsUS));
  add('');
  add('== FILE ==');
  add('Name index rows: ' + fmt(st.aliasRows) + '   database raw ' + MB(header.dbRawLength) + ' MB, in the file ' + MB(header.dbGzLength) + ' MB');
  add('Posters: ' + fmt(pCount) + ' stored (' + MB(pBytes) + ' MB, avg ' + (pBytes / Math.max(1, pCount) / 1024).toFixed(1) + ' KB)   no poster on TMDB ' + fmt(pMissing) + '   failed after retries ' + fmt(pFail));
  add('PACK FILE: ' + MB(packSize) + ' MB (' + (packSize / 1073741824).toFixed(2) + ' GB)   sha256 ' + packSha);
  add('Upload: ' + uploaded);
  add('Run time: ' + ((Date.now() - t0) / 60000).toFixed(1) + ' min');
  fs.writeFileSync(path.join(OUT, 'pack-build-summary.txt'), out.join('\n') + '\n');

  const sm = []; const row = (x) => '  "' + x.g.raw + '"  =>  "' + x.rec.t + '" (' + x.rec.y + ')  [' + x.method + ', name match ' + Math.round((x.sim || 0) * 100) + '%]';
  sm.push('DOUBTFUL MATCHES — for a human eye'); sm.push(...items.filter((x) => x.rec && x.status === 'doubtful').slice(0, 80).map(row));
  sm.push(''); sm.push('NOT FOUND ON TMDB'); sm.push(...items.filter((x) => !x.rec).slice(0, 80).map((x) => '  "' + x.g.raw + '"  [' + x.type + ']'));
  sm.push(''); sm.push('NO AGE RATING (sample of titles hidden from Kids)'); sm.push(...rows.filter((r) => r.rec && !resolveCert(r.rec.certs).cert).slice(0, 30).map((r) => '  ' + r.rec.t + ' (' + r.rec.y + ')'));
  fs.writeFileSync(path.join(OUT, 'pack-build-samples.txt'), sm.join('\n') + '\n');
  fs.unlinkSync(postersTmp);
  console.log('\n' + out.join('\n'));
})().catch((e) => { console.error('BUILD FAILED: ' + redact(e.stack || e.message, PASS)); process.exit(1); });
