// Guards the agreement between the screen and the TV engine (the Kotlin code is only compiled by the build,
// so we check the names it sends against the names the screen reads).
import fs from 'node:fs';
const kt = fs.readFileSync(new URL('../app/src/main/java/com/streamvault/tv/data/AppApiRouter.kt', import.meta.url), 'utf8');
// the screen is one page plus its style/script files (ui/*.js): read them together
const assetsDir = new URL('../app/src/main/assets/', import.meta.url);
const ui = fs.readFileSync(new URL('tv-ui.html', assetsDir), 'utf8') +
  fs.readdirSync(new URL('ui/', assetsDir)).sort().map(f => fs.readFileSync(new URL('ui/' + f, assetsDir), 'utf8')).join('\n');
let bad = 0;
const check = (n, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) bad++; };
check('screen reads "related" for More Like This', /data\.related/.test(ui));
check('engine sends "related" in the detail answer', /put\("related"/.test(kt));
check('screen reads item.episodes for series', /item\.episodes/.test(ui));
check('engine puts episodes inside the item', /itemJson\.put\("episodes"/.test(kt));
check('engine sends episode length (durationSecs)', /put\("durationSecs"/.test(kt));
check('engine sends the details-lookup total (totalToEnrich) the strip reads', /put\("totalToEnrich"/.test(kt) && /sync\.totalToEnrich/.test(ui));
const poster = ui.match(/id="detailPosterBox" style="[^"]*height:(\d+)px/);
const col = ui.match(/id="detailInfoColumn" style="[^"]*min-height:(\d+)px/);
check('detail poster is as tall as the info column', poster && col && poster[1] === col[1]);
console.log(`${bad ? bad + ' FAILED' : 'all contract checks passed'}`);
process.exit(bad ? 1 : 0);
