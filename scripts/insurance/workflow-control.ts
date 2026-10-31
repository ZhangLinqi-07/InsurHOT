import { closeDb } from "@aihot/backend/db";
import { setWorkflowEnabled, workflowStatus } from "../../modules/insurance/backend/workflow.ts";

try {
  const command = process.argv[2] ?? "status";
  if (command === "enable" || command === "disable") await setWorkflowEnabled(command === "enable");
  else if (command !== "status") throw new Error("Use enable, disable or status");
  console.log(JSON.stringify(await workflowStatus()));
} finally { await closeDb(); }
