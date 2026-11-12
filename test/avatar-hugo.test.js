import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HUGO_VERSION } from '../src/hugo-bin.js';
import { pngPixels } from './helpers/png-pixels.js';
const bytes=readFileSync(new URL('./fixtures/avatar.png',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const hugo=resolve(`.hugo/hugo-${HUGO_VERSION}`);
if (process.env.CI) assert.ok(existsSync(hugo), 'CI must install pinned Hugo before running avatar tests');

// Independent pixel oracle: pixels outside the lower-right quadrant must be
// untouched; inside it, the committed badge is alpha-composited over the avatar.
function assertBadge(image, original) {
 const size = image.width;
 assert.equal(image.height, size);
 const half = size / 2;
 const badge = pngPixels(readFileSync(`theme/hugo/assets/branding/doubak-badge-${half}.png`));
 assert.equal(badge.width, half); assert.equal(badge.height, half);
 assert.ok(badge.pixels.some(([r,g,b,a]) => g > r * 1.5 && g > b * 1.5 && a === 255), 'green brand tile');
 assert.ok(badge.pixels.some(([r,g,b,a]) => r > 240 && g > 225 && b < 230 && a === 255), 'cream bean');
 // The white outline must survive rasterization (some SVG renderers otherwise
 // default to a black stroke). At 8px it blends with the green tile.
 const edge = badge.pixels[half/2];
 assert.ok(edge[0] > (half === 8 ? 120 : 220) && edge[2] > (half === 8 ? 120 : 220), 'light separating outline');
 for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
   const base = original(x,y);
   const actual = image.pixels[y*size+x];
   if (x < half || y < half) {
     assert.deepEqual(actual, base, `untouched pixel ${size}:${x},${y}`);
     continue;
   }
   const over = badge.pixels[(y-half)*half+x-half];
   const alpha = over[3]/255 + base[3]/255 * (1-over[3]/255);
   const expected = [0,1,2].map(c => alpha ? Math.round((over[c]*over[3]/255 + base[c]*base[3]/255*(1-over[3]/255))/alpha) : 0);
   expected.push(Math.round(alpha*255));
   for (let c=0;c<4;c++) assert.ok(Math.abs(actual[c]-expected[c]) <= 2, `composite pixel ${size}:${x},${y} channel ${c}: ${actual} vs ${expected}`);
 }
}

test('real Hugo: offline local icons, exact canvas sizes, old input and corrupt-image text fallback', {skip:!existsSync(hugo)},t=>{
 const dir=mkdtempSync(join(tmpdir(),'doubak-avatar-hugo-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 cpSync('theme/hugo',dir,{recursive:true});mkdirSync(join(dir,'content'));writeFileSync(join(dir,'content/_index.md'),'---\ntitle: Owner\n---\nHello');
 mkdirSync(join(dir,'content/nested'));writeFileSync(join(dir,'content/nested/page.md'),'---\ntitle: Nested\n---\nHello');
 const run=()=>{const r=spawnSync(hugo,['--source',dir,'--baseURL','https://example.test/archive/'],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);return readFileSync(join(dir,'public/index.html'),'utf8');};
 const plain = run();
 assert.doesNotMatch(plain,/rel="icon"/);
 assert.doesNotMatch(plain,/apple-touch-icon|account-avatar/);
 assert.match(plain,/<h1 class="home">/);
 const path=`assets/profile/123/${hash(bytes)}.png`;
 mkdirSync(join(dir,'static/assets/profile/123'),{recursive:true});writeFileSync(join(dir,'static',path),bytes);
 writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
 const html=run();assert.match(html,/<h1 class="home has-avatar">/);
 assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
 assert.match(html,/apple-touch-icon/);assert.match(html,/class="account-avatar"[^>]*alt=""/);
 for(const [pattern,size] of [[/rel="icon"[^>]*sizes="16x16"[^>]*href="([^"]+)"/,16],[/rel="icon"[^>]*sizes="32x32"[^>]*href="([^"]+)"/,32],[/rel="apple-touch-icon"[^>]*href="([^"]+)"/,180],[/class="account-avatar" src="([^"]+)"/,96]]) {
   const src=pattern.exec(html)?.[1];assert.ok(src,html);assert.doesNotMatch(src,/^https?:/);
   const image=readFileSync(resolve(dir,'public',src));assert.equal(image.readUInt32BE(16),size);assert.equal(image.readUInt32BE(20),size);
   if (size > 32) assert.equal(pngPixels(image).pixels.filter(p => p[3] !== 0).length, 16 * 8);
   else assertBadge(pngPixels(image), (x,y) => x >= (size-16)/2 && x < (size+16)/2 && y >= (size-8)/2 && y < (size+8)/2 ? [0,128,255,255] : [0,0,0,0]);
 }
 const nested=readFileSync(join(dir,'public/nested/page.html'),'utf8');assert.match(nested,/src="\.\.\/assets\/profile\//);
 assert.equal(existsSync(join(dir,'public/profile')), false, 'profile/ 不该产生，图标应统一置于 assets/profile/ 之下');
 for (const ext of ['jpg','gif','webp']) {
   const source=readFileSync(new URL(`./fixtures/avatar.${ext}`,import.meta.url));
   const name=`assets/profile/123/${hash(source)}.${ext}`;
   writeFileSync(join(dir,'static',name),source);
   writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:name}));
   const rendered = run();
   assert.match(rendered,/apple-touch-icon/,`Hugo must decode ${ext}`);
   const icon = /rel="icon"[^>]*sizes="32x32"[^>]*href="([^"]+)"/.exec(rendered)[1];
   const image = pngPixels(readFileSync(resolve(dir,'public',icon)));
   // Ignore the badged quadrant when measuring the unscaled original.
   assert.equal(image.pixels.filter((p,i) => (i%32 < 16 || Math.floor(i/32) < 16) && p[3] !== 0).length, 96, `${ext}: transparent padding, no upscale`);
   assert.equal(image.pixels[0][3], 0, `${ext}: transparent corner`);
   if (ext === 'gif') assert.deepEqual(image.pixels[15 * 32 + 15], [0,128,255,255], 'GIF first frame');
 }
 writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
 // Corrupt pixels must reach the decoder guard without aborting the site build.
 writeFileSync(join(dir,'static',path),Buffer.from('broken image'));
 assert.doesNotMatch(run(),/rel="icon"|apple-touch-icon|account-avatar/);
});

