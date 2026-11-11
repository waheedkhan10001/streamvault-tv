// Shared TMDB cache in the real Worker (real SQLite): slim copies, 90-day details, batch lookup for a TV that signs in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../cloud-sync/src/worker.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (_) { console.log(`⚠ SKIPPED TMDB cache tests: needs Node 22.13 or newer (found ${process.version}).`); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'cloud-sync/schema.sql'), 'utf8'));
const DB = { prepare(sql) { return { bind(...a) { return {
  async first() { return sqlite.prepare(sql).get(...a) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...a) }; },
  async run() { const r = sqlite.prepare(sql).run(...a); return { success: true, meta: { changes: Number(r.changes) } }; }
}; } }; } };
const env = { DB, DEV_MODE: 'true', BREVO_API_KEY: 'x', AES_SECRET: 'test-aes-secret-for-tmdb-cache-0123456789', TMDB_API_KEY: 'fake' };

let tmdbCalls = 0;
const big = {
  id: 603, overview: 'A hacker learns the truth.', vote_average: 8.2, vote_count: 25000, runtime: 136, release_date: '1999-03-30', original_language: 'en',
  genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }], poster_path: '/p.jpg', backdrop_path: '/b.jpg', imdb_id: 'tt0133093',
  homepage: 'x'.repeat(2000), production_companies: Array.from({ length: 30 }, (_, i) => ({ id: i, name: 'Studio ' + i, logo_path: '/l' + i })),
  credits: { cast: Array.from({ length: 60 }, (_, i) => ({ name: 'Actor ' + i, character: 'C' + i, profile_path: '/a' + i })), crew: [{ name: 'Lana', job: 'Director' }, { name: 'Someone', job: 'Editor' }] },
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', note: 'x' }] }, { iso_3166_1: 'DE', release_dates: [{ certification: '16' }] }] },
  content_ratings: { results: [] }
};
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.includes('brevo')) return new Response('{}', { status: 201 });
  if (url.includes('api.themoviedb.org/3/movie/603')) { tmdbCalls++; return new Response(JSON.stringify(big), { status: 200 }); }
  if (url.includes('api.themoviedb.org')) { tmdbCalls++; return new Response('{"status_code":34}', { status: 404 }); }
  throw new Error('outside call ' + url);
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
let ip = 10;
const call = async (method, route, body, token) => {
  const res = await worker.fetch(new Request('https://sync.test' + route, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.' + (ip++), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, cache: res.headers.get('X-Cache') };
};

console.log('=== StreamVault cloud — shared TMDB cache ===\n');
const su = await call('POST', '/api/auth/signup', { email: 'c@example.com', password: 'Secret123!' });
const vf = await call('POST', '/api/auth/verify-code', { email: 'c@example.com', code: su.json.devCode });
const token = vf.json.token;
const APPEND = 'append_to_response=credits,external_ids,release_dates,content_ratings';

const first = await call('GET', `/api/tmdb/movie/603?${APPEND}`, null, token);
check('first lookup goes to TMDB (MISS)', first.status === 200 && first.cache === 'MISS' && tmdbCalls === 1);
const slim = first.json;
check('answer keeps what the TV reads', slim.overview && slim.vote_count === 25000 && slim.genres.length === 2 && slim.imdb_id === 'tt0133093' && slim.runtime === 136);
check('only 8 cast names, only the director', slim.credits.cast.length === 8 && slim.credits.cast[0].name === 'Actor 0' && !slim.credits.cast[0].character && slim.credits.crew.length === 1 && slim.credits.crew[0].name === 'Lana');
check('only the US age rating is kept', slim.release_dates.results.length === 1 && slim.release_dates.results[0].release_dates[0].certification === 'R');
check('stored copy is much smaller than TMDB\'s', first.text.length < JSON.stringify(big).length / 5, `${first.text.length} vs ${JSON.stringify(big).length}`);
const row = sqlite.prepare("SELECT expires_at, updated_at FROM tmdb_cache WHERE cache_key LIKE 'movie/603:%'").get();
check('details are kept about 90 days', Math.round((row.expires_at - row.updated_at) / 86400000) === 90);

const second = await call('GET', `/api/tmdb/movie/603?${APPEND}`, null, token);
check('second lookup comes from the cache (HIT), no TMDB call', second.cache === 'HIT' && tmdbCalls === 1);

const before = tmdbCalls;
const batch = await call('POST', '/api/tmdb/batch', { items: [{ type: 'movie', id: 603 }, { type: 'movie', id: 999 }, { type: 'tv', id: 1 }, { type: 'bogus', id: 5 }, { type: 'movie', id: 'x' }, null] }, token);
check('batch answers with the cached title only', batch.status === 200 && batch.json.found === 1 && batch.json.results['movie:603'] && !batch.json.results['movie:999'], batch.text.slice(0, 120));
check('batch copy has the same fields the TV reads', batch.json.results['movie:603'].credits.crew[0].name === 'Lana' && batch.json.results['movie:603'].vote_average === 8.2);
check('batch never calls TMDB', tmdbCalls === before);
check('invalid entries are ignored (only 3 valid lookups)', batch.json.requested === 3, String(batch.json.requested));
const many = await call('POST', '/api/tmdb/batch', { items: Array.from({ length: 500 }, (_, i) => ({ type: 'movie', id: i + 1000 })) }, token);
check('at most 200 titles per call', many.json.requested === 200, String(many.json.requested));
const anon = await call('POST', '/api/tmdb/batch', { items: [{ type: 'movie', id: 603 }] });
check('signed-out callers are refused', anon.status === 401, String(anon.status));
// an old raw cached row (stored before this change) is slimmed when read through the batch
sqlite.prepare("INSERT INTO tmdb_cache (cache_key, endpoint, response_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(`movie/604:${new URLSearchParams({ append_to_response: 'credits,external_ids,release_dates,content_ratings' }).toString()}`, 'movie/604', JSON.stringify({ ...big, id: 604 }), Date.now() + 1e9, Date.now());
const old = await call('POST', '/api/tmdb/batch', { items: [{ type: 'movie', id: 604 }] }, token);
check('an old full-size cached row comes back slim', old.json.results['movie:604'] && old.json.results['movie:604'].credits.cast.length === 8 && !old.json.results['movie:604'].homepage);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
