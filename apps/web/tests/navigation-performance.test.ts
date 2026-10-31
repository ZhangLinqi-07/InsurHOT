// Failure modes, fixed before changing public loaders or prefetch:
// - returning to a page that was already open still needs the network;
// - query variants mix content/SEO, or restores lose their anchor;
// - hovering downloads pages, a press no longer loads data or its click asks again, scroll-through touches
//   download it, or a failed prefetch breaks the current page;
// - visits renew deadlines, expired/errors stay cached, or refresh stops working;
// - Agent tabs choose an invalid panel or leave canonical/history behind;
// - search downloads two whole pages, requests before opening, or never retries/updates suggestions.
// Reader work failures fixed before changing enhancement and return-position code:
// - offscreen code downloads/runs immediately, visible code stays plain, or raw copying changes;
// - tiny/linked pictures become zoom buttons, or language changes keep old handlers;
// - a deep return loses its anchor, or folded dates confuse the anchor search.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, webkit, expect, type Browser } from "@playwright/test";
import type { ReportDetail } from "@aihot/contracts/site";
import { FIXTURE_AT as at, fakeApi, feedItem, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const item = feedItem({id:'navigation-fixture',title:'性能检查文章'});
const detail = itemDetail({id:item.id,title:item.title,originalTitle:'Fixture article'});
const codeSource='import json\n\nwith open("data.json") as file:\n    data = json.load(file)\n\nfor record in data:\n    print(record["title"])\n';
const readerBody=Array.from({length:30},(_,i)=>`<p>阅读段落 ${i}：先阅读文章，再查看后面的代码和图片。正文保持可读，图片和代码在需要时增强。</p>`).join('')
  +`<pre><code>${codeSource}</code></pre><pre><code>x = 1</code></pre>`
  +Array.from({length:12},(_,i)=>`<img src="/reader-image/${i}.svg" alt="正文配图 ${i}" width="640" height="360" loading="lazy">`).join('')
  +'<img src="/reader-image/tiny.svg" alt="小图标" width="16" height="16" loading="lazy"><a href="https://example.org"><img src="/reader-image/linked.svg" alt="链接图片" width="640" height="360" loading="lazy"></a>';
const report = (kind:'daily'|'weekly'|'monthly'): ReportDetail => ({kind,key:kind==='daily'?'2026-10-04':kind==='weekly'?'2026-W40':'2026-10',issueNumber:1,title:'Fixture '+kind,generatedAt:at,lead:{title:'Fixture '+kind,leadParagraph:'Fixture report'},leadItemId:null,overview:null,highlights:[],sections:[],flashes:[],cover:null,metrics:{},readingMinutes:1,prev:null,next:null});
const hits: string[] = [];
let suggestionsVersion=1;
let failing='';
let ttl=60;
let web:WebServer;
let origin:string;
let chrome:Browser;
let safari:Browser;
const api=fakeApi((url,res,req)=>{
  const p=url.pathname;
  if(p==='/api/site/meta'||p==='/api/site/track')return;
  hits.push(req.url!);
  if(p===failing){res.statusCode=503;return {code:'unavailable'};}
  if(p==='/api/site/search/suggestions')return {topics:[{slug:'qbe',name:'QBE',group:'company'}],hot:[{rank:1,title:'建议版本 '+suggestionsVersion,to:'/story/fixture'}]};
  if(p==='/api/site/topics')return {groups:[],topics:[{slug:'qbe',name:'QBE',group:'company',definition:'Fixture',brand:null,total:0,recent:0,indexable:false,latest:null}]};
  if(p==='/api/site/hot')return {computedAt:at,windowHours:48,entries:[{rank:1,story:{publicId:'fixture',title:'建议版本 '+suggestionsVersion},heat:10,trend:'flat',trendPct:0,badges:[],participantCount:0,sourceCount:0,sourceNames:[],participants:[],spark:[],summary:null,latest:null,cover:null}]};
  if(p==='/api/site/timeline'){
    res.setHeader('X-Accel-Expires','@'+(Math.floor(Date.now()/1000)+ttl));
    const category=url.searchParams.get('category');
    const market=url.searchParams.get('market')==='domestic'?'domestic':url.searchParams.get('market')==='foreign'?'foreign':'all';
    const prefix=market==='domestic'?'国内 ':market==='foreign'?'国外 ':'';
    const shown={...item,title:prefix+(category?'分类 '+category:'性能检查文章')};
    if(url.searchParams.get('tag')==='long-reading'){
      const cards=Array.from({length:180},(_,i)=>({key:'long-'+i,anchorAt:i<60?at:'2026-10-03T08:00:00.000Z',item:{...item,id:'long-'+i,title:'长列表文章 '+i,summary:'用于核实深处阅读返回的固定摘要。'.repeat(3)},group:null}));
      return {filters:{channel:'all',category:null,tag:'long-reading'},cards,nextCursor:null,hot:null,dayCounts:{'2026-10-04':60,'2026-10-03':120}};
    }
    return {filters:{channel:url.searchParams.get('channel')??'all',category,tag:url.searchParams.get('tag'),market},cards:[{key:shown.id,anchorAt:at,item:shown,group:null}],nextCursor:null,hot:null,dayCounts:{'2026-10-04':1}};
  }
  if(p==='/api/site/pool'){
    const pageCount=url.searchParams.get('tag')==='deep-paging'?52:3;
    const page=Math.min(Number(url.searchParams.get('page')||1),pageCount);
    const market=url.searchParams.get('market')==='domestic'?'domestic':url.searchParams.get('market')==='foreign'?'foreign':'all';
    const prefix=market==='domestic'?'国内 ':market==='foreign'?'国外 ':'';
    return {filters:{channel:url.searchParams.get('channel')??'all',category:url.searchParams.get('category'),tag:url.searchParams.get('tag'),market,q:url.searchParams.get('q'),tab:url.searchParams.get('tab')==='relevance'?'relevance':'time'},items:[{...item,title:prefix+'全部第 '+page+' 页'}],page,pageCount,total:pageCount===52?2080:3,todayCount:1,freshness:at};
  }
  if(p==='/api/site/items/navigation-fixture')return detail;
  if(p==='/api/site/items/navigation-fixture/original')return {...detail,body:{zh:null,original:'<p>Original fixture</p>',zhKind:null,complete:true},bodyLanguage:'original'};
  if(p==='/api/site/items/reader-fixture')return {...detail,id:'reader-fixture',title:'阅读增强检查',body:{...detail.body,zh:readerBody}};
  if(p==='/api/site/items/reader-fixture/original')return {...detail,id:'reader-fixture',title:'阅读增强检查',body:{...detail.body,zh:null,original:'<p>Original reader text</p>'},bodyLanguage:'original'};
  if(p.startsWith('/api/site/items/long-'))return {...detail,id:p.split('/').at(-1),title:'长列表详情'};
  const kind=p.match(/^\/api\/site\/reports\/(daily|weekly|monthly)\/latest-page$/)?.[1] as 'daily'|'weekly'|'monthly'|undefined;
  if(kind){const r=report(kind);return {report:r,index:[{key:r.key,issueNumber:1,title:r.title,count:0}]};}
});

before(async()=>{
  // Started together; whatever started is stopped in after() even when another one failed.
  const started=await Promise.allSettled([
    startWebServer(api).then(w=>{web=w;origin=w.origin;}),
    chromium.launch({channel:'chromium'}).then(b=>{chrome=b;}),
    webkit.launch().then(b=>{safari=b;}),
  ]);
  for(const result of started)if(result.status==='rejected')throw result.reason;
});
after(async()=>{
  await chrome?.close();await safari?.close();
  await web?.stop();
});

// One engine per behaviour: WebKit for what phone readers do (iPhone Safari), Chromium for desktop-only
// pointer behaviour such as hover and mouse presses. The router and caches are the same code in both.
test('SSR list and visited query variants return offline without another read',async()=>{
  const context=await safari.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  try{
    await visit(page,origin+'/');
    await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'性能检查文章',exact:true}).click();
    await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    await context.setOffline(true);
    await page.goBack();
    await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible({timeout:1500});
    await context.setOffline(false);
    await page.getByRole('button',{name:/^筛选/}).click();
    await page.getByRole('link',{name:'监管',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 regulation',exact:true})).toBeVisible();
    await page.getByRole('button',{name:/^筛选/}).click();
    await page.getByRole('link',{name:'产品',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 products',exact:true})).toBeVisible();
    await context.setOffline(true);
    await page.goBack();
    await expect(page.getByRole('link',{name:'分类 regulation',exact:true})).toBeVisible({timeout:1500});
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href',origin+'/?category=regulation');
  }finally{await context.close();}
});

test('hover downloads nothing, a press fetches article data once for its click, touches that move do not, and failed prefetch does not replace the current page',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  const press={button:0,pointerType:'mouse',isPrimary:true};
  try{
    await visit(page,origin+'/');
    const link=page.getByRole('link',{name:'性能检查文章',exact:true});
    const start=hits.length;
    // In one task, as a scroll moves within the hold that makes a still touch a press; two calls can be further apart.
    await link.evaluate(a=>{for(const type of ['touchstart','touchmove'])a.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,composed:true}));});
    await link.hover();await page.waitForTimeout(300);
    await page.getByRole('heading',{name:'精选',exact:true}).click();
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/items/')).length,0);
    await link.click();await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/items/')).length,1,'the click reuses the prefetch its press started');
    const fresh=await chrome.newContext();const freshPage=await fresh.newPage();
    try{
      await visit(freshPage,origin+'/');failing='/api/site/items/navigation-fixture';
      const failed=freshPage.waitForResponse(r=>r.url().includes('/items/navigation-fixture.data')&&r.status()===503);
      await freshPage.getByRole('link',{name:'性能检查文章',exact:true}).dispatchEvent('pointerdown',press);await failed;
      await expect(freshPage.getByRole('heading',{name:'精选',exact:true})).toBeVisible();
    }finally{await fresh.close();}
  }finally{failing='';await context.close();}
});