test('real Hugo: square avatar badges survive downscaling, cached rebuilds, badge and account changes', {skip:!existsSync(hugo)}, t => {
 const dir = mkdtempSync(join(tmpdir(),'doubak-favicon-badge-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 cpSync('theme/hugo',dir,{recursive:true});
 mkdirSync(join(dir,'content/deep/nested'),{recursive:true});
 writeFileSync(join(dir,'content/_index.md'),'---\ntitle: Owner\n---\n');
 writeFileSync(join(dir,'content/deep/nested/page.md'),'---\ntitle: Deep\n---\n');
 const square = readFileSync(new URL('./fixtures/avatar-square.png',import.meta.url));
 const setAvatar = (uid,data) => {
   const path = `assets/profile/${uid}/${hash(data)}.png`;
   mkdirSync(join(dir,'static/assets/profile',uid),{recursive:true});
   writeFileSync(join(dir,'static',path),data);
   writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
   return path;
 };
 const path = setAvatar('123',square);
 const render = baseURL => {
   const r = spawnSync(hugo,['--source',dir,'--baseURL',baseURL],{encoding:'utf8'});
   assert.equal(r.status,0,r.stdout+r.stderr);
   const files = [];
   for (const page of ['index.html','deep/nested/page.html']) {
     const html = readFileSync(join(dir,'public',page),'utf8');
     const icons = [...html.matchAll(/rel="icon" type="image\/png" sizes="(16|32)x\1" href="([^"]+)"/g)];
     assert.equal(icons.length,2);
     for (const [,size,href] of icons) {
       assert.doesNotMatch(href,/^(?:\/|[a-z]+:)/i,'icons must work under file:// and a hosted subpath');
       const fileURL = new URL(href,`file://${join(dir,'public',page)}`);
       const data = readFileSync(fileURL);
       assert.equal(pngPixels(data).width,Number(size));
       files.push({href,data});
     }
   }
   assert.deepEqual(files[0].data,files[2].data,'nested 16px icon is the same file');
   assert.deepEqual(files[1].data,files[3].data,'nested 32px icon is the same file');
   return files;
 };
 const first = render('https://example.test/archive/');
 for (const {data} of first.slice(0,2)) {
   const icon = pngPixels(data);
   // Stay away from the resampling seam; the full square remains opaque.
   assert.ok(icon.pixels.every(p=>p[3]===255));
   assert.deepEqual(icon.pixels[0],[240,240,240,255]);
   assert.deepEqual(icon.pixels[icon.width-1],[24,24,24,255]);
   const half = icon.width/2;
   const badge = pngPixels(readFileSync(`theme/hugo/assets/branding/doubak-badge-${half}.png`));
   for (let y=0;y<half;y++) for (let x=2;x<half;x++) {
     const expected = badge.pixels[y*half+x];
     if (expected[3] === 255) assert.deepEqual(icon.pixels[(y+half)*icon.width+x+half],expected,'opaque badge pixels survive dark background');
   }
 }
 assert.deepEqual(render('https://example.test/archive/'),first,'cached rebuild is byte-identical');
 assert.deepEqual(render('/').map(f=>f.data),first.map(f=>f.data),'root and subpath hosting use identical PNGs');
 assert.deepEqual(readFileSync(join(dir,'public',path)),square,'archived source bytes remain untouched');
 // Replace the badge in this copied theme with a visibly different local PNG.
 // An unchanged avatar must not cause Hugo to serve a stale composited icon.
 const badgePath = join(dir,'assets/branding/doubak-badge-16.png');
 const oldBadge = readFileSync(badgePath);
 writeFileSync(badgePath,square);
 const changedBadge = render('https://example.test/archive/');
 assert.deepEqual(changedBadge[0],first[0],'16px variant has its own unchanged badge');
 assert.notEqual(changedBadge[1].href,first[1].href,'badge update changes the favicon URL');
 assert.notDeepEqual(changedBadge[1].data,first[1].data,'badge update changes the favicon pixels');
 writeFileSync(badgePath,oldBadge);
 assert.deepEqual(render('https://example.test/archive/'),first,'restoring badge restores deterministic output');
 setAvatar('456',bytes);
 const second = render('https://example.test/archive/');
 for(let i=0;i<2;i++) {
   assert.notEqual(second[i].href,first[i].href,'account switch cannot reuse old icon URL');
   assert.notDeepEqual(second[i].data,first[i].data);
   const icon=pngPixels(second[i].data), size=icon.width;
   assertBadge(icon,(x,y)=>x >= (size-16)/2 && x < (size+16)/2 && y >= (size-8)/2 && y < (size+8)/2 ? [0,128,255,255] : [0,0,0,0]);
 }
});

