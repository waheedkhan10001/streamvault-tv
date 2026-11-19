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
  // poster size picture: how big are they and what width are they really (w342 posters should be 342 pixels wide)
  const lens = withPoster.map((r) => r.poster_len).sort((x, y) => x - y);
  const q = (f) => Math.round(lens[Math.min(lens.length - 1, Math.floor(lens.length * f))] / 1024);
  L.push('INFO poster sizes KB: min ' + Math.round(lens[0] / 1024) + '  median ' + q(0.5) + '  90% ' + q(0.9) + '  99% ' + q(0.99) + '  max ' + Math.round(lens[lens.length - 1] / 1024) + '  average ' + Math.round(lens.reduce((x, y) => x + y, 0) / lens.length / 1024) + '  total ' + (lens.reduce((x, y) => x + y, 0) / 1048576).toFixed(0) + ' MB');
  const widths = {};
  for (let i = 0; i < withPoster.length; i += step) {
    const r = withPoster[i]; const b = PF.readSlice(pack, h.postersOffset + r.poster_off, Math.min(r.poster_len, 131072));
    let w = 0;
    for (let k = 2; k + 9 < b.length;) { if (b[k] !== 0xff) { k++; continue; } const m = b[k + 1]; if (m === 0xff) { k++; continue; } if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { w = b.readUInt16BE(k + 7); break; } k += 2 + b.readUInt16BE(k + 2); }
    widths[w] = (widths[w] || 0) + 1;
  }
  L.push('INFO poster pixel widths (sample): ' + Object.entries(widths).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => k + 'px x' + v).join(', '));
  function r_end(list) { return list.every((r) => r.poster_off >= 0 && r.poster_off + r.poster_len <= h.postersLength); }
  db.close(); fs.unlinkSync(tmp);
  L.push(bad ? '\n' + bad + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  fs.writeFileSync(path.join(dir, 'pack-verify.txt'), L.join('\n') + '\n');
  console.log(L.join('\n'));
  process.exit(bad ? 1 : 0);
})();
