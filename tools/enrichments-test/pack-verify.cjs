'use strict';
// Checks a finished pack file: header, checksum against the manifest, database readable, poster positions point at real JPEGs.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const PF = require('./pack-format.cjs');
const dir = process.argv[2] || path.join(__dirname, 'out');
const pack = path.join(dir, 'streamvault-pack.svpack');
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const L = []; let bad = 0;
const ok = (c, m) => { L.push((c ? 'OK   ' : 'FAIL ') + m); if (!c) bad++; };
(async () => {
  const h = PF.readHeader(pack);
  ok(h.format === 1, 'header readable, format 1, version ' + h.version);
  ok(fs.statSync(pack).size === man.size, 'file size equals manifest (' + man.size + ' bytes)');
  ok(h.postersOffset + h.postersLength === man.size, 'sections add up to the file size');
  ok((await PF.sha256File(pack)) === man.sha256, 'whole-file checksum equals manifest');
  const raw = zlib.gunzipSync(PF.readSlice(pack, h.dbOffset, h.dbGzLength));
  ok(raw.length === h.dbRawLength && PF.sha256Buf(raw) === h.dbSha256, 'database unpacks and its checksum matches');
  const tmp = path.join(dir, 'verify.db'); fs.writeFileSync(tmp, raw);
  const db = new DatabaseSync(tmp);
  const one = (q) => db.prepare(q).get();
  const n = one('SELECT COUNT(*) c FROM titles').c;
  ok(n === h.titles, 'title rows ' + n + ' = header titles ' + h.titles);
  ok(one("SELECT COUNT(*) c FROM titles WHERE type NOT IN ('movie','series')").c === 0, 'every row is a movie or a series');
  ok(one("SELECT COUNT(*) c FROM titles WHERE title IS NULL OR title=''").c === 0, 'no row without a title');
  ok(one('SELECT COUNT(*) c FROM aliases a LEFT JOIN titles t ON t.pid=a.pid WHERE t.pid IS NULL').c === 0, 'every name-index row points at a title');
  ok(one("SELECT COUNT(*) c FROM titles WHERE rating_source<>'' AND (rating<=0 OR rating_votes<=0)").c === 0, 'rated titles have a rating and votes');
  ok(one("SELECT COUNT(*) c FROM titles WHERE (rating_source='I' AND rating_votes<10) OR (rating_source='T' AND rating_votes<5)").c === 0, 'rating rule respected (I>=10 votes, T>=5 votes)');
  ok(one('SELECT COUNT(*) c FROM titles WHERE kids_ok=1 AND certification=\'\'').c === 0, 'no Kids title without an age rating');
  const withPoster = db.prepare('SELECT pid, poster_off, poster_len FROM titles WHERE poster_off IS NOT NULL').all();
  let badP = 0, okP = 0; const badEx = [];
  const step = Math.max(1, Math.floor(withPoster.length / 400));
  for (let i = 0; i < withPoster.length; i += step) {
    const r = withPoster[i]; const b = PF.readSlice(pack, h.postersOffset + r.poster_off, Math.min(r.poster_len, 4));
    if (b[0] === 0xff && b[1] === 0xd8) okP++; else { badP++; if (badEx.length < 5) badEx.push('pid ' + r.pid + ' starts with bytes ' + b.toString('hex')); }
  }
  ok(badP === 0, 'posters: ' + okP + ' of ' + (okP + badP) + ' sampled start with a JPEG marker' + (badP ? ' — NOT JPEG: ' + badEx.join('; ') : '') + ' (' + withPoster.length + ' stored)');
  ok(r_end(withPoster), 'every poster lies inside the posters section');
  function r_end(list) { return list.every((r) => r.poster_off >= 0 && r.poster_off + r.poster_len <= h.postersLength); }
  db.close(); fs.unlinkSync(tmp);
  L.push(bad ? '\n' + bad + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  fs.writeFileSync(path.join(dir, 'pack-verify.txt'), L.join('\n') + '\n');
  console.log(L.join('\n'));
  process.exit(bad ? 1 : 0);
})();
