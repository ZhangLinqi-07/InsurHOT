import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { closeDb, sql } from '@aihot/backend/db';
import { loadPool } from '@aihot/backend/publication/pool';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { loadGroupReports } from '@aihot/backend/publication/groups';
import { marketCondition } from '@aihot/backend/publication/market';
import { InvalidCursorError } from '@aihot/backend/lib/cursor';
import { RUBRIC_VERSION } from '@aihot/industry/rubric';
import { parseFilters, registerSite } from '../apps/api/src/routes/site.ts';

after(closeDb);
const T = `market-${tag()}`;
const at = new Date('2026-10-30T04:00:00Z');
const now = new Date('2026-10-30T12:00:00Z');
let index = 0;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES (${T},'海外保险信源','rss','T1'),('nfra-917','国家金融监督管理总局','rss','T1')`;
});

async function add(suffix: string, jurisdiction: string | null, options: {
  sourceId?: string; scope?: string; title?: string; tags?: string[]; channel?: 'news' | 'x'; category?: 'regulation' | 'paper';
  selected?: boolean; secondJurisdiction?: string; stale?: boolean; review?: boolean; malformed?: boolean;
} = {}) {
  const id = `${T}-${suffix}`;
  const time = new Date(+at + index++ * 1000);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,revision,published_at,discovered_at,timeline_at)
    VALUES (${id},${options.sourceId ?? T},${id},${`https://example.test/${id}`},${options.title ?? 'English insurance report'},${options.stale ? 2 : 1},${time},${time},${time})`;
  let analysisId: number | null = null;
  if (jurisdiction !== null) {
    const pass = (value: string) => ({score: 60, holdReasons: [], raw: {event: {jurisdiction: value}}});
    const output = {scope: 'single', rubric: {
      version: RUBRIC_VERSION, reviewRequired: options.review ?? false,
      material: {articleId: id, revision: 1, sourceHash: 'a'.repeat(64)},
      passes: options.malformed ? {} : [pass(jurisdiction), pass(options.secondJurisdiction ?? jurisdiction)],
    }};
    const [analysis] = await sql<{id: number}[]>`INSERT INTO analyses(article_id,input_revision,origin,output)
      VALUES (${id},1,'rule',${sql.json(output)}) RETURNING id`;
    analysisId = analysis!.id;
  }
  await sql`INSERT INTO publications(article_id,source_id,analysis_id,title,summary,url,published_at,discovered_at,timeline_at,sort_at,
    visible_after,eligible,selected,visibility,channel,category,tags,search_text)
    VALUES (${id},${options.sourceId ?? T},${analysisId},${options.title ?? 'English insurance report'},'Insurance fixture',${`https://example.test/${id}`},
      ${time},${time},${time},${time},${time},true,${options.selected ?? true},'public',${options.channel ?? 'news'},${options.category ?? 'regulation'},
      ${[options.scope ?? T,...options.tags ?? []]},'needle insurance fixture')`;
  await sql`INSERT INTO pool_search(article_id,direct,body) VALUES (${id},'needle insurance fixture','insurance material')`;
  return id;
}

test('source locations partition every item even without analysis or with contradictory event evidence', async () => {
  const domestic = await add('domestic','United States',{sourceId:'nfra-917',title:'English insurance report'});
  const foreign = await add('foreign','中国内地',{title:'中国人寿保险业务'});
  const both = await add('both','中国内地与美国',{sourceId:'nfra-917'});
  const global = await add('global','全球');
  const domesticTag = await add('tag-domestic',null,{tags:['中国内地']});
  const foreignTag = await add('tag-foreign',null,{sourceId:'nfra-917',tags:['欧洲']});
  const asiaPacific = await add('asia',null,{tags:['亚太']});
  const entityOnly = await add('entity',null,{title:'中国人寿全球业务',tags:['中国人寿']});
  const hongKong = await add('hk','Hong Kong SAR');
  const outside = await add('outside','中国以外');
  const stale = await add('stale','中国',{sourceId:'nfra-917',stale:true});
  const review = await add('review','中国',{sourceId:'nfra-917',review:true});
  const conflict = await add('conflict','中国',{sourceId:'nfra-917',secondJurisdiction:'美国'});
  const malformed = await add('malformed','中国',{sourceId:'nfra-917',malformed:true});
  const filters = {channel:'all' as const,category:null,tag:T,now};
  const all = await loadPool(filters);
  const d = await loadPool({...filters,market:'domestic'});
  const f = await loadPool({...filters,market:'foreign'});
  assert.equal(all.total,14);assert.equal(all.filters.market,'all');
  assert.deepEqual(new Set(d.items.map(i=>i.id)),new Set([domestic,both,foreignTag,stale,review,conflict,malformed]));
  assert.deepEqual(new Set(f.items.map(i=>i.id)),new Set([foreign,global,domesticTag,asiaPacific,entityOnly,hongKong,outside]));
  assert.equal(d.total+f.total,all.total);assert.equal(d.todayCount+f.todayCount,all.todayCount);
  assert.ok(d.items.every(item=>!f.items.some(other=>other.id===item.id)));
  for (const tab of ['time','relevance'] as const) {
    const found = await loadPool({...filters,market:'domestic',q:'needle',tab});
    assert.deepEqual(new Set(found.items.map(i=>i.id)),new Set(d.items.map(i=>i.id)));
    assert.equal(found.total,7);
  }
  const defaultClock = {channel:'all' as const,category:null,tag:T};
  assert.equal((await loadPool({...defaultClock,market:'domestic'})).total,7);
  assert.equal((await loadPool({...defaultClock,market:'foreign'})).total,7);
  assert.equal((await loadPool(defaultClock)).total,14,'source scopes cannot share cached totals');
});

test('market filtering happens before page limits and composes with channel/category/tag and both search orderings', async () => {
  const scope = `${T}-pages`;
  const wanted: string[] = [];
  for(let i=0;i<45;i++)wanted.push(await add(`page-d-${i}`,'中国',{sourceId:'nfra-917',scope,channel:'x',category:'paper'}));
  for(let i=0;i<42;i++)await add(`page-u-${i}`,'全球',{scope,channel:'x',category:'paper'});
  await add('page-f','美国',{scope,channel:'x',category:'paper'});
  await add('page-wrong-channel','中国',{sourceId:'nfra-917',scope,category:'paper'});
  await add('page-wrong-category','中国',{sourceId:'nfra-917',scope,channel:'x'});
  const filters={channel:'x' as const,category:'paper' as const,tag:scope,market:'domestic' as const,now};
  for(const extra of [{},{q:'needle',tab:'time' as const},{q:'needle',tab:'relevance' as const}]) {
    const first=await loadPool({...filters,...extra,page:1});
    const second=await loadPool({...filters,...extra,page:2});
    const all=await loadPool({...filters,...extra,market:'all'});
    const foreign=await loadPool({...filters,...extra,market:'foreign'});
    assert.equal(first.total+foreign.total,all.total);
    assert.deepEqual([first.total,first.pageCount,first.items.length,second.total,second.items.length],[45,2,40,45,5]);
    assert.deepEqual(new Set([...first.items,...second.items].map(i=>i.id)),new Set(wanted));
  }
});

test('cached source totals share a snapshot when collection adds articles between tab reads', async () => {
  const scope=`${T}-live-counts`;
  await add('snapshot-d',null,{sourceId:'nfra-917',scope,selected:false});
  await add('snapshot-f',null,{scope,selected:false});
  const filters={channel:'all' as const,category:null,tag:scope};
  const all=await loadPool(filters);
  await add('snapshot-new',null,{scope,selected:false});
  const domestic=await loadPool({...filters,market:'domestic'});
  const foreign=await loadPool({...filters,market:'foreign'});
  assert.equal(all.total,2);assert.equal(domestic.total,1);assert.equal(foreign.total,1);
  assert.equal(domestic.total+foreign.total,all.total);
});

test('selected timeline, fact representatives, group expansion, day counts and cursor binding use the same market', async () => {
  const scope=`${T}-groups`;
  const [fact]=await sql<{id:number}[]>`INSERT INTO facts(public_id,title) VALUES (${scope},'Market fact') RETURNING id`;
  const d=await add('group-d','中国',{sourceId:'nfra-917',scope});
  const f=await add('group-f','美国',{scope});
  const another=await add('group-d2','中国香港',{sourceId:'nfra-917',scope});
  for(const id of [d,f]) {
    await sql`UPDATE publications SET fact_id=${fact!.id} WHERE article_id=${id}`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
  }
  const filters={channel:'all' as const,category:null,tag:scope,now};
  const domestic=await loadTimeline({...filters,market:'domestic'});
  const foreign=await loadTimeline({...filters,market:'foreign'});
  assert.deepEqual(new Set(domestic.cards.map(c=>c.item.id)),new Set([d,another]));
  assert.deepEqual(foreign.cards.map(c=>c.item.id),[f]);
  assert.deepEqual(Object.values(domestic.dayCounts),[2]);
  assert.deepEqual(Object.values(foreign.dayCounts),[1]);
  assert.equal(domestic.filters.market,'domestic');
  const reports=await loadGroupReports({...filters,factPublicId:scope,market:'domestic'},now);
  assert.deepEqual(reports!.reports.map(r=>r.id),[d]);
  const page=await loadTimeline({...filters,market:'domestic',limit:1});
  assert.ok(page.nextCursor);
  await assert.rejects(loadTimeline({...filters,market:'foreign',cursor:page.nextCursor}),InvalidCursorError);
});

test('site APIs default to all and reject invalid market filters', async () => {
  assert.equal(parseFilters({}).market,'all');
  assert.equal(parseFilters({market:'domestic',channel:'x',category:'paper',tag:T}).market,'domestic');
  assert.throws(()=>parseFilters({market:'unknown'}),/invalid market/);
  const app=Fastify();registerSite(app);
  try {
    for(const path of ['/api/site/pool','/api/site/timeline',`/api/site/groups/${T}/reports`]) {
      const response=await app.inject({url:path+'?market=invalid'});
      assert.equal(response.statusCode,400);
    }
  } finally {await app.close()}
});

test('source-location reads stay bounded on an isolated 2000-item inventory', async () => {
  const scope=`${T}-perf`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at)
    SELECT ${scope}||g,'nfra-917',${scope}||g,'https://example.test/market/'||g,'Insurance material',${at},${at},${at}
    FROM generate_series(1,2000) g`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,output)
    SELECT a.id,1,'rule',jsonb_build_object('rubric',jsonb_build_object('version',${RUBRIC_VERSION}::text,'reviewRequired',false,
      'material',jsonb_build_object('articleId',a.id,'revision',1,'sourceHash',repeat('a',64),'originalText',repeat('保险正文',4000)),
      'passes',jsonb_build_array(jsonb_build_object('score',60,'holdReasons','[]'::jsonb,'raw',jsonb_build_object('event',jsonb_build_object('jurisdiction','中国与美国'))),
        jsonb_build_object('score',60,'holdReasons','[]'::jsonb,'raw',jsonb_build_object('event',jsonb_build_object('jurisdiction','中国与美国'))))))
    FROM articles a WHERE a.id LIKE ${scope+'%'}`;
  await sql`INSERT INTO publications(article_id,source_id,analysis_id,title,summary,url,published_at,discovered_at,timeline_at,sort_at,
    visible_after,eligible,selected,visibility,channel,category,tags,search_text)
    SELECT a.id,a.source_id,an.id,a.title,'Insurance material',a.url,${at},${at},${at},${at},${at},true,false,'public','news','regulation',${[scope]},'insurance'
    FROM articles a JOIN analyses an ON an.article_id=a.id WHERE a.id LIKE ${scope+'%'}`;
  const started=performance.now();
  const plan=await sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*) FROM publications p
    WHERE p.tags @> ${[scope]}::text[] ${marketCondition('domestic')}`;
  const result=await sql<{n:number}[]>`SELECT count(*)::int n FROM publications p WHERE p.tags @> ${[scope]}::text[] ${marketCondition('domestic')}`;
  assert.equal(result[0]!.n,2000);
  const detail = plan[0]!['QUERY PLAN'] as Array<Record<string, unknown>>;
  console.log(JSON.stringify({marketInventory:2000,storedSourceCharsPerArticle:16000,elapsedMs:Math.round(performance.now()-started),executionMs:detail[0]?.['Execution Time'],planningMs:detail[0]?.['Planning Time'],plan:detail[0]?.Plan}));
});
