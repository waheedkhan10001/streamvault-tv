'use strict';
// Enrichments PACK TEST. Measures (does not build) the real size and quality of the shared pack:
//  - reads the provider list (login comes from GitHub secrets, never printed)
//  - applies the app's own merging rules (same code as count-my-titles.js)
//  - looks each unique mainstream title up on TMDB (id when the provider gives one, otherwise a name+year search)
//  - measures database bytes per title, wrong-match signals and real poster sizes
// Adult and Extras titles are never looked up.
const fs = require('fs');
const zlib = require('zlib');
const { analyse, getJson, redact } = require('./count-my-titles.cjs');

const SERVER = (process.env.IPTV_SERVER || '').replace(/\/+$/, '');
const USER = process.env.IPTV_USER || '', PASS = process.env.IPTV_PASS || '';
const KEY = process.env.TMDB_API_KEY || '';
const LIMIT = parseInt(process.env.LIMIT || '0', 10) || 0; // 0 = every title
const POSTERS = (process.env.POSTERS || 'true') !== 'false';
const CONC = parseInt(process.env.CONC || '12', 10);
if (!SERVER || !USER || !PASS || !KEY) { console.log('Missing one of IPTV_SERVER, IPTV_USER, IPTV_PASS, TMDB_API_KEY'); process.exit(1); }

const fmt = (n) => Number(n).toLocaleString('en-US');
const MB = (b) => (b / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log('[' + ((Date.now() - t0) / 60000).toFixed(1) + ' min] ' + s);

async function tmdb(path, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(u);
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

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function sim(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean)), B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function slim(d, type) {
  const isTv = type === 'series';
  const date = isTv ? d.first_air_date : d.release_date;
  let cert = '';
  if (isTv) { const r = (d.content_ratings && d.content_ratings.results) || []; const x = r.find((z) => z.iso_3166_1 === 'US') || r[0]; cert = x ? x.rating : ''; }
  else { const r = (d.release_dates && d.release_dates.results) || []; const us = r.find((z) => z.iso_3166_1 === 'US'); cert = us ? ((us.release_dates.find((q) => q.certification) || {}).certification || '') : ''; }
  const crew = (d.credits && d.credits.crew) || [];
  const director = isTv ? ((d.created_by || []).map((c) => c.name).join(', ')) : ((crew.find((c) => c.job === 'Director') || {}).name || '');
  return {
    id: d.id, imdb: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || '', t: isTv ? d.name : d.title, ot: isTv ? d.original_name : d.original_title,
    y: date ? parseInt(date.slice(0, 4), 10) : 0, lang: d.original_language || '', ov: d.overview || '',
    g: (d.genres || []).map((g) => g.name), rt: isTv ? ((d.episode_run_time && d.episode_run_time[0]) || 0) : (d.runtime || 0),
    r: d.vote_average || 0, v: d.vote_count || 0, cert, dir: director,
    cast: ((d.credits && d.credits.cast) || []).slice(0, 10).map((c) => c.name), p: d.poster_path || '', b: d.backdrop_path || '',
  };
}

// Extra name cleaning for the search step (the app's own parser already removes year, quality and "DE:").
const LANGS = 'hindi|tamil|telugu|malayalam|kannada|marathi|punjabi|pashto|bengali|bangla|urdu|english|gujarati|bhojpuri|dubbed|subbed|sub|subtitles|english-subbed|full|length|movie|film|hd|4k|uhd|latest|new|superhit|classic|old|awesome|comedy|thriller|romantic|action|telefilm|converted|scam|tv|netflix|voot|zee5|hotstar|amazon|prime';
function variants(raw, clean) {
  const out = []; const add = (x) => { x = String(x || '').replace(/\s+/g, ' ').trim(); if (x.length > 1 && !out.includes(x)) out.push(x); };
  let c = String(clean || '').replace(/\*/g, ' ').replace(/^\s*[A-Z]{2,3}\s*:\s*/, '');
  c = c.replace(/\((tv movie|netflix|voot|zee5|hotstar|amazon|prime|hd|scam|[^)]*movie[^)]*)\)/gi, ' ').replace(/-converted/gi, ' ').replace(/\s+S\d{1,2}$/i, ' ');
  add(c);
  const parts = c.split(/\s+[_|]+\s+|\s+-\s+/); // "Title _ Full Movie _ Actor" -> keep the first part
  if (parts.length > 1) add(parts[0]);
  const stripped = parts[0].replace(new RegExp('\\b(' + LANGS + ')\\b', 'gi'), ' ').replace(/[\[\]()]/g, ' ');
  add(stripped);
  const colon = c.split(/\s*:\s*/); if (colon.length > 1) add(colon[0]);
  add(c.replace(/'s\b/g, 's').replace(/([a-z])([A-Z])/g, '$1 $2'));
  return out.slice(0, 5);
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
        if (best && best.ns >= 0.8 && best.yOk) return best; // good enough, stop early
      }
    }
  }
  return best && best.ns >= 0.34 ? best : (best && best.yOk && best.ns >= 0.2 ? best : null); // the very weakest guesses count as not found
}