test('SSR all-pages and report kinds return offline with their own content',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await visit(page,origin+'/all');
    await page.locator('a[href="/all?page=2"]').first().click();
    await expect(page.getByRole('link',{name:'全部第 2 页',exact:true})).toBeVisible();
    await context.setOffline(true);await page.goBack();
    await expect(page.getByRole('link',{name:'全部第 1 页',exact:true})).toBeVisible({timeout:1500});
    await context.setOffline(false);await visit(page,origin+'/daily');
    await page.getByRole('link',{name:'周报',exact:true}).click();
    await expect(page.locator('#report-start')).toContainText('周报');
    await context.setOffline(true);await page.getByRole('link',{name:'日报',exact:true}).click();
    await expect(page.locator('#report-start')).toContainText('日报',{timeout:1500});
  }finally{await context.close();}
});

// A prefetch of the newly selected link must not be mistaken for an explicit refresh of that page.
// Disable HTTP reuse here: otherwise the browser cache can hide a lost document-level result.
test('a press on a selected link preserves visited data and the next revisit starts no data request',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  const requests:string[]=[];
  await context.route('**/*.data*',route=>route.continue());
  page.on('request',request=>{if(request.url().includes('.data'))requests.push(request.url());});
  try{
    await visit(page,origin+'/');
    await page.getByRole('link',{name:'监管',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 regulation',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'监管',exact:true}).dispatchEvent('pointerdown',{button:0,pointerType:'mouse',isPrimary:true});
    await page.waitForTimeout(150);
    await page.getByRole('link',{name:'产品',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 products',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'产品',exact:true}).dispatchEvent('pointerdown',{button:0,pointerType:'mouse',isPrimary:true});
    await page.waitForTimeout(150);
    const before=requests.length;
    await page.getByRole('link',{name:'监管',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 regulation',exact:true})).toBeVisible();
    assert.deepEqual(requests.slice(before),[],'neither prefetch nor navigation may evict and reload a still-valid visited page');
  }finally{await context.close();}
});

test('a revisit never renews the original deadline; an expired read shows an error and a reload asks again',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await page.clock.install();ttl=1;
    await visit(page,origin+'/');
    await page.getByRole('link',{name:'性能检查文章',exact:true}).click();await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    failing='/api/site/timeline';
    await page.clock.runFor(1500);
    await page.goBack();await expect(page.getByRole('heading',{name:'暂时无法加载',exact:true})).toBeVisible();
    failing='';ttl=60;
    await page.reload();await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible();
  }finally{ttl=60;failing='';await context.close();}
});

test('SSR freshness spent in an upstream cache is not renewed by HTML hydration',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    ttl=0;await visit(page,origin+'/');
    await page.getByRole('link',{name:'性能检查文章',exact:true}).click();await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    const start=hits.length;ttl=60;
    await page.goBack();await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible();
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/timeline')).length,1);
  }finally{ttl=60;await context.close();}
});

test('Agent tabs finish offline with matching canonical; invalid direct tabs and anchored links keep a panel',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await visit(page,origin+'/agent');
    await context.setOffline(true);
    await page.getByRole('tablist',{name:'接入方式'}).getByRole('tab',{selected:true}).click();
    await expect(page.locator('#agent-panel')).not.toBeEmpty();
    for(const [tab,name] of [['mcp',/^MCP/],['rss',/^RSS/],['api',/^REST API/]] as const){
      const choice=page.getByRole('tab',{name});
      // The active track was exercised above; compare navigation through every remaining track.
      if(await choice.getAttribute('aria-selected')==='true')continue;
      const target=await choice.getAttribute('href');
      await choice.click();
      await expect(page).toHaveURL(origin+target,{timeout:1500});
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href',origin+target);
      await expect(page.locator('#agent-panel')).toHaveAttribute('aria-labelledby','agent-tab-'+tab);
      await expect(page.locator('#agent-panel')).not.toBeEmpty();
    }
    await context.setOffline(false);
    await visit(page,origin+'/agent?tab=unknown');
    await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#agent-panel')).not.toBeEmpty();
    await visit(page,origin+'/agent#agent-api-recovery');
    await expect(page.locator('#agent-api-recovery')).toBeVisible();
  }finally{await context.close();}
});

