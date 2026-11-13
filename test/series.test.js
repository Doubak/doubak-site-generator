import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/projection.js';
import { projectSeries } from '../src/series.js';
import { buildPages } from '../src/pages.js';
import { filterCanonicalByAccount } from '../src/canonical.js';
const at=n=>`2026-01-0${n}T00:00:00Z`;
export const item=(id,title=`Name ${id}`)=>({medium:'movie',id,title,season_label:null});
export const series=items=>({kind:'douban_same_series',source:'embedded_config',items,scope:'complete',claimed_total:items.length+1,series_url:'https://movie.douban.com/series/ABC',more_url:null});
export function revision(n,fields,omitted=[],parser='test/1') { return {parser_version:parser,first_observed_at:at(n),last_observed_at:at(n),fields,digests:{},observations:[{bundle_id:'bundle',capture_ids:[`capture${n}`],observed_at:at(n),absence_authority:'none',surface:'html',omitted_fields:omitted}]}; }
export function canonical() {
  const marks=['1','2','3'].map(id=>({canonical_version:'canonical/1.4',account:{user_id:'111'},upstream_id:id,identity_layer:'upstream_id',medium:'movie',subject:{id,url:`https://movie.douban.com/subject/${id}/`},revisions:[revision(1,{status:'done',rating:4,comment:'My comment',tags:[],marked_at:{iso:'2026-01-01',raw:'2026-01-01',precision:'day'}})]}));
  const subjects=marks.map(m=>({medium:'movie',id:m.subject.id,revisions:[revision(1,{title:`Local ${m.subject.id}`},['series'])]}));
  return {marks,subjects};
}
const page=(c,id)=>new Map(buildPages(project(c)).files).get(`content/movie/${id}.md`);

