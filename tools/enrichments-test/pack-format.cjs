'use strict';
// The Enrichments PACK file format (format 1). ONE file:
//   [ 4096-byte header ][ database (gzip) ][ posters (JPEGs, back to back) ]
// Header: 8 bytes "SVPACK01", 4 bytes (little endian) length of the JSON that follows, then the JSON (unused bytes are zero).
// The JSON header holds: format, version, builtAt, titles, dbOffset, dbGzLength, dbRawLength, dbSha256, postersOffset, postersLength.
// Inside the database every title row has poster_off / poster_len; the poster bytes start at postersOffset + poster_off.
// This lets the TV unpack ONE 30 MB database and then read any poster straight from the file by position.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const MAGIC = 'SVPACK01';
const HEADER = 4096;

const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function assemble(outPath, dbPath, postersPath, meta) {
  const dbRaw = fs.readFileSync(dbPath);
  const dbGz = zlib.gzipSync(dbRaw, { level: 9 });
  const pSize = postersPath && fs.existsSync(postersPath) ? fs.statSync(postersPath).size : 0;
  const header = Object.assign({ format: 1 }, meta, {
    dbOffset: HEADER, dbGzLength: dbGz.length, dbRawLength: dbRaw.length, dbSha256: sha256Buf(dbRaw),
    postersOffset: HEADER + dbGz.length, postersLength: pSize,
  });
  const js = Buffer.from(JSON.stringify(header));
  if (js.length > HEADER - 12) throw new Error('pack header too large');
  const hb = Buffer.alloc(HEADER);
  hb.write(MAGIC, 0, 'ascii'); hb.writeUInt32LE(js.length, 8); js.copy(hb, 12);
  fs.writeFileSync(outPath, Buffer.concat([hb, dbGz]));
  if (pSize) await pipeline(fs.createReadStream(postersPath), fs.createWriteStream(outPath, { flags: 'a' }));
  return header;
}

function readHeader(packPath) {
  const fd = fs.openSync(packPath, 'r');
  try {
    const hb = Buffer.alloc(HEADER);
    fs.readSync(fd, hb, 0, HEADER, 0);
    if (hb.toString('ascii', 0, 8) !== MAGIC) throw new Error('not a StreamVault pack (bad start)');
    const len = hb.readUInt32LE(8);
    return JSON.parse(hb.toString('utf8', 12, 12 + len));
  } finally { fs.closeSync(fd); }
}

function readSlice(packPath, offset, length) {
  const fd = fs.openSync(packPath, 'r');
  try { const b = Buffer.alloc(length); fs.readSync(fd, b, 0, length, offset); return b; } finally { fs.closeSync(fd); }
}

module.exports = { MAGIC, HEADER, assemble, readHeader, readSlice, sha256File, sha256Buf };