test('phone suggestions load only on opening, use one small read, retry failures and update on reopening',async()=>{
  const context=await safari.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
  try{
    suggestionsVersion=1;await visit(page,origin+'/');
    assert.equal(hits.filter(x=>x==='/api/site/search/suggestions').length,0);
    let start=hits.length;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 1',exact:true})).toBeVisible();
    assert.deepEqual(hits.slice(start),['/api/site/search/suggestions']);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    suggestionsVersion=2;start=hits.length;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 2',exact:true})).toBeVisible();
    assert.deepEqual(hits.slice(start),['/api/site/search/suggestions']);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    failing='/api/site/search/suggestions';await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 2',exact:true})).not.toBeVisible();
    await page.getByRole('button',{name:'取消',exact:true}).click();failing='';suggestionsVersion=3;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 3',exact:true})).toBeVisible();
  }finally{failing='';await context.close();}
});

test('reader enhancements wait for visible code and update only the picture that loaded',async()=>{
  const context=await safari.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  const scripts:string[]=[];page.on('request',r=>{if(r.url().includes('/assets/')&&r.url().includes('highlight-'))scripts.push(r.url());});
  await page.route('**/reader-image/*.svg',route=>route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${route.request().url().endsWith('/tiny.svg')?16:640}" height="360"><rect width="640" height="360" fill="red"/></svg>`}));
  try{
    await visit(page,origin+'/items/reader-fixture');
    await expect(page.getByRole('heading',{name:'阅读增强检查',exact:true})).toBeVisible();
    await expect(page.locator('.code-block-copy')).toHaveCount(2);
    assert.deepEqual(scripts,[],'reading the introduction must not download the offscreen highlighter');
    const source=page.locator('.prose pre code').first();
    assert.equal(await source.textContent(),codeSource);
    await source.scrollIntoViewIfNeeded();
    await expect(source).toHaveClass(/hljs/);
    assert.equal(await source.textContent(),codeSource,'colouring preserves the copyable text');
    assert.equal(scripts.length,1);
    await page.locator('.code-block-copy').first().click();
    await expect(page.locator('.code-block-copy').first()).toHaveText('已复制');
    assert.equal(await page.locator('.prose pre code').nth(1).textContent(),'x = 1');
    for(let i=0;i<12;i++){
      const picture=page.locator(`.prose img[alt="正文配图 ${i}"]`);
      await picture.scrollIntoViewIfNeeded();
      await expect(picture).toHaveAttribute('role','button');
    }
    const tiny=page.locator('.prose img[alt="小图标"]');await tiny.scrollIntoViewIfNeeded();
    await expect(tiny).not.toHaveAttribute('role','button');
    await expect(page.locator('.prose a img')).not.toHaveAttribute('role','button');
    await page.getByRole('navigation',{name:'正文语言'}).getByRole('link',{name:'原文',exact:true}).click();
    await expect(page.getByText('Original reader text',{exact:true})).toBeVisible();
    assert.equal(await page.locator('.code-block-copy').count(),0);
  }finally{await context.close();}
});

test('deep reading returns to its anchor, including folded dates',async()=>{
  const context=await safari.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  try{
    await visit(page,origin+'/?tag=long-reading');
    await expect(page.locator('[data-card-key]')).toHaveCount(180);
    await page.getByRole('button',{name:'收起10月4日',exact:true}).click();
    await expect(page.locator('[data-card-key]')).toHaveCount(120);
    await page.getByRole('link',{name:'长列表文章 160',exact:true}).scrollIntoViewIfNeeded();
    const before=await page.evaluate(()=>{
      const first=[...document.querySelectorAll<HTMLElement>('[data-card-key]')].find(e=>e.getBoundingClientRect().bottom>72)!;
      return {key:first.dataset.cardKey!,top:first.getBoundingClientRect().top};
    });
    await page.getByRole('link',{name:'长列表文章 160',exact:true}).click();
    await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-card-key]')).toHaveCount(120);
    await expect.poll(()=>page.locator(`[data-card-key="${before.key}"]`).evaluate((e,top)=>Math.abs(e.getBoundingClientRect().top-top),before.top)).toBeLessThan(2);
    await expect(page.getByRole('button',{name:'展开10月4日',exact:true})).toBeVisible();
  }finally{await context.close();}
});