test('series evidence crosses inherited revisions; later lists do not refresh evidence dates',()=>{
  const s=series([item('2')]), subject={medium:'movie',revisions:[revision(1,{series:s}),revision(2,{series:s,title:'new'},['series','info','aliases'])]};
  const p=projectSeries(subject);assert.equal(p.at,at(1));assert.equal(p.unionItems.length,1);assert.equal(p.laterUnknown,false);
  subject.revisions.push(revision(3,{series:s},['series','title','cover_url','raw_meta']));
  assert.equal(projectSeries(subject).laterUnknown,true);
  subject.revisions.push(revision(4,{series:s})); assert.equal(projectSeries(subject).at,at(4));
});
test('actual page links/status only; self hidden, self-inclusive complete total; escaped titles and labels',()=>{
  const c=canonical(); c.subjects[0].revisions=[revision(1,{title:'A',series:series([item('2'),item('9','[remote] _x_ <script>'),item('1')])})];
  c.subjects[0].revisions[0].fields.series.items[1].season_label='[special]_';
  const md=page(c,'1');assert.match(md,/\[Local 2\]\(\.\.\/movie\/2\.md\)/);assert.match(md,/看过 · ★★★★☆/);
  assert.match(md,/\\\[remote\\\] \\_x\\_ &lt;script&gt;/);assert.match(md,/本档案未收录/);assert.match(md,/含本作共 4 项/);
  assert.doesNotMatch(md,/不保证包含全部|\.\.\/movie\/1\.md|\.\.\/movie\/9\.md|系列列表的观测变化|其他作品页中的关联/);
  assert.ok(md.indexOf('My comment')<md.indexOf('## 同系列作品'));
  assert.equal(buildPages(project(c)).stats.marks,buildPages(project(canonical())).stats.marks);
});
test('direct incoming links merge into unified series section without transitive closure or account leaks',()=>{
  const c=canonical(); c.subjects[0].revisions=[revision(1,{title:'A',series:series([item('2')])})];
  c.subjects[1].revisions=[revision(2,{title:'B',series:series([item('3')])})];
  const md2=page(c,'2');
  assert.match(md2,/## 同系列作品[\s\S]*\[A\]\(\.\.\/movie\/1\.md\)/);
  assert.match(md2,/\[Local 3\]\(\.\.\/movie\/3\.md\)/);
  assert.doesNotMatch(md2,/其他作品页中的关联|系列列表的观测变化/);
  assert.doesNotMatch(page(c,'1'),/movie\/3\.md/);
  c.subjects[0].revisions.push(revision(3,{title:'A',series:series([item('3')])}));
  assert.doesNotMatch(page(c,'2'),/movie\/1\.md/);
  c.marks[0].account.user_id='999'; const own=filterCanonicalByAccount(c,'111');
  assert.doesNotMatch(page(own,'3'),/movie\/1\.md|\[A\]/);assert.match(page(own,'3'),/movie\/2\.md/);
});
test('empty replaces old members; omitted field retains them and original evidence time',()=>{
  const c=canonical(), s=series([item('2')]);
  c.subjects[0].revisions=[revision(1,{title:'A',series:s}),revision(2,{title:'A',series:s},['series','title','cover_url','raw_meta'])];
  assert.match(page(c,'1'),/后续页面未提供可识别/);
  c.subjects[0].revisions.push(revision(3,{title:'A',series:{...series([]),series_url:null,claimed_total:0,scope:'complete'}}));
  const md=page(c,'1');assert.match(md,/明确未设置系列/);
  assert.doesNotMatch(md,/\[Local 2\]|系列列表的观测变化|其他作品页中的关联/);assert.doesNotMatch(page(c,'2'),/movie\/1\.md/);
  c.subjects[0].revisions.at(-1).fields.series={...series([]),scope:'complete'};assert.match(page(c,'1'),/仅列当前作品/);
});
test('union across snapshots and direct incoming keeps removed members and takes latest metadata per Douban ID',()=>{
  const s1=series([{medium:'movie',id:'2',title:'Old 2',season_label:'S1'},{medium:'movie',id:'9',title:'Early Only',season_label:'S0'}]);
  const s2=series([{medium:'movie',id:'2',title:'New 2',season_label:'第二版'},{medium:'movie',id:'3',title:'Current 3',season_label:null}]);
  const subject={medium:'movie',id:'1',revisions:[revision(1,{series:s1}),revision(2,{series:s2})]};
  const p=projectSeries(subject);
  assert.equal(p.hasHistoryUnionExtras,true);
  assert.deepEqual(p.unionItems.map(i=>[i.id,i.title,i.season_label]),[['2','New 2','第二版'],['3','Current 3',null],['9','Early Only','S0']]);
  const c=canonical();
  c.subjects[0].revisions=[revision(1,{title:'A',series:s1}),revision(2,{title:'A',series:s2})];
  c.marks.push({canonical_version:'canonical/1.4',account:{user_id:'111'},upstream_id:'4',identity_layer:'upstream_id',medium:'movie',subject:{id:'4',url:'https://movie.douban.com/subject/4/'},revisions:[revision(4,{status:'wish',rating:null,comment:'',tags:[],marked_at:{iso:'2026-01-04',raw:'2026-01-04',precision:'day'}})]});
  c.subjects.push({medium:'movie',id:'4',revisions:[revision(4,{title:'Sequel 4',series:series([item('1','A')])})]});
  const md=page(c,'1');
  assert.match(md,/综合截至 2026-01-04T00:00:00Z 的档案观测并集（列其他 4 项，同 ID 取最新版）/);
  assert.match(md,/Early Only · S0 · 本档案未收录[\s\S]*\[Sequel 4\]\(\.\.\/movie\/4\.md\) · 想看/);
  assert.doesNotMatch(md,/系列列表的观测变化|其他作品页中的关联/);
});
test('invalid latest never falls back; unknown vocabulary and bad members degrade',()=>{
  const c=canonical(); c.subjects[0].revisions=[revision(1,{title:'A',series:series([item('2')])})];
  for (const bad of [null,[],{},'bad',{...series([]),kind:'enricher_series'}]) {
    c.subjects[0].revisions[1]=revision(2,{title:'A',series:bad});assert.match(page(c,'1'),/最新系列记录无法展示/);
    assert.doesNotMatch(page(c,'1'),/\[Local 2\]/);assert.doesNotMatch(page(c,'2'),/movie\/1\.md|其他作品页中的关联/);
  }
  c.subjects[0].revisions[1]=revision(2,{title:'A',series:{...series([item('2')]),scope:'future',source:'future',extra:true}});
  assert.match(page(c,'1'),/列表范围未知/);
  c.subjects[0].revisions[1].fields.series={...series([item('2'),item('../evil')]),scope:'complete'};
  assert.doesNotMatch(page(c,'1'),/该页面的完整列表|\.\.\/evil/);assert.match(page(c,'1'),/Local 2/);
});
test('legacy output unchanged; other account subjects cannot create pages or reverse references',()=>{
  const old=canonical(), other=structuredClone(old);
  other.subjects.push({medium:'movie',id:'9',revisions:[revision(1,{title:'Other owner',series:series([item('1')])})]});
  assert.deepEqual(buildPages(project(old)).files,buildPages(project(other)).files);assert.doesNotMatch(page(old,'1'),/同系列作品|其他作品页中的关联/);
});

import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { HUGO_VERSION } from '../src/hugo-bin.js';
const hugo=resolve(`.hugo/hugo-${HUGO_VERSION}`);
if (process.env.CI) assert.ok(existsSync(hugo),'Pinned Hugo required in CI');
test('real Hugo: both permalink layouts, no dead links, 86 escaped members, no remote images', {skip:!existsSync(hugo)}, t=>{
  const dir=mkdtempSync(join(tmpdir(),'doubak-series-hugo-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  cpSync('theme/hugo',dir,{recursive:true});
  const c=canonical();c.subjects[0].revisions=[revision(1,{title:'A',series:series([item('2'),...Array.from({length:85},(_,i)=>item(String(i+100),'很长的系列名称'.repeat(20)+'[x]_<img src="https://bad.example/x">'))])})];
  for (const [path,text] of buildPages(project(c)).files) {mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),text);}
  mkdirSync(join(dir,'content','broadcast'),{recursive:true});
  writeFileSync(join(dir,'content','broadcast','_index.md'),'---\ntitle: 广播\n---\n');
  for (let m=1;m<=5;m++) writeFileSync(join(dir,'content','broadcast',`2026-0${m}.md`),`---\ntitle: "2026-0${m}"\ndate: 2026-0${m}-01\ndouban_count: 1\n---\n\n[A](../movie/1.md)\n`);
  const original=readFileSync(join(dir,'hugo.toml'),'utf8');
  for (const baseURL of ['https://example.test/', 'https://example.test', 'https://example.test/archive/', 'https://example.test/archive']) for (const ugly of [true,false]) {
    writeFileSync(join(dir,'hugo.toml'),original.replace('uglyURLs = true',`uglyURLs = ${ugly}`));
    rmSync(join(dir,'public'),{recursive:true,force:true});
    const r=spawnSync(hugo,['--source',dir,'--baseURL',baseURL],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
    const root=join(dir,'public'), path=join(root,ugly?'movie/1.html':'movie/1/index.html');
    const html=readFileSync(path,'utf8');assert.match(html,ugly?/href="\.\.\/movie\/2.html"/:/href="\.\.\/\.\.\/movie\/2\/"/);
    assert.match(readFileSync(join(root,'broadcast/page/2/index.html'),'utf8'),ugly?/href="\.\.\/\.\.\/\.\.\/movie\/1.html"/:/href="\.\.\/\.\.\/\.\.\/movie\/1\/"/);
    assert.match(html,/含本作共 87 项/);assert.doesNotMatch(html,/<img[^>]+bad\.example/);
    const section=html.split('id="同系列作品"')[1].split('</ul>')[0];
    assert.equal((section.match(/<li>/g)??[]).length,86);assert.doesNotMatch(section,/<table/);
    function walk(d) {return readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]);}
    for (const file of walk(root).filter(f=>f.endsWith('.html'))) {
      for (const m of readFileSync(file,'utf8').replace(/<script\b[^>]*>[^]*?<\/script>/gi,'').matchAll(/href="([^"#]+)(?:#[^"]*)?"/g)) {
        const href=m[1].split('?')[0]; if (!href || /^[a-z]+:|^\/\//i.test(href)) continue;
        assert.ok(existsSync(resolve(dirname(file),decodeURIComponent(href))),`${file} → ${href}`);
      }
    }
  }
});


test('partially parsed snapshot unions earlier readable members without dropping them',()=>{
  const c=canonical();c.subjects[0].revisions=[revision(1,{series:series([item('2'),item('3')])}),
    revision(2,{series:{...series([item('3')]),scope:'partial'}})];
  const md=page(c,'1');assert.match(md,/Local 2[\s\S]*Local 3|Local 3[\s\S]*Local 2/);
  assert.match(md,/档案观测并集/);
  assert.doesNotMatch(md,/该来源本次未列出：Name 2|退出系列|系列列表的观测变化/);
});

test('partial mark coverage of {A, B, C}: A and B marked, C unmarked stays inline-only without orphan page or search row',()=>{
  const base=canonical();
  const c={marks:base.marks.slice(0,2), subjects:base.subjects.slice(0,2)};
  c.subjects[0].revisions=[revision(1,{title:'Film A',series:series([item('2','Film B'),item('9','Film C')])})];
  c.subjects[1].revisions=[revision(1,{title:'Film B',series:series([item('1','Film A'),item('9','Film C')])})];
  const out=buildPages(project(c));
  const files=new Map(out.files);
  assert.equal(out.stats.marks,2);
  assert.equal(files.has('content/movie/9.md'),false);
  assert.match(files.get('content/movie/1.md'),/\[Film B\]\(\.\.\/movie\/2\.md\)[\s\S]*Film C · 本档案未收录/);
  assert.match(files.get('content/movie/2.md'),/\[Film A\]\(\.\.\/movie\/1\.md\)[\s\S]*Film C · 本档案未收录/);
  assert.doesNotMatch(files.get('static/search-index.js'),/Film C|"9"/);

  // Asymmetric case: only A captured series, B omitted it -> B merges direct incoming A into 同系列作品, never C.
  c.subjects[1].revisions=[revision(1,{title:'Local 2'},['series'])];
  const asym=new Map(buildPages(project(c)).files);
  assert.match(asym.get('content/movie/1.md'),/\[Local 2\]\(\.\.\/movie\/2\.md\)[\s\S]*Film C · 本档案未收录/);
  assert.match(asym.get('content/movie/2.md'),/## 同系列作品[\s\S]*\.\.\/movie\/1\.md/);
  assert.doesNotMatch(asym.get('content/movie/2.md'),/Film C|其他作品页中的关联/);

  // Multi-account isolation: C marked only by another account stays unmarked under target account filter.
  const other=structuredClone(c);
  other.marks.push({canonical_version:'canonical/1.4',account:{user_id:'999'},upstream_id:'9',identity_layer:'upstream_id',medium:'movie',subject:{id:'9',url:'https://movie.douban.com/subject/9/'},revisions:[revision(1,{status:'done',rating:5,comment:'Other secret',tags:[],marked_at:{iso:'2026-01-01',raw:'2026-01-01',precision:'day'}})]});
  other.subjects.push({medium:'movie',id:'9',revisions:[revision(1,{title:'Local C'},['series'])]});
  const own=new Map(buildPages(project(filterCanonicalByAccount(other,'111'))).files);
  assert.equal(own.has('content/movie/9.md'),false);
  assert.match(own.get('content/movie/1.md'),/Film C · 本档案未收录/);
  assert.doesNotMatch(own.get('content/movie/1.md'),/Local C|★★★★★|Other secret/);
});
