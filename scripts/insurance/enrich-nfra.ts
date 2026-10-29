import { enrichNfra } from "../../modules/insurance/backend/nfra.ts";
import { closeDb } from "@aihot/backend/db";

try {
  const limitAt = process.argv.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : 10;
  const results = await enrichNfra(limit);
  console.log(JSON.stringify({ results }, null, 2));
  if (results.some((row) => row.status === "failed")) process.exitCode = 1;
} finally { await closeDb(); }