test('market filters stay independent on featured and all news, including mobile search and pagination',async()=>{
  for(const viewport of [{width:1440,height:1000},{width:320,height:760}]){
    const context=await chrome.newContext({viewport});const page=await context.newPage();
    try{
      const initial=new URLSearchParams({channel:'firstParty',category:'regulation',tag:'market-fixture',q:'保险',tab:'relevance',page:'2'});
      await visit(page,origin+'/all?'+initial);
      const markets=page.getByRole('navigation',{name:'市场范围'});
      await markets.getByRole('link',{name:'国内',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 全部第 1 页',exact:true})).toBeVisible();
      await expect(markets.getByRole('link',{name:'国内',exact:true})).toHaveAttribute('aria-current','page');
      let query=new URL(page.url()).searchParams;
      for(const [key,value] of initial)if(key!=='page')assert.equal(query.get(key),value,key);
      assert.equal(query.get('market'),'domestic');assert.equal(query.has('page'),false);
      await page.getByRole('link',{name:'下一页',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 全部第 2 页',exact:true})).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.get('market'),'domestic');
      if(viewport.width<961){
        await page.getByRole('button',{name:'保险',exact:true}).click();
        const dialog=page.getByRole('dialog',{name:'搜索',exact:true});
        await dialog.getByRole('searchbox').fill('保障');await dialog.getByRole('searchbox').press('Enter');
      }else{
        await page.getByLabel('搜索标题、摘要与正文').fill('保障');await page.getByLabel('搜索标题、摘要与正文').press('Enter');
      }
      await expect(page).toHaveURL(/q=.*market=|market=.*q=/);
      await expect(page.getByRole('link',{name:'国内 全部第 1 页',exact:true})).toBeVisible();
      query=new URL(page.url()).searchParams;
      assert.equal(query.get('q'),'保障');assert.equal(query.get('market'),'domestic');assert.equal(query.get('tag'),'market-fixture');
      assert.equal(query.get('category'),'regulation');assert.equal(query.get('channel'),'firstParty');assert.equal(query.has('page'),false);
      await markets.getByRole('link',{name:'全部',exact:true}).click();
      await expect(page.getByRole('link',{name:'全部第 1 页',exact:true})).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.has('market'),false);assert.equal(new URL(page.url()).searchParams.get('q'),'保障');

      await visit(page,origin+'/?market=foreign&category=regulation&tag=market-fixture&cursor=obsolete');
      await expect(page.getByRole('link',{name:'国外 分类 regulation',exact:true})).toBeVisible();
      await markets.getByRole('link',{name:'国内',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 分类 regulation',exact:true})).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.has('cursor'),false);
      if(viewport.width<961){await page.getByRole('button',{name:/^筛选/}).click();await page.getByRole('link',{name:'产品',exact:true}).click();}
      else await page.getByRole('navigation',{name:'筛选',exact:true}).getByRole('link',{name:'产品',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 分类 products',exact:true})).toBeVisible();
      query=new URL(page.url()).searchParams;assert.equal(query.get('market'),'domestic');assert.equal(query.get('tag'),'market-fixture');assert.equal(query.get('category'),'products');
      assert.ok(hits.some(hit=>hit.startsWith('/api/site/timeline?')&&hit.includes('market=domestic')&&hit.includes('category=products')));
      assert.ok(hits.some(hit=>hit.startsWith('/api/site/pool?')&&hit.includes('market=domestic')&&hit.includes('page=2')));
      if(viewport.width<961){
        await visit(page,origin+'/all?market=foreign&category=products&tag=market-fixture&q=保障');
        await page.getByRole('button',{name:'全部',exact:true}).click();
        await expect(page).not.toHaveURL(/[?&]q=/);
        await expect(page.getByRole('link',{name:'国外 全部第 1 页',exact:true})).toBeVisible();
        query=new URL(page.url()).searchParams;assert.equal(query.get('market'),'foreign');assert.equal(query.get('category'),'products');assert.equal(query.get('tag'),'market-fixture');assert.equal(query.has('q'),false);
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    }finally{await context.close();}
  }
});


test('all published news stays reachable beyond page fifty with filters and a real final page',async()=>{
  for(const viewport of [{width:1440,height:1000},{width:320,height:760}]){
    const context=await chrome.newContext({viewport});const page=await context.newPage();
    try{
      const query=new URLSearchParams({market:'domestic',category:'regulation',channel:'firstParty',tag:'deep-paging',q:'保险',tab:'relevance',page:'50'});
      const kept=()=>{const current=new URL(page.url()).searchParams;for(const [key,value] of query)if(key!=='page')assert.equal(current.get(key),value,key);return current;};
      await visit(page,origin+'/all?'+query);
      await expect(page.getByRole('link',{name:'国内 全部第 50 页',exact:true})).toBeVisible();
      await expect(page.getByText('找到',{exact:false})).toContainText('2080');
      await page.getByRole('link',{name:'下一页',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 全部第 51 页',exact:true})).toBeVisible();
      assert.equal(kept().get('page'),'51');
      await page.getByRole('link',{name:'下一页',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 全部第 52 页',exact:true})).toBeVisible();
      assert.equal(kept().get('page'),'52');
      await expect(page.getByRole('link',{name:'下一页',exact:true})).toHaveCount(0);
      await expect(page.getByText(/最多提供 50 页/)).toHaveCount(0);
      if(viewport.width<961)await expect(page.getByRole('navigation',{name:'分页'})).toContainText('52 / 52');
      else await expect(page.getByRole('navigation',{name:'分页'}).getByRole('link',{name:'52',exact:true})).toHaveAttribute('aria-current','page');
      await page.getByRole('link',{name:'上一页',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 全部第 51 页',exact:true})).toBeVisible();
      assert.equal(kept().get('page'),'51');
      query.set('page',String(Number.MAX_SAFE_INTEGER));
      await visit(page,origin+'/all?'+query);
      await expect(page.getByRole('link',{name:'国内 全部第 52 页',exact:true})).toBeVisible();
      assert.equal(kept().get('page'),'52');
      assert.equal(new URL(await page.locator('link[rel=canonical]').getAttribute('href')??origin).searchParams.get('page'),'52');
      assert.ok(hits.some(hit=>hit.startsWith('/api/site/pool?')&&hit.includes('page=51')&&hit.includes('market=domestic')));
      await page.getByRole('spinbutton',{name:'跳转页码'}).fill('50');
      await page.getByRole('button',{name:'跳转',exact:true}).click();
      await expect(page.getByRole('link',{name:'国内 全部第 50 页',exact:true})).toBeVisible();
      assert.equal(kept().get('page'),'50');
      await page.getByRole('link',{name:'清除全部筛选',exact:true}).click();
      await expect(page).toHaveURL(origin+'/all');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    }finally{await context.close();}
  }
});
