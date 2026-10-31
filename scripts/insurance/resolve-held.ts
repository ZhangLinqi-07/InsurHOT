// Reuse saved judgements to apply the user's automatic selection policy, preserving their originals.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { loadAnalyzeInput, tierThreshold } from "@aihot/backend/editorial/analyze";
import { rubricMaterial, RubricSchema, validateRubric, rubricDecision } from "@aihot/backend/editorial/rubric";
import { installModules } from "@aihot/backend/modules";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { groupArticle } from "@aihot/backend/events/group";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { failureKind } from "@aihot/backend/providers/receipts";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
const flag = process.argv.indexOf("--manifest");
const manifestPath = resolve(flag < 0 ? ".data/selection-auto-20261030/manifest.json" : process.argv[flag + 1]!);
const reportPath = resolve(dirname(manifestPath), "report.json");
const execute = process.argv.includes("--run");
mkdirSync(dirname(manifestPath), { recursive: true });

try {
  if (!existsSync(manifestPath)) {
    const items = await sql`SELECT p.article_id AS id,an.id AS analysis_id,a.revision,
      an.output #>> '{rubric,material,sourceHash}' AS source_hash,p.title,an.score,s.tier
      FROM publications p JOIN analyses an ON an.id=p.analysis_id JOIN articles a ON a.id=p.article_id
      JOIN sources s ON s.id=p.source_id
      WHERE an.output #>> '{rubric,reviewRequired}'='true' AND an.input_revision=a.revision
      ORDER BY an.score DESC NULLS LAST,p.article_id`;
    writeFileSync(manifestPath, JSON.stringify({ preparedAt: new Date().toISOString(), policy: "verified-mean-v1", items }, null, 2));
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.policy !== "verified-mean-v1") throw Error("Unexpected selection manifest policy");
  if (!execute) {
    console.log(JSON.stringify({ manifest: manifestPath, total: manifest.items.length, policy: manifest.policy, newScoreCalls: 0 }));
  } else {
    const report: any = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8"))
      : { startedAt: new Date().toISOString(), policy: manifest.policy, total: manifest.items.length, results: [] };
    const save = () => {
      report.updatedAt = new Date().toISOString();
      report.counts = report.results.reduce((counts: Record<string, number>, row: any) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1; return counts;
      }, {});
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    };
    for (const item of manifest.items) {
      if (report.results.some((row: any) => row.id === item.id && row.status !== "error")) continue;
      const input = await loadAnalyzeInput(item.id);
      const material = input && rubricMaterial(input);
      if (!input || input.revision !== item.revision || material!.sourceHash !== item.source_hash) {
        report.results.push({ id: item.id, status: "stale" }); save(); continue;
      }
      const result = await sql.begin(async tx => {
        const [article] = await tx`SELECT revision FROM articles WHERE id=${item.id} FOR UPDATE`;
        const [old] = await tx`SELECT * FROM analyses WHERE article_id=${item.id} AND input_revision=${item.revision} ORDER BY id DESC LIMIT 1`;
        if (!article || article.revision !== item.revision || !old) return { id: item.id, status: "stale" };
        if (old.output?.rubric?.resolvedFromAnalysisId === Number(item.analysis_id)) {
          return { id: item.id, status: "resolved", decision: old.output.rubric.decision, analysisId: Number(old.id), reused: true };
        }
        if (String(old.id) !== String(item.analysis_id)) return { id: item.id, status: "stale" };
        const threshold = tierThreshold(input.source.tier);
        if (threshold === null) return { id: item.id, status: "excluded-tier" };
        const passes = old.output.rubric.passes.map((pass: any) => ({ ...pass, ...validateRubric(RubricSchema.parse(pass.raw), material!) }));
        const decision = rubricDecision(passes, threshold);
        const values = passes.flatMap((pass: any) => pass.score === null ? [] : [pass.score]);
        const mean = values.length === 2 ? Math.floor((values[0] + values[1]) / 2) : null;
        const selected = old.relevance === "pass" && decision.decision === "selected";
        const output = { ...old.output, scores: values, threshold, rubric: { ...old.output.rubric, passes, ...decision,
          resolvedFromAnalysisId: Number(old.id), resolvedAt: new Date().toISOString() } };
        const [created] = await tx`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,receipt_ids,
          relevance,category,tags,subjects,title_zh,summary_zh,reason_zh,score,selected,output)
          SELECT article_id,input_revision,'rule',model,prompt_version,receipt_ids,relevance,category,tags,subjects,
            title_zh,summary_zh,reason_zh,${mean},${selected},${tx.json(output)} FROM analyses WHERE id=${old.id} RETURNING id`;
        const screenings = await tx`SELECT key,value FROM settings WHERE starts_with(key,'insurance.relevance.')
          AND value->>'articleId'=${item.id} AND value->>'revision'=${String(item.revision)} AND value->>'reviewRequired'='true'`;
        for (const screening of screenings) {
          const value = { ...screening.value, reviewRequired: false, reviewResolution: decision.decision, decisionPolicy: decision.decisionPolicy };
          await tx`UPDATE settings SET value=${tx.json(value)},updated_at=now(),updated_by='insurance.selection-auto' WHERE key=${screening.key}`;
        }
        await publishArticleTx(tx, item.id);
        await audit("codex:selection-auto", "selection.auto-decide", `content:${item.id}`, "User authorized automatic decisions from the two verified LLM scores",
          { analysisId: Number(old.id), selected: old.selected, score: old.score, screenings },
          { analysisId: Number(created!.id), selected, score: mean, ...decision }, { db: tx });
        return { id: item.id, status: "resolved", decision: decision.decision, analysisId: Number(created!.id), score: mean, candidate: selected };
      });
      report.results = report.results.filter((row: any) => row.id !== item.id);
      report.results.push(result); save();
    }

    // Share the workflow's existing grouping lease; never create a second event identity concurrently.
    const candidates = await sql`SELECT p.article_id AS id FROM publications p JOIN analyses an ON an.id=p.analysis_id JOIN articles a ON a.id=p.article_id
      WHERE p.selection_candidate AND NOT p.selected AND an.output #>> '{rubric,decisionPolicy}'='verified-mean-v1'
        AND a.grouping_status<>'complete'
        AND p.article_id=ANY(${manifest.items.map((item: any) => item.id)}::text[])`;
    for (const candidate of candidates) {
      const lease = await sql.reserve();
      try {
        await lease`SELECT pg_advisory_lock(hashtext('insurance.workflow.group'),0)`;
        await groupArticle(candidate.id);
        const [state] = await sql`SELECT selected FROM publications WHERE article_id=${candidate.id}`;
        const row = report.results.find((result: any) => result.id === candidate.id);
        if (row) row.selected = state?.selected === true;
        save();
      } catch (error) {
        report.groupingError = { id: candidate.id, kind: failureKind(error), message: String(error).slice(0, 600) };
        save(); throw error;
      } finally {
        await lease`SELECT pg_advisory_unlock(hashtext('insurance.workflow.group'),0)`;
        lease.release();
      }
    }
    const [state] = await sql`SELECT count(*) FILTER(WHERE p.selected AND p.seat AND p.eligible AND p.visibility='public' AND p.visible_after<=now())::int AS selected,
      count(*) FILTER(WHERE an.output #>> '{rubric,reviewRequired}'='true')::int AS remaining_rubric_holds FROM publications p LEFT JOIN analyses an ON an.id=p.analysis_id`;
    report.state = state; report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ total: report.total, counts: report.counts, decisions: report.results.reduce((counts: Record<string, number>, row: any) => {
      if (row.decision) counts[row.decision] = (counts[row.decision] ?? 0) + 1; return counts;
    }, {}), state, report: reportPath }));
  }
} finally { await stopBoss(); await closeDb(); }
