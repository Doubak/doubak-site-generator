import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project } from '../src/projection.js';
import { buildPages } from '../src/pages.js';
import { broadcastBlock } from '../src/markdown.js';
import { generate } from '../src/generate.js';
import { HUGO_VERSION } from '../src/hugo-bin.js';

const account = { user_id: '123' };
const broadcast = (id='42', url=`https://www.douban.com/people/123/status/${id}/`) => ({
  account, upstream_id:id, url,
  revisions:[{fields:{text:'My broadcast',visibility:'public',posted_at:{iso:'2026-11-11T10:00:00Z',raw:'2026-11-11 18:00:00'}}}],
});
const row = (overrides={}) => ({
  capture_id:'bundle#000001',intent:'broadcast.comments_snapshot',route_key:'broadcast.comments_snapshot',
  surface:'api',verdict:'ok',observed_at:'2026-11-11T11:00:00Z',item_count:2,
  url:'https://m.douban.com/rexxar/api/v2/status/42/comments?start=0&count=20',...overrides,
});
const bundles = rows => [{account,rows}];
const projected = rows => project({broadcasts:[broadcast()]},{replySnapshots:bundles(rows)}).broadcasts[0];

test('successful first page shows a lower bound and Douban link; no replies enter pages or search',()=>{
  const data={broadcasts:[broadcast()]};
  const input=structuredClone(data);
  const r=row();Object.defineProperty(r,'payload',{get(){throw Error('must not read reply bodies');}});
  const p=project(data,{replySnapshots:bundles([r])});
  const block=broadcastBlock(p.broadcasts[0]);
  assert.match(block,/\[2\+ 条回复\]\(https:\/\/www\.douban\.com\/people\/123\/status\/42\//);
  assert.match(block,/抓取时的顶层回复下限，不代表完整讨论/);
  assert.ok(block.startsWith('### 2026-11-11 18:00:00\n'),'stable timestamp anchor');
  const built=buildPages(p), plain=buildPages(project(data));
  for(const name of ['content/_index.md','content/broadcast/2026-11.md']) {
    assert.match(new Map(built.files).get(name),/2\+ 条回复/);
  }
  assert.deepEqual(built.search,plain.search,'counts do not become searchable discussion content');
  assert.deepEqual(data,input,'canonical unchanged');
  assert.deepEqual(project(data),project(data,{replySnapshots:[]}),'old inputs unchanged');
});

test('latest successful observation wins independently of input order, retries and duplicate bundles',()=>{
  const older=row({item_count:20,observed_at:'2026-11-11T20:00:00+11:00'});
  const newer=row({capture_id:'new#1',item_count:3,observed_at:'2026-11-11T10:00:00Z'});
  const failed=row({capture_id:'failed#1',item_count:19,verdict:'unclassified',observed_at:'2026-11-12T00:00:00Z'});
  for(const rows of [[older,newer,failed],[failed,newer,older],[newer,newer,older]]) assert.equal(projected(rows).replySnapshotCount,3);
  const tied=row({capture_id:'z#1',item_count:1,observed_at:newer.observed_at});
  assert.equal(projected([tied,newer]).replySnapshotCount,1);
  assert.equal(projected([newer,tied]).replySnapshotCount,1);
});

test('empty or unknown first-page counts do not claim zero total replies',()=>{
  for(const count of [0,null,undefined]) {
    const md=broadcastBlock(projected([row({item_count:count})]));
    assert.match(md,/\[回复首屏\]/);assert.doesNotMatch(md,/0\+? 条回复/);
  }
});

for(const overrides of [
  {verdict:'denied'},{verdict:'login'},{verdict:'soft404'},{verdict:'unclassified'},
  {intent:'broadcast.item'},{route_key:'broadcast.item'},{surface:'html'},
  {item_count:-1},{item_count:21},{item_count:1.5},{item_count:'2'},
  {observed_at:'invalid'},{capture_id:null},
  ...['https://evil.test/rexxar/api/v2/status/42/comments?start=0&count=20',
    'https://m.douban.com/rexxar/api/v2/status/42/comments?start=20&count=20',
    'https://m.douban.com/rexxar/api/v2/status/42/comments?start=0&count=100',
    'https://m.douban.com/rexxar/api/v2/status/42/comments?start=0&start=20&count=20',
    'javascript:alert(1)','https://user@m.douban.com/rexxar/api/v2/status/42/comments?start=0&count=20',
  ].map(url=>({url})),
]) test(`ignore unsupported snapshot metadata ${JSON.stringify(overrides)}`,()=>{
  assert.equal(Object.hasOwn(projected([row(overrides)]),'replySnapshotCount'),false);
});

test('accounts and status/topic ID domains cannot collide; no guesses for missing identities',()=>{
  const topic=broadcast('999','https://www.douban.com/topic/42/?tracking=yes');
  const data={broadcasts:[broadcast(),topic]};
  const snapshots=[...bundles([row()]),{account:{user_id:'456'},rows:[row({item_count:19})]},
    {account,rows:[row({item_count:4,url:'https://m.douban.com/rexxar/api/v2/group/topic/42/comments?start=0&count=20&nested=1'})]}];
  assert.deepEqual(project(data,{replySnapshots:snapshots}).broadcasts.map(b=>b.replySnapshotCount),[2,4]);
  for(const acc of [null,{}, {user_id:'unknown'}, {user_id:'456'}]) {
    const b=project({broadcasts:[broadcast()]},{replySnapshots:[{account:acc,rows:[row()]}]}).broadcasts[0];
    assert.equal(Object.hasOwn(b,'replySnapshotCount'),false);
  }
  for(const url of [null,'https://evil.test/topic/42/','https://www.douban.com/group/topic/42/']) {
    const b=project({broadcasts:[broadcast('42',url)]},{replySnapshots:snapshots}).broadcasts[0];
    assert.equal(Object.hasOwn(b,'replySnapshotCount'),false);
  }
});

const hugo=resolve(`.hugo/hugo-${HUGO_VERSION}`);
if(process.env.CI) assert.ok(existsSync(hugo),'CI must install pinned Hugo');
test('Node generator and real Hugo show the badge on home, broadcast list and month; no raw payload export', {skip:!existsSync(hugo)}, t=>{
  const dir=mkdtempSync(join(tmpdir(),'doubak-reply-indicator-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,'bundles'), bdir=join(root,'nested/archive');mkdirSync(bdir,{recursive:true});
  writeFileSync(join(bdir,'manifest.json'),JSON.stringify({account}));
  writeFileSync(join(bdir,'index-bundle.ndjson'),JSON.stringify(row())+'\n');
  // These bytes must never be read or copied. Index metadata is all the badge needs.
  writeFileSync(join(bdir,'private-replies.json'),'PRIVATE_REPLY_AUTHOR_AND_TEXT');
  const out=join(dir,'site');const canonical={broadcasts:[broadcast()]};
  const run=(data=canonical,opts={})=>generate({canonical:data,bundlesDir:root,outDir:out,themeDir:resolve('theme/hugo'),...opts});
  run();
  const r=spawnSync(hugo,['--source',out,'--baseURL','https://example.test/archive/'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);
  for(const page of ['index.html','broadcast/index.html','broadcast/2026-11.html']) {
    const html=readFileSync(join(out,'public',page),'utf8');
    assert.match(html,/<a href="https:\/\/www\.douban\.com\/people\/123\/status\/42\/" title="归档回复首屏[^\"]*">2\+ 条回复<\/a>/);
    assert.doesNotMatch(html,/PRIVATE_REPLY|rexxar|bundle#000001/);
  }
  assert.equal(existsSync(join(out,'public/private-replies.json')),false);
  assert.doesNotMatch(readFileSync(join(out,'static/search-index.js'),'utf8'),/归档回复首屏|PRIVATE_REPLY/);
  const hidden=broadcast();hidden.revisions[0].fields.visibility='private';
  run({broadcasts:[hidden]});assert.doesNotMatch(readFileSync(join(out,'content/_index.md'),'utf8'),/条回复|回复首屏/);
  run(canonical,{bundlesDir:null});assert.doesNotMatch(readFileSync(join(out,'content/broadcast/2026-11.md'),'utf8'),/条回复|回复首屏/);
});
