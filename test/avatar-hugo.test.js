import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HUGO_VERSION } from '../src/hugo-bin.js';
import { BADGE_SPECS, run as verifyBadges } from '../tools/assets/generate-badges.mjs';
import { pngPixels } from './helpers/png-pixels.js';
const bytes=readFileSync(new URL('./fixtures/avatar.png',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const hugo=resolve(`.hugo/hugo-${HUGO_VERSION}`);
if (process.env.CI) assert.ok(existsSync(hugo), 'CI must install pinned Hugo before running avatar tests');

// Independent pixel oracle: only the badge rectangle may change.
// Transparent and translucent badge pixels must blend with the avatar, not white.
function assertBadge(image, original) {
 const size = image.width;
 assert.equal(image.height, size);
 const [badgeSize,inset] = {16:[8,0],32:[12,1],180:[36,12]}[size];
 const at = size-badgeSize-inset;
 const badge = pngPixels(readFileSync(`theme/hugo/assets/branding/doubak-badge-${badgeSize}.png`));
 assert.equal(badge.width, badgeSize); assert.equal(badge.height, badgeSize);
 assert.ok(badge.pixels.some(([r,g,b,a]) => g > r * 1.5 && g > b * 1.5 && a === 255), 'green brand tile');
 assert.ok(badge.pixels.some(([r,g,b,a]) => r > 240 && g > 225 && b < 230 && a === 255), 'cream bean');
 const spec = BADGE_SPECS.find(s => s.size === badgeSize);
 const corners = [[0,0],[badgeSize-1,0],[0,badgeSize-1],[badgeSize-1,badgeSize-1]].map(([cx,cy]) => badge.pixels[cy*badgeSize+cx][3]);
 assert.ok(corners.every(a => a === corners[0] && a < spec.maxCornerAlpha), `transparent rounded badge corners (${corners})`);
 assert.ok(badge.pixels.some(p=>p[3]>0 && p[3]<255), 'antialiased alpha edge');
 assert.ok(!badge.pixels.some(([r,g,b,a])=>r>240 && g>240 && b>240 && a>0), 'no white backplate');
 for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
   const base = original(x,y);
   const actual = image.pixels[y*size+x];
   if (x < at || y < at || x >= at+badgeSize || y >= at+badgeSize) {
     assert.equal(actual[3],base[3], `untouched alpha ${size}:${x},${y}`);
     if (base[3]) for(let c=0;c<3;c++) assert.ok(Math.abs(actual[c]-base[c])<=1, `untouched color ${size}:${x},${y}`);
     continue;
   }
   const over = badge.pixels[(y-at)*badgeSize+x-at];
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
   if (size === 96) assert.equal(pngPixels(image).pixels.filter(p => p[3] !== 0).length, 16 * 8);
   else if (size === 180) assertBadge(pngPixels(image), () => [0,128,255,255]);
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
   // Ignore the badge rectangle when measuring the unscaled original.
   assert.equal(image.pixels.filter((p,i) => (i%32 < 19 || i%32 >=31 || Math.floor(i/32) < 19 || Math.floor(i/32) >=31) && p[3] !== 0).length, 123, `${ext}: transparent padding, no upscale`);
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
   const [badgeSize,inset] = icon.width===16 ? [8,0] : [12,1];
   const at=icon.width-badgeSize-inset;
   const badge = pngPixels(readFileSync(`theme/hugo/assets/branding/doubak-badge-${badgeSize}.png`));
   for (let y=0;y<badgeSize;y++) for (let x=0;x<badgeSize;x++) {
     const expected = badge.pixels[y*badgeSize+x];
     if (expected[3] === 255) assert.deepEqual(icon.pixels[(y+at)*icon.width+x+at],expected,'opaque badge pixels survive dark background');
   }
 }
 assert.deepEqual(render('https://example.test/archive/'),first,'cached rebuild is byte-identical');
 assert.deepEqual(render('/').map(f=>f.data),first.map(f=>f.data),'root and subpath hosting use identical PNGs');
 assert.deepEqual(readFileSync(join(dir,'public',path)),square,'archived source bytes remain untouched');
 // Replace the badge in this copied theme with a visibly different local PNG.
 // An unchanged avatar must not cause Hugo to serve a stale composited icon.
 const badgePath = join(dir,'assets/branding/doubak-badge-12.png');
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

test('real Hugo: preserve avatar alpha and composite badge edges without a white matte', {skip:!existsSync(hugo)}, t => {
 const dir=mkdtempSync(join(tmpdir(),'doubak-icon-alpha-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 cpSync('theme/hugo',dir,{recursive:true});
 mkdirSync(join(dir,'content'));
 writeFileSync(join(dir,'content/_index.md'),'---\ntitle: Alpha\n---\n');
 const source=readFileSync(new URL('./fixtures/avatar-alpha.png',import.meta.url));
 const path=`assets/profile/123/${hash(source)}.png`;
 mkdirSync(join(dir,'static/assets/profile/123'),{recursive:true});
 writeFileSync(join(dir,'static',path),source);
 writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
 const result=spawnSync(hugo,['--source',dir],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
 const html=readFileSync(join(dir,'public/index.html'),'utf8');
 const read=pattern=>pngPixels(readFileSync(resolve(dir,'public',pattern.exec(html)[1])));
 const small=read(/sizes="16x16" href="([^"]+)"/);
 const icon=read(/sizes="32x32" href="([^"]+)"/);
 const touch=read(/rel="apple-touch-icon"[^>]*href="([^"]+)"/);
 const header=read(/class="account-avatar" src="([^"]+)"/);
 const original=pngPixels(source);
 assertBadge(icon,(x,y)=>original.pixels[y*32+x]);
 // All four opacity bands survive scaling as well as padding. Sample away from
 // the resize seams and from the badge, including RGB below partial alpha.
 for(const [image,xs,y] of [[small,[1,5,9,13],1],[touch,[12,67,112,167],20],[header,[34,42,50,58],36]]) {
   for(let i=0;i<4;i++) {
     const pixel=image.pixels[y*image.width+xs[i]], alpha=[0,64,128,255][i];
     assert.ok(Math.abs(pixel[3]-alpha)<=1,`alpha ${image.width}, band ${i}: ${pixel}`);
     if(alpha) for(let c=0;c<3;c++) assert.ok(Math.abs(pixel[c]-[40,120,200][c])<=2,`no matte in ${image.width}: ${pixel}`);
   }
 }
 assert.deepEqual(readFileSync(join(dir,'public',path)),source,'original RGBA bytes unchanged');
});

test('real Hugo: touch icon fills the canvas, uses a smaller inset badge, and leaves header unbadged', {skip:!existsSync(hugo)}, t => {
 const dir=mkdtempSync(join(tmpdir(),'doubak-touch-fill-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 cpSync('theme/hugo',dir,{recursive:true});mkdirSync(join(dir,'content'));
 writeFileSync(join(dir,'content/_index.md'),'---\ntitle: Touch\n---\n');
 // A small opaque source previously acquired transparent padding on all sides.
 const path=`assets/profile/123/${hash(bytes)}.png`;
 mkdirSync(join(dir,'static/assets/profile/123'),{recursive:true});writeFileSync(join(dir,'static',path),bytes);
 writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
 const result=spawnSync(hugo,['--source',dir],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
 const html=readFileSync(join(dir,'public/index.html'),'utf8');
 const touch=pngPixels(readFileSync(resolve(dir,'public',/rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html)[1])));
 assert.equal(touch.width,180);assert.equal(touch.height,180);
 assert.ok(touch.pixels.every(p=>p[3]===255),'no added transparent/white outer border');
 assertBadge(touch,()=>[0,128,255,255]);
 const badge=pngPixels(readFileSync('theme/hugo/assets/branding/doubak-badge-36.png'));
 assert.equal(badge.width/touch.width,.2,'large-icon badge occupies 20% of the width, not 50%');
 const header=pngPixels(readFileSync(resolve(dir,'public',/class="account-avatar" src="([^"]+)"/.exec(html)[1])));
 assert.equal(header.pixels.filter(p=>p[3]!==0).length,128,'header still does not enlarge tiny avatars');
 assert.ok(header.pixels.every(p=>p[3]===0 || (p[0]===0 && p[1]===128 && p[2]===255)),'no badge in header');
});

test('badge PNGs match canonical two-bean geometry and keep separated bean lobes', () => {
 assert.deepEqual(verifyBadges({ check: true }), []);
 for (const spec of BADGE_SPECS) {
   const badge = pngPixels(readFileSync(`theme/hugo/assets/branding/doubak-badge-${spec.size}.png`));
   const s = badge.width;
   assert.equal(s, spec.size);
   assert.equal(badge.height, spec.size);
   const at = (x, y) => badge.pixels[y * s + x];
   const bx = Math.floor(s * 0.28), by = Math.floor(s * 0.28);
   const fx = Math.floor(s * 0.64), fy = Math.floor(s * 0.58);
   const back = at(bx, by);
   const front = at(fx, fy);
   assert.ok(back[0] > 240 && back[1] > 225 && back[3] === 255, `${s}px back bean lobe: ${back}`);
   assert.ok(front[0] > 240 && front[1] > 225 && front[3] === 255, `${s}px front bean lobe: ${front}`);
   // Every segment between the two bean centroids must pass through the green dividing channel.
   let hasGreenSeparator = false;
   for (let i = 1; i < 16; i++) {
     const t = i / 16;
     const [r, g, b, a] = at(Math.round(bx + t * (fx - bx)), Math.round(by + t * (fy - by)));
     if (a === 255 && g > r && r < 160 && b < 160) hasGreenSeparator = true;
   }
   assert.ok(hasGreenSeparator, `${s}px badge must separate back and front beans with a green channel`);
 }
});

