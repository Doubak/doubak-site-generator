import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { generate } from '../src/generate.js';
import { withAlbumThumbnails } from '../src/image-index.js';
const original='https://img3.doubanio.com/view/photo/large/public/p123.jpg';
const thumbnail='https://img3.doubanio.com/view/photo/m/public/p123.jpg';
const album={upstream_id:'42',account:{user_id:'123'},url:'https://www.douban.com/photos/album/42/',revisions:[{last_observed_at:'2026-10-17T00:00:00Z',fields:{title:'Album',cover_photo_id:'123',photos:[{id:'123',image_url:original,thumbnail_url:thumbnail}]}}]};

test('same-photo thumbnail fallback preserves explicit captures and never substitutes a thumbnail for an original',()=>{
 const albums=[{photos:[{imageUrl:original,thumbnailUrl:thumbnail}]}],images={[original]:'/uploads/p123.jpg'};
 assert.deepEqual(withAlbumThumbnails(images,albums),{...images,[thumbnail]:'/uploads/p123.jpg'});
 assert.deepEqual(images,{[original]:'/uploads/p123.jpg'});
 assert.equal(withAlbumThumbnails({...images,[thumbnail]:'/uploads/small.jpg'},albums)[thumbnail],'/uploads/small.jpg');
 assert.equal(withAlbumThumbnails({[thumbnail]:'/uploads/small.jpg'},albums)[original],undefined);
});
test('real filesystem export of an album with only original bytes has no false missing/remote thumbnails',t=>{
 const root=mkdtempSync(join(tmpdir(),'doubak-album-local-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const bundle=join(root,'bundle');mkdirSync(bundle);
 const bytes=readFileSync(new URL('./fixtures/avatar.jpg',import.meta.url));
 const http=Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n\r\n'),bytes]);
 const raw=Buffer.concat([Buffer.from(`WARC/1.1\r\nContent-Length: ${http.length}\r\n\r\n`),http,Buffer.from('\r\n\r\n')]),gz=gzipSync(raw);
 writeFileSync(join(bundle,'assets.warc.gz'),gz);
 writeFileSync(join(bundle,'index-test.ndjson'),JSON.stringify({capture_id:'b#1',url:original,verdict:'ok',surface:'asset',route_key:'asset.photo_image',content_type:'image/jpeg',segment:'assets.warc.gz',offset:0,length:gz.length})+'\n');
 const out=join(root,'site'),report=generate({canonical:{albums:[album]},bundlesDir:bundle,outDir:out});
 assert.equal(report.images.written,1);
 assert.deepEqual(report.images.missing,[]);assert.deepEqual(report.images.remote,[]);
 const text=readFileSync(join(out,'content/album/42.md'),'utf8');assert.doesNotMatch(text,/view\/photo\/m\/public/);
 assert.match(text,/\/uploads\/p123\.jpg/);
 assert.deepEqual(readFileSync(join(out,'static/uploads/p123.jpg')),bytes);
});
