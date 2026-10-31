import "../../../tests/setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { nfraDocId, parseNfraBody, pendingNfraArticles, recordNfraAttempt } from "../backend/nfra.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";

after(closeDb);

const url = "https://www.nfra.gov.cn/cn/view/pages/ItemDetail.html?docId=123&itemId=928";
test("NFRA bodies require a matching document and substantive text", () => {
  const body = parseNfraBody(url, { rptCode: 200, data: { docId: 123, docTitle: "保险产品管理规定", publishDate: "2026-10-09 15:59:25", docClob: `<p>${"保险公司应当依法开发保险产品并披露适用范围与保障责任。".repeat(30)}</p>` } });
  assert.ok(body.text.length > 200);
  assert.equal(body.publishedAt?.toISOString(), "2026-10-09T07:59:25.000Z");
  assert.throws(() => parseNfraBody(url, { rptCode: 200, data: { docId: 124, docClob: "正文" } }), /matching article/);
  assert.throws(() => parseNfraBody(url, { rptCode: 200, data: { docId: 123, docClob: "<div id='app'></div><script>load()</script>" } }), /confirmed/);
});

test("NFRA enrichment only accepts the public canonical article entrance", () => {
  assert.equal(nfraDocId(url), "123");
  for (const invalid of [url.replace("https:", "http:"), url.replace("www.nfra.gov.cn", "example.com"), url.replace("ItemDetail.html", "index.html"), url.replace("docId=123", "docId=abc"), url.replace("https://", "https://user:password@")]) assert.throws(() => nfraDocId(invalid));
});

test("a failed NFRA body advances the database rotation to unattempted articles", async () => {
  const sourceId = `nfra-test-${Date.now()}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,enabled) VALUES (${sourceId},'NFRA rotation test','json_list','{}'::jsonb,'T1',true)`;
  const first = await upsertMaterial({ sourceId, title: "Attachment-only disclosure", url: url.replace("docId=123", "docId=987654321"), via: "import" });
  const second = await upsertMaterial({ sourceId, title: "Regulatory text waiting for enrichment", url: url.replace("docId=123", "docId=987654322"), via: "import" });
  const initial = await pendingNfraArticles(1);
  assert.equal(initial.length, 1);
  const failedId = initial[0].id;
  assert.ok([first.articleId, second.articleId].includes(failedId));
  await recordNfraAttempt(failedId, "attempted");
  await recordNfraAttempt(failedId, "failed", "Article has no readable body");
  const next = await pendingNfraArticles(1);
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, failedId);
  const [saved] = await sql`SELECT value FROM settings WHERE key=${'insurance.nfra-body.' + failedId}`;
  assert.equal(saved.value.status, "failed");
  assert.ok(saved.value.attemptedAt);
});

test("NFRA uses the known JSON article body for short notices, rejects corrupt text and footer-only extraction", () => {
  const text = "据有关部门消息，原监管机构有关负责人涉嫌严重违纪违法，目前正接受纪律审查和监察调查。";
  const result = parseNfraBody(url, { rptCode: 200, data: { docId: 123, docClob: '<html><head><meta charset="gb2312"></head><body><p>' + text + '</p></body></html>' } });
  assert.equal(result.text, text);
  assert.throws(() => parseNfraBody(url, { rptCode: 200, data: { docId: 123, docClob: '<p>' + text + '�</p>' } }), /confirmed/);
  assert.throws(() => parseNfraBody(url, { rptCode: 200, data: { docId: 123, docClob: '<p>版权与免责声明' + text.repeat(3) + '</p>' } }), /confirmed/);
});


test("NFRA access refusals stay out of rotation until explicitly cleared while ordinary failures remain eligible", async () => {
  const sourceId = `nfra-403-test-${Date.now()}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,enabled) VALUES (${sourceId},'NFRA access refusal test','json_list','{}'::jsonb,'T1',true)`;
  const denied = await upsertMaterial({ sourceId, title: "Article whose publisher refused access", url: url.replace("docId=123", "docId=987654323"), via: "import" });
  const ordinary = await upsertMaterial({ sourceId, title: "Article awaiting readable body", url: url.replace("docId=123", "docId=987654324"), via: "import" });
  const unattempted = await upsertMaterial({ sourceId, title: "Article not yet attempted", url: url.replace("docId=123", "docId=987654325"), via: "import" });
  await recordNfraAttempt(denied.articleId, "failed", "HTTP 403 for NFRA article JSON");
  await recordNfraAttempt(ordinary.articleId, "failed", "Article has no readable body");
  for (let poll = 0; poll < 2; poll++) {
    const pending = await pendingNfraArticles(100);
    assert.ok(!pending.some(article => article.id === denied.articleId));
    assert.ok(pending.some(article => article.id === ordinary.articleId));
    assert.ok(pending.some(article => article.id === unattempted.articleId));
  }
  const [saved] = await sql`SELECT value FROM settings WHERE key=${'insurance.nfra-body.' + denied.articleId}`;
  assert.equal(saved.value.status, "failed");
  assert.equal(saved.value.error, "HTTP 403 for NFRA article JSON");
  // An operator may explicitly clear the refusal after publisher access is restored.
  await sql`DELETE FROM settings WHERE key=${'insurance.nfra-body.' + denied.articleId}`;
  assert.ok((await pendingNfraArticles(100)).some(article => article.id === denied.articleId));
});
