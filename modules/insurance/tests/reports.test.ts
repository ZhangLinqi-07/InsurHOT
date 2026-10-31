import { editionAt, stub } from "../../../tests/setup.ts";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composeDaily, composeWeekly, composeMonthly } from "@aihot/backend/reports/compose";
import { loadReport, v1Daily, v1Period, feedIssues } from "@aihot/backend/publication/reports";
import { correctReportClassification } from "@aihot/backend/reports/correct";
import { insuranceReportDivisions } from "../backend/report-divisions.ts";

const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({
  overview: "本期记录保险规则与风险报告的进展。", sections: {},
  divisions: { domestic: "国内机构发布保险规则。", foreign: "境外机构发布风险报告。" },
}) } }] }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(() => installModules([{ name: "insurance", reportDivisions: insuranceReportDivisions }]));
after(async () => { installModules([]); await provider.close(); await stopBoss(); await closeDb(); });

let sequence = 0;
async function item(date: string, tags: string[], options: { backfill?: boolean; selected?: boolean; publishedAt?: Date } = {}) {
  const id = `insurance-report-${++sequence}`;
  const at = editionAt("daily", date, -3600);
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES (${id},${id},'rss','T1','editorial')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,published_at)
    VALUES (${id},${id},${id},${`https://example.org/${id}`},${id},${at},${at},${options.publishedAt ?? at})`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,timeline_at,published_at,sort_at,eligible,selected,visible_after,visibility,score,tags,category,backfill)
    VALUES (${id},${`保险进展${sequence}`},${tags.includes("中国内地") ? "国内机构发布保险规则。" : "境外机构发布风险报告。"},${id},'news',${`https://example.org/${id}`},${at},${at},${options.publishedAt ?? at},${at},true,${options.selected ?? true},${at},'public',${100 - sequence / 10},${tags},'regulation',${options.backfill ?? false})`;
  return id;
}

test("each division is considered before the whole issue fills; cross-border news appears once", async () => {
  const date = "2024-02-02";
  for (let n = 0; n < 16; n++) await item(date, ["中国内地"]);
  const foreign = await item(date, ["欧洲"]);
  const crossBorder = await item(date, ["中国内地", "欧洲"]);
  const global = await item(date, ["亚太"]);
  await composeDaily(date);
  const report = (await loadReport("daily", date))!;
  const entries = report.sections.flatMap(s => s.items);
  assert.equal(entries.length, 12);
  assert.ok(entries.some(e => e.itemId === foreign), "a lower-ranked international item keeps a seat");
  assert.ok(report.sections.some(s => s.division === "global" && s.items.some(e => e.itemId === global)));
  const saved = (await sql`SELECT content FROM reports WHERE kind='daily' AND key=${date}`)[0]!.content;
  const all = [...saved.sections.flatMap((s: any) => s.items), ...saved.flashes];
  assert.equal(all.filter((e: any) => e.itemId === crossBorder).length, 1);
  assert.equal(all.find((e: any) => e.itemId === crossBorder).division, "domestic");
  assert.ok((await v1Daily(date))!.report.sections.some((s: { label: string }) => s.label.startsWith("国际动态")));
  assert.ok((await feedIssues("daily", 10))[0]!.sections.some(s => s.label.startsWith("国际动态")));
  assert.equal(provider.hits(), 0, "a daily never pays a writer");
});

test("weekly and monthly preserve independent division introductions and suppress withdrawn prose", async () => {
  for (const date of ["2024-02-03", "2024-02-04", "2024-02-05"]) {
    for (let n = 0; n < 14; n++) await item(date, ["中国内地"]);
    await item(date, ["欧洲"]);
    await item(date, ["亚太"]);
    await composeDaily(date);
  }
  for (const [kind, key, compose] of [["weekly", "2024-W05", composeWeekly], ["monthly", "2024-02", composeMonthly]] as const) {
    await compose(key);
    const report = (await loadReport(kind, key))!;
    assert.equal(report.sections.flatMap(s => s.items).length, kind === "weekly" ? 20 : 30);
    assert.equal(report.divisions?.find(d => d.key === "domestic")?.summary, "国内机构发布保险规则。");
    assert.equal(report.divisions?.find(d => d.key === "foreign")?.summary, "境外机构发布风险报告。");
    assert.ok((await v1Period(kind, key))!.report.sections.some((s: { label: string }) => s.label.startsWith("国际动态")));
  }
  const international = (await loadReport("daily", "2024-02-02"))!.sections.find(s => s.division === "foreign")!.items[0]!;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${international.itemId}`;
  assert.equal((await loadReport("weekly", "2024-W05"))!.divisions?.find(d => d.key === "foreign")?.summary, null);
  assert.equal((await v1Period("monthly", "2024-02"))!.report.divisions?.find(d => d.key === "foreign")?.summary, null);
});

test("category corrections move a frozen entry within its division", async () => {
  const report = (await loadReport("daily", "2024-02-02"))!;
  const id = report.sections.find(s => s.division === "domestic")!.items[0]!.itemId!;
  await sql`UPDATE publications SET category='industry' WHERE article_id=${id}`;
  await sql.begin(tx => correctReportClassification(tx, id, "test category correction"));
  const corrected = (await loadReport("daily", "2024-02-02"))!;
  const section = corrected.sections.find(s => s.items.some(i => i.itemId === id))!;
  assert.equal(section.label, "企业");
  assert.equal(section.division, "domestic");
});

test("explicit first-issue compilation keeps the source date window and all selection flags", async () => {
  const date = "2024-03-02";
  const archived = await item(date, ["中国内地"], { backfill: true });
  const old = await item(date, ["欧洲"], { backfill: true, publishedAt: editionAt("daily", "2024-02-01") });
  const rejected = await item(date, ["欧洲"], { backfill: true, selected: false });
  await assert.rejects(composeDaily(date, undefined, { basis: "publication", editorialNote: "首期编排" }), /explicit editorial reason/);
  await composeDaily(date, "首期编排", { basis: "publication", editorialNote: "首期按原文时间整理。" });
  const report = (await loadReport("daily", date))!;
  assert.deepEqual(report.sections.flatMap(s => s.items.map(e => e.itemId)), [archived]);
  assert.ok(report.divisions?.some(d => d.key === "foreign" && d.summary === null));
  assert.equal(report.editorialNote, "首期按原文时间整理。");
  const rows = await sql`SELECT article_id,backfill,selected FROM publications WHERE article_id = ANY(${[archived, old, rejected]}::text[])`;
  assert.ok(rows.every(r => r.backfill));
  assert.equal(rows.find(r => r.article_id === rejected)!.selected, false);
});
