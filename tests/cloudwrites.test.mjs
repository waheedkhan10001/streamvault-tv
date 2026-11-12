// Round 7: the cloud must not waste its free daily write allowance. Real Worker + real SQLite, writes are counted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../cloud-sync/src/worker.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (_) { console.log(`⚠ SKIPPED cloud write tests: needs Node 22.13 or newer (found ${process.version}).`); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'cloud-sync/schema.sql'), 'utf8'));
const log = [];                       // every statement the Worker runs
const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
const DB = {
  prepare(sql) { return { bind(...a) { return {
    async first() { log.push(sql); return sqlite.prepare(sql).get(...a) ?? null; },
    async all() { log.push(sql); return { results: sqlite.prepare(sql).all(...a) }; },
    async run() { log.push(sql); const r = sqlite.prepare(sql).run(...a); return { success: true, meta: { changes: Number(r.changes) } }; },
    _sql: sql, _args: a
  }; } }; },
  async batch(stmts) { for (const s of stmts) { log.push(s._sql); sqlite.prepare(s._sql).run(...s._args); } return []; }
};
const env = { DB, DEV_MODE: 'true', BREVO_API_KEY: 'x', AES_SECRET: 'test-aes-secret-for-cloud-writes-0123456789', TMDB_API_KEY: 'fake' };

globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.includes('brevo')) return new Response('{}', { status: 201 });
  if (url.includes('api.themoviedb.org/3/search')) return new Response(JSON.stringify({ results: [{ id: 603 }] }), { status: 200 });
  if (url.includes('api.themoviedb.org/3/movie/603')) return new Response(JSON.stringify({ id: 603, overview: 'x', vote_average: 8, vote_count: 100, genres: [], credits: { cast: [], crew: [] }, release_dates: { results: [] } }), { status: 200 });
  throw new Error('outside call ' + url);
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`); };
let ip = 10;
const call = async (method, route, body, token, fixedIp) => {
  const res = await worker.fetch(new Request('https://sync.test' + route, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': fixedIp || ('198.51.100.' + (ip++)), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
};
const writesTo = (re) => log.filter(s => isWrite(s) && re.test(s)).length;

console.log('=== StreamVault cloud — write savings ===\n');
const su = await call('POST', '/api/auth/signup', { email: 'w@example.com', password: 'Secret123!' });
const vf = await call('POST', '/api/auth/verify-code', { email: 'w@example.com', code: su.json.devCode });
const token = vf.json.token;

// 1. TMDB: searches are not stored, details are
log.length = 0;
const sr = await call('GET', '/api/tmdb/search/movie?query=Matrix&year=1999', null, token);
check('a search is answered', sr.status === 200 && sr.json.results[0].id === 603);
check('a search writes nothing to the shared cache', writesTo(/tmdb_cache/) === 0, String(writesTo(/tmdb_cache/)));
const dr = await call('GET', '/api/tmdb/movie/603?append_to_response=credits,external_ids,release_dates,content_ratings', null, token);
check('a title\'s details are stored once', dr.status === 200 && writesTo(/tmdb_cache/) === 1);

// 2. Waiting for the phone link does not write
const rc = await call('POST', '/api/auth/request-code', {}, null, '203.0.113.5');
const code = rc.json.code;
log.length = 0;
let allPending = true;
for (let i = 0; i < 30; i++) { const p = await call('GET', '/api/auth/poll-code?code=' + code, null, null, '203.0.113.5'); if (p.json.status !== 'pending') allPending = false; }
check('30 checks of a live code all answer "pending"', allPending);
check('...and write nothing at all', log.filter(isWrite).length === 0, String(log.filter(isWrite).length));
// guessing wrong codes is still limited (61st attempt in a minute is refused)
let refused = false;
for (let i = 0; i < 70; i++) { const p = await call('GET', '/api/auth/poll-code?code=SV-ZZZ' + (i % 9), null, null, '203.0.113.9'); if (p.status === 429) { refused = true; break; } }
check('guessing codes is still stopped by the limiter', refused);

// 3. Catalogue: upload 450 titles, then page through them
const items = Array.from({ length: 450 }, (_, i) => ({ dedupKey: 'movie:t' + i, mediaType: 'MOVIE', title: 'T' + i, cleanTitle: 'T' + i, year: 2000 + (i % 20), tmdbId: i + 1, overview: 'o', genres: ['Drama'], versions: [{ streamId: String(i) }] }));
for (let i = 0; i < items.length; i += 100) {
  const r = await call('POST', '/api/catalog/sync-batch', { playlistId: 'primary', items: items.slice(i, i + 100) }, token);
  if (r.status !== 200) check('upload works', false, r.text);
}
log.length = 0;
let seen = new Set(), pages = 0, total = null, cursor = '';
let url = '/api/catalog/pull?limit=200';
for (;;) {
  const r = await call('GET', url, null, token);
  pages++;
  if (total === null) total = r.json.total;
  for (const it of r.json.items) seen.add(it.dedupKey);
  if (!r.json.hasMore) break;
  url = `/api/catalog/pull?limit=200&after_updated=${r.json.nextAfterUpdated}&after_item=${encodeURIComponent(r.json.nextAfterItem)}`;
  if (pages > 10) break;
}
check('all 450 titles come back, none twice or missing', seen.size === 450, String(seen.size));
check('450 titles need 3 pages of 200', pages === 3, String(pages));
check('the total is counted once, not on every page', log.filter(s => /COUNT\(\*\)/i.test(s)).length === 1, String(log.filter(s => /COUNT\(\*\)/i.test(s)).length));
check('no page uses OFFSET', !log.some(s => /OFFSET/i.test(s)));
const legacy = await call('GET', '/api/catalog/pull?limit=100&offset=100', null, token);
check('the old ?offset= form still works for older apps', legacy.status === 200 && legacy.json.items.length === 100);

// 4. Removing a title works through the primary key
const mr = await call('POST', '/api/catalog/mark-removed', { dedupKeys: ['movie:t0', 'movie:t1'] }, token);
const gone = sqlite.prepare("SELECT COUNT(*) c FROM catalog_items WHERE is_removed = 1").get().c;
check('removed titles are marked', mr.status === 200 && gone === 2, String(gone));

// 5. Extra indexes are gone
const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
check('the three extra indexes are no longer created', !idx.includes('idx_catalog_acc_dedup') && !idx.includes('idx_catalog_removed') && !idx.includes('idx_tmdb_cache_expires'), idx.join(','));
check('the index the download needs is still there', idx.includes('idx_catalog_acc_upd'));
const mig = fs.readFileSync(path.join(ROOT, 'cloud-sync/migrations/0004_drop_redundant_indexes.sql'), 'utf8');
check('the live-database migration drops the same three', ['idx_catalog_acc_dedup', 'idx_catalog_removed', 'idx_tmdb_cache_expires'].every(n => mig.includes('DROP INDEX IF EXISTS ' + n)));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