async function resolve(item) {
  const isTv = item.type === 'series', g = item.g;
  const append = isTv ? 'credits,content_ratings,external_ids' : 'credits,release_dates';
  let id = g.tmdb > 0 ? g.tmdb : 0, method = id ? 'id' : 'search';
  if (!id) {
    const best = await searchBest(isTv, g.year || 0, variants(g.raw, g.clean));
    if (!best) { item.status = 'notfound'; return; }
    id = best.id;
  }
  const names = variants(g.raw, g.clean);
  const judge = (rec) => {
    const ts = Math.max(0, ...names.map((n) => Math.max(sim(n, rec.t), sim(n, rec.ot))));
    // a series name carries the year of the LATEST season, TMDB keeps the first year, so only a later name year is fine
    const yearOk = !g.year || !rec.y || (isTv ? g.year >= rec.y - 1 : Math.abs(g.year - rec.y) <= 1);
    return { ts, yearOk };
  };
  const load = async (tid) => { const d = await tmdb((isTv ? '/tv/' : '/movie/') + tid, { append_to_response: append }); return d ? slim(d, item.type) : null; };
  const rec = await load(id);
  if (!rec) { item.status = 'notfound'; item.method = method; return; }
  let j = judge(rec);
  item.method = method; item.rec = rec;
  // the provider's id points at a film whose name does not fit at all: it is probably wrong, so search by name instead
  if (method === 'id' && j.ts < 0.3) {
    const best = await searchBest(isTv, g.year || 0, names);
    if (best && best.id !== id) {
      const r2 = await load(best.id);
      if (r2) { const j2 = judge(r2); if (j2.ts >= 0.6 && j2.yearOk) { item.rec = r2; item.method = 'search'; item.fixedId = true; j = j2; } }
    }
  }
  item.sim = j.ts; item.yearOk = j.yearOk;
  item.status = (j.ts >= 0.6 && j.yearOk) ? 'confident' : (item.method === 'id' && j.ts >= 0.9 && isTv) ? 'confident' : 'doubtful';
}

