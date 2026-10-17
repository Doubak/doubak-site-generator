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
test('real Hugo: offline local icons, exact canvas sizes, old input and corrupt-image text fallback', {skip:!existsSync(hugo)},t=>{
 const dir=mkdtempSync(join(tmpdir(),'doubak-avatar-hugo-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 cpSync('theme/hugo',dir,{recursive:true});mkdirSync(join(dir,'content'));writeFileSync(join(dir,'content/_index.md'),'---\ntitle: Owner\n---\nHello');
 mkdirSync(join(dir,'content/nested'));writeFileSync(join(dir,'content/nested/page.md'),'---\ntitle: Nested\n---\nHello');
 const run=()=>{const r=spawnSync(hugo,['--source',dir,'--baseURL','https://example.test/archive/'],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);return readFileSync(join(dir,'public/index.html'),'utf8');};
 const plain = run();
 assert.doesNotMatch(plain,/apple-touch-icon|account-avatar/);
 assert.match(plain,/<h1 class="home">/);
 const path=`assets/profile/123/${hash(bytes)}.png`;
 mkdirSync(join(dir,'static/assets/profile/123'),{recursive:true});writeFileSync(join(dir,'static',path),bytes);
 writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
 const html=run();assert.match(html,/<h1 class="home has-avatar">/);
 assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
 assert.match(html,/apple-touch-icon/);assert.match(html,/class="account-avatar"[^>]*alt=""/);
 for(const [pattern,size] of [[/rel="icon"[^>]*href="([^"]+)"/,32],[/rel="apple-touch-icon"[^>]*href="([^"]+)"/,180],[/class="account-avatar" src="([^"]+)"/,96]]) {
   const src=pattern.exec(html)?.[1];assert.ok(src,html);assert.doesNotMatch(src,/^https?:/);
   const image=readFileSync(resolve(dir,'public',src));assert.equal(image.readUInt32BE(16),size);assert.equal(image.readUInt32BE(20),size);
   assert.equal(pngPixels(image).pixels.filter(p => p[3] !== 0).length, 16 * 8);
 }
 const nested=readFileSync(join(dir,'public/nested/page.html'),'utf8');assert.match(nested,/src="\.\.\/assets\/profile\//);
 for (const ext of ['jpg','gif','webp']) {
   const source=readFileSync(new URL(`./fixtures/avatar.${ext}`,import.meta.url));
   const name=`assets/profile/123/${hash(source)}.${ext}`;
   writeFileSync(join(dir,'static',name),source);
   writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:name}));
   const rendered = run();
   assert.match(rendered,/apple-touch-icon/,`Hugo must decode ${ext}`);
   const icon = /rel="icon"[^>]*href="([^"]+)"/.exec(rendered)[1];
   const image = pngPixels(readFileSync(resolve(dir,'public',icon)));
   assert.equal(image.pixels.filter(p => p[3] !== 0).length, 16 * 8, `${ext}: transparent padding, no upscale`);
   assert.equal(image.pixels[0][3], 0, `${ext}: transparent corner`);
   if (ext === 'gif') assert.deepEqual(image.pixels[16 * 32 + 16], [0,128,255,255], 'GIF first frame');
 }
 writeFileSync(join(dir,'site-profile.json'),JSON.stringify({status:'ok',avatar:path}));
 // Corrupt pixels must reach the decoder guard without aborting the site build.
 writeFileSync(join(dir,'static',path),Buffer.from('broken image'));
 assert.doesNotMatch(run(),/apple-touch-icon|account-avatar/);
});

