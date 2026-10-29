import type { ServerModule } from "@aihot/backend/modules";
import { enrichNfra } from "./backend/nfra.ts";
import { registerInsuranceLibrary } from "./api/library.ts";
import { readIngestionPolicy } from "./backend/archive.ts";

export default {
  name: "insurance",
  screenedPublication: { screeningPrefix: "insurance.relevance.", from: readIngestionPolicy().from },
  http: registerInsuranceLibrary,
  schedules: [{
    name: "insurance.nfra-bodies",
    cron: "*/5 * * * *",
    when: () => process.env.COLLECT_ENABLED === "true",
    run: () => enrichNfra(10),
  }],
} satisfies ServerModule;