// IMDb's free non-commercial ratings file (id -> average rating, votes). Streamed, only the ids we need are kept.
const { Readable } = require('stream');
const readline = require('readline');
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
function imdbStats(found, got) {
  const L = [], ex = [];
  const rows = found.map((x) => ({ x, im: x.rec.imdb ? got.map.get(x.rec.imdb) : null }));
  const pct = (n) => (found.length ? (100 * n / found.length).toFixed(1) : '0') + '%';
  const withId = rows.filter((z) => z.x.rec.imdb).length, withIm = rows.filter((z) => z.im).length;
  L.push('Rows in IMDb ratings file: ' + fmt(got.total) + '   our found titles: ' + fmt(found.length) + '   with an IMDb id: ' + fmt(withId) + ' (' + pct(withId) + ')   with an IMDb rating: ' + fmt(withIm) + ' (' + pct(withIm) + ')');
  for (const n of [1, 10, 25, 50, 100, 1000]) L.push('  IMDb rating with at least ' + fmt(n) + ' votes: ' + fmt(rows.filter((z) => z.im && z.im.v >= n).length) + ' (' + pct(rows.filter((z) => z.im && z.im.v >= n).length) + ')');
  for (const n of [1, 5, 10, 50]) L.push('  TMDB rating with at least ' + fmt(n) + ' votes: ' + fmt(rows.filter((z) => z.x.rec.r > 0 && z.x.rec.v >= n).length) + ' (' + pct(rows.filter((z) => z.x.rec.r > 0 && z.x.rec.v >= n).length) + ')');
  L.push('Rule "IMDb first, else TMDB" (among titles found on TMDB; titles not found on TMDB have no rating at all):');
  for (const [n, m] of [[10, 5], [25, 5], [50, 10], [100, 10]]) {
    let I = 0, T = 0, none = 0;
    for (const z of rows) { if (z.im && z.im.v >= n) I++; else if (z.x.rec.r > 0 && z.x.rec.v >= m) T++; else none++; }
    L.push('  IMDb >= ' + n + ' votes, else TMDB >= ' + m + ' votes:  shows I: ' + fmt(I) + '   shows T: ' + fmt(T) + '   Not rated: ' + fmt(none) + ' (' + pct(none) + ')');
  }
  const both = rows.filter((z) => z.im && z.im.v >= 25 && z.x.rec.r > 0 && z.x.rec.v >= 10);
  if (both.length) {
    const d = both.map((z) => Math.abs(z.im.r - z.x.rec.r));
    L.push('Where both have a rating (IMDb >= 25 votes, TMDB >= 10 votes): ' + fmt(both.length) + ' titles; average difference ' + (d.reduce((a, b) => a + b, 0) / d.length).toFixed(2) + ' points; differ by 1+ point: ' + fmt(d.filter((v) => v >= 1).length) + '; by 2+ points: ' + fmt(d.filter((v) => v >= 2).length));
    for (const z of both.filter((q) => Math.abs(q.im.r - q.x.rec.r) >= 2).slice(0, 25)) ex.push('  "' + z.x.g.raw + '"  =>  "' + z.x.rec.t + '" (' + z.x.rec.y + ')   IMDb ' + z.im.r + ' (' + fmt(z.im.v) + ' votes)   TMDB ' + z.x.rec.r.toFixed(1) + ' (' + fmt(z.x.rec.v) + ' votes)');
  }
  return { L, ex };
}

