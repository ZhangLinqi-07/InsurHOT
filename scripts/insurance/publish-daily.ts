// Explicit first issue from already selected archive materials; never changes their publication flags.
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { installModules } from "@aihot/backend/modules";
import { sql, closeDb } from "@aihot/backend/db";
import { composeDaily } from "@aihot/backend/reports/compose";
import { beijingDate } from "@aihot/contracts/time";

const [date = beijingDate(new Date()), mode] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || mode !== "--initial") throw new Error("Usage: publish-daily.ts YYYY-MM-DD --initial");
installModules(SERVER_MODULES);
try {
  if ((await sql`SELECT 1 FROM reports WHERE kind='daily' LIMIT 1`).length) throw new Error("An initial issue already exists. Use the normal report regeneration workflow.");
  const result = await composeDaily(date, "按用户要求编排国内国际首期日报", {
    basis: "publication",
    editorialNote: "首期按原文发布时间整理已入选材料，包含初始化归档中的同期事件。国内包含中国内地及港澳台，跨境事件在国内版集中呈现。资料不足的版面如实留空。",
  });
  console.log(JSON.stringify({ ...result, url: `http://localhost:3000/daily/${date}` }));
} finally { await closeDb(); }
