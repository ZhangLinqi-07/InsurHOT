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