(async () => {
  const base = SERVER + '/player_api.php?username=' + encodeURIComponent(USER) + '&password=' + encodeURIComponent(PASS) + '&action=';
  const get = async (a) => { // the provider sometimes answers 502 for a moment: wait and try again
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
  let items = [...[...M.main.values()].map((g) => ({ type: 'movie', g })), ...[...S.main.values()].map((g) => ({ type: 'series', g }))];
  const totalUnique = items.length;
  if (LIMIT && LIMIT < items.length) { // repeatable random sample
    let s = 12345; const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    items = items.slice(0, LIMIT);
  }
  log('Unique mainstream titles: ' + fmt(totalUnique) + '; testing ' + fmt(items.length));

  await pool(items, CONC, resolve, 500, 'TMDB lookups');
  const found = items.filter((x) => x.rec);
  const by = (m, st) => items.filter((x) => (m ? x.method === m : true) && (st ? x.status === st : true)).length;

  // database size
  const lines = found.map((x) => JSON.stringify(x.rec));
  const raw = Buffer.from(lines.join('\n'));
  const gz = zlib.gzipSync(raw, { level: 9 }).length, br = zlib.brotliCompressSync(raw).length;
  // an index (key -> id) is also needed; count it generously
  const idxBytes = found.reduce((a, x) => a + x.g.key.length + 24, 0);

  // posters
  let pBytes = 0, pCount = 0, pMissing = 0, pFail = 0, pMax = 0;
  if (POSTERS) {
    await pool(found, CONC, async (x) => {
      if (!x.rec.p) { pMissing++; return; }
      for (let a = 0; a < 4; a++) {
        try { const r = await fetch('https://image.tmdb.org/t/p/w342' + x.rec.p); if (r.status === 200) { const n = (await r.arrayBuffer()).byteLength; pBytes += n; pCount++; if (n > pMax) pMax = n; return; } if (r.status === 404) { pMissing++; return; } await sleep(800 * (a + 1)); } catch (e) { await sleep(800 * (a + 1)); }
      }
      pFail++;
    }, 500, 'Posters');
  }

  // IMDb ratings coverage
  let imdb = null;
  { const wanted = new Set(found.filter((x) => x.rec.imdb).map((x) => x.rec.imdb));
    const got = await loadImdbRatings(wanted);
    imdb = got ? imdbStats(found, got) : { L: ['IMDb ratings file could NOT be downloaded (see run log).'], ex: [] }; }

  const scale = totalUnique / items.length;
  const out = [];
  const add = (s = '') => out.push(s);
  add('ENRICHMENTS PACK TEST  (' + new Date().toISOString().slice(0, 10) + ')');
  add('Tested ' + fmt(items.length) + ' of ' + fmt(totalUnique) + ' unique mainstream titles' + (items.length < totalUnique ? ' (random sample; "whole set" numbers are scaled x' + scale.toFixed(1) + ')' : '') + '.');
  add('');
  add('== MATCHING ==');
  add('Provider gave a TMDB id: ' + fmt(by('id')) + '   found by name+year search: ' + fmt(by('search')) + '   not found at all: ' + fmt(by(null, 'notfound')));
  add('Found by search -> confident (name and year agree): ' + fmt(items.filter((x) => x.method === 'search' && x.status === 'confident').length) + '   doubtful (name or year disagree): ' + fmt(items.filter((x) => x.method === 'search' && x.status === 'doubtful').length));
  add('Provider id used -> name and year agree: ' + fmt(items.filter((x) => x.method === 'id' && x.status === 'confident').length) + '   disagree (provider id may be wrong): ' + fmt(items.filter((x) => x.method === 'id' && x.status === 'doubtful').length));
  add('Provider id looked wrong (name did not fit) and was replaced by a name search: ' + fmt(items.filter((x) => x.fixedId).length));
  add('Titles with no year in the provider name: ' + fmt(items.filter((x) => !x.g.year).length) + '   of those found by search and doubtful: ' + fmt(items.filter((x) => !x.g.year && x.method === 'search' && x.status === 'doubtful').length));
  add('');
  add('== DATABASE SIZE (title, year, plot, cast, director, genres, ratings, age rating, ids) ==');
  add('Records: ' + fmt(found.length) + '   raw: ' + MB(raw.length) + ' MB   gzip: ' + MB(gz) + ' MB   brotli: ' + MB(br) + ' MB   avg raw per title: ' + Math.round(raw.length / Math.max(1, found.length)) + ' bytes');
  add('WHOLE SET estimate (' + fmt(totalUnique) + ' titles): raw ' + MB(raw.length * scale + idxBytes * scale) + ' MB, compressed download about ' + MB(br * scale + idxBytes * scale * 0.4) + ' MB');
  if (POSTERS) {
    add('');
    add('== POSTERS (w342) ==');
    add('Downloaded: ' + fmt(pCount) + '   no poster on TMDB: ' + fmt(pMissing) + '   failed: ' + fmt(pFail) + '   largest: ' + Math.round(pMax / 1024) + ' KB');
    add('Total: ' + MB(pBytes) + ' MB   average: ' + (pBytes / Math.max(1, pCount) / 1024).toFixed(1) + ' KB');
    const whole = pBytes * scale;
    add('WHOLE SET estimate: ' + (whole / 1073741824).toFixed(2) + ' GB   ->  at 40 Mbps (5 MB/s): ' + (whole / 5242880 / 60).toFixed(1) + ' min; at 68 Mbps (8.5 MB/s): ' + (whole / 8912896 / 60).toFixed(1) + ' min');
  }
  add('');
  add('== IMDB RATINGS (IMDb first, TMDB as fallback) ==');
  for (const l of imdb.L) add(l);
  add('');
  add('Run time: ' + ((Date.now() - t0) / 60000).toFixed(1) + ' min');
  fs.writeFileSync('pack-test-summary.txt', out.join('\n') + '\n');

  const sm = [];
  const take = (arr, n) => arr.slice(0, n);
  const row = (x) => '  "' + x.g.raw + '"  =>  "' + x.rec.t + '" (' + x.rec.y + ')  [' + x.method + (x.g.year ? '' : ', no year in name') + ', name match ' + Math.round(x.sim * 100) + '%]';
  sm.push('DOUBTFUL MATCHES (name or year disagree) — for a human eye'); sm.push(...take(items.filter((x) => x.rec && x.status === 'doubtful').map(row), 80));
  sm.push(''); sm.push('CONFIDENT SEARCH MATCHES (random look)'); sm.push(...take(items.filter((x) => x.rec && x.method === 'search' && x.status === 'confident').map(row), 30));
  sm.push(''); sm.push('NOT FOUND'); sm.push(...take(items.filter((x) => x.status === 'notfound').map((x) => '  "' + x.g.raw + '"'), 60));
  sm.push(''); sm.push('BIG IMDb vs TMDB DIFFERENCES (2+ points, both with enough votes)'); sm.push(...imdb.ex);
  fs.writeFileSync('pack-test-samples.txt', sm.join('\n') + '\n');
  console.log('\n' + out.join('\n'));
})();
