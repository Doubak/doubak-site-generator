import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { selectAvatar, avatarOutput, inspectAvatar } from '../src/avatar.js';
import { indexImages, exportAvatar, releaseSegments } from '../src/images.js';
const bytes=readFileSync(new URL('./fixtures/avatar.png',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const uid='123', url='https://img3.doubanio.com/icon/up123-1.png';
const observation=(day)=>({bundle_id:`b${day}`,capture_ids:[`b${day}#000001`],observed_at:`2026-10-${day}T00:00:00Z`});
const canonical=(observations=[observation('01')], avatar_url=url)=>({profile:[{account:{user_id:uid},revisions:[{fields:{nickname:'Owner',avatar_url},observations}]}]});
function bundle(day='01',body=bytes) {
 return {host:day,account:{user_id:uid},rows:[{capture_id:`b${day}#000001`,intent:'profile.overview',surface:'html',verdict:'ok'},
 {capture_id:`b${day}#000002`,parent_capture_id:`b${day}#000001`,route_key:'asset.account_avatar',intent:'asset.image.account_avatar',surface:'asset',verdict:'ok',url,
 observed_at:`2026-10-${day}T00:00:01Z`,content_type:'image/png',content_sha256:hash(body)}]};
}
test('raster bytes, MIME, bounds, checksum and truncation are checked',()=>{
 assert.deepEqual(inspectAvatar(bytes,'image/png'),{width:16,height:8,mime:'image/png',ext:'png'});
 for(const bad of [Buffer.from('<svg></svg>'),bytes.subarray(0,-4),Buffer.alloc(6*1024*1024)]) assert.throws(()=>inspectAvatar(bad,'image/png'));
 assert.throws(()=>inspectAvatar(bytes,'image/jpeg'));
 for (const [ext,mime] of [['jpg','image/jpeg'],['gif','image/gif'],['webp','image/webp']]) {
   const body=readFileSync(new URL(`./fixtures/avatar.${ext}`,import.meta.url));
   assert.deepEqual(inspectAvatar(body,mime),{width:16,height:8,mime,ext});
   assert.throws(()=>inspectAvatar(body.subarray(0,-3),mime));
 }
 const broken=Buffer.from(bytes);broken[40]^=1;assert.throws(()=>inspectAvatar(broken,'image/png'));
});
test('latest explicit observation wins, including same URL; missing new asset never borrows old',()=>{
 const changed=readFileSync(new URL('./fixtures/avatar.gif',import.meta.url));
 const a=bundle(),b=bundle('02',changed);b.rows[1].content_type='image/gif'; const c=canonical([observation('01'),observation('02')]);
 const picked=selectAvatar(c,[a,b]);
 assert.equal(picked.hits[0].host,'02');
 assert.equal(avatarOutput(picked,picked.hits[0],changed,hash(changed)).avatar,`assets/profile/123/${hash(changed)}.gif`);
 assert.deepEqual(selectAvatar(c,[a,b]),selectAvatar(c,[b,a]));
 b.rows.pop();assert.equal(selectAvatar(c,[a,b]).metadata.status,'missing');
 c.profile[0].revisions[0].observations[1].omitted_fields=['avatar_url'];
 assert.equal(selectAvatar(c,[a,b]).hits[0].host,'01');
 assert.equal(selectAvatar(canonical(undefined,null),[a]).metadata.status,'default');
 assert.equal(selectAvatar({},[a]).metadata.status,'unobserved');
});
test('asset evidence must match UID, parent, route, surface, URL and digest',()=>{
 for(const change of [{account:{user_id:'999'}},{rows:[{verdict:'challenge'},{}]},{rows:[{surface:'asset'},{}]},
 {rows:[{},{parent_capture_id:'foreign#000001'}]},{rows:[{},{url:url+'?other'}]},{rows:[{},{intent:'asset.image.user_upload'}]}]) {
  const b=bundle();if(change.account)b.account=change.account;else change.rows.forEach((r,i)=>Object.assign(b.rows[i],r));
  assert.equal(selectAvatar(canonical(),[b]).hits.length,0);
 }
 const selection=selectAvatar(canonical(),[bundle()]);
 const out=avatarOutput(selection,selection.hits[0],bytes,hash(bytes));
 assert.equal(out.avatar,`assets/profile/123/${hash(bytes)}.png`);
 assert.throws(()=>avatarOutput(selection,selection.hits[0],bytes,'0'.repeat(64)));
});
test('filesystem export verifies WARC payload and emits local sidecar, including missing and old inputs',t=>{
 const dir=mkdtempSync(join(tmpdir(),'doubak-avatar-'));t.after(()=>{releaseSegments();rmSync(dir,{recursive:true,force:true});});
 const b=bundle(),http=Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n\r\n'),bytes]);
 const raw=Buffer.concat([Buffer.from(`WARC/1.1\r\nContent-Length: ${http.length}\r\n\r\n`),http,Buffer.from('\r\n\r\n')]);
 const gz=gzipSync(raw);writeFileSync(join(dir,'assets-0.warc.gz'),gz);
 Object.assign(b.rows[1],{segment:'assets-0.warc.gz',offset:0,length:gz.length});
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({account:b.account}));
 writeFileSync(join(dir,'index-b01.ndjson'),b.rows.map(r=>JSON.stringify(r)).join('\n'));
 const out=join(dir,'out');mkdirSync(out);const index=indexImages(dir);
 const meta=exportAvatar({canonical:canonical(),index,outDir:out});
 assert.equal(meta.status,'ok');assert.deepEqual(readFileSync(join(out,'static',meta.avatar)),bytes);
 assert.deepEqual(JSON.parse(readFileSync(join(out,'site-profile.json'))),meta);
 assert.equal(exportAvatar({canonical:canonical([observation('02')]),index,outDir:out}).status,'missing');
 assert.equal(exportAvatar({canonical:{},index,outDir:out}).status,'unobserved');
});

test('observation chronology uses actual instants and capture-ID ties, and flat legacy profiles remain optional',()=>{
 const old=observation('01'), newer=observation('02');
 old.observed_at='2026-10-02T01:00:00+11:00';newer.observed_at='2026-10-01T15:00:00Z';
 assert.equal(selectAvatar(canonical([old,newer]),[bundle(),bundle('02')]).hits[0].host,'02');
 newer.observed_at='2026-10-01T14:00:00Z';
 assert.equal(selectAvatar(canonical([newer,old]),[bundle('02'),bundle()]).hits[0].host,'02');
 assert.equal(selectAvatar({profile:{nickname:'Legacy'}},[]).metadata.status,'unobserved');
});
