import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { republishCollectedArticles } from "@aihot/backend/publication/publish";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
async function counts() {
  const [row] = await sql`SELECT count(*)::int AS collected,
    count(*) FILTER(WHERE p.eligible AND p.visibility='public')::int AS public,
    count(*) FILTER(WHERE p.selected AND p.visibility='public')::int AS selected
    FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN publications p ON p.article_id=a.id
    WHERE s.participation_mode='editorial'`;
  return row;
}
try {
  const before = await counts();
  if (process.argv.includes("--run")) {
    const result = await republishCollectedArticles();
    console.log(JSON.stringify({ before, result, after: await counts(), modelsEnabled: false }));
  } else console.log(JSON.stringify({ before, action: "Use --run to publish collected source cards. No model calls or paid jobs." }));
} finally { await stopBoss(); await closeDb(); }
