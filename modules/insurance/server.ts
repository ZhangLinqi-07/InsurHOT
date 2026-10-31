import type { ServerModule } from "@aihot/backend/modules";
import { enrichNfra } from "./backend/nfra.ts";
import { registerInsuranceRadar } from "./api/radar.ts";
import { insuranceReportDivisions } from "./backend/report-divisions.ts";
import { classifyInsurance } from "./backend/classification.ts";
import { storedReadingScore } from "./backend/reading-score.ts";
import { newsWorkflowQueue, backlogWorkflowQueue, workflowStatus } from "./backend/workflow.ts";

export default {
  name: "insurance",
  articlePrefilter: false,
  classifyArticle: classifyInsurance,
  publicationScore: storedReadingScore,
  reportDivisions: insuranceReportDivisions,
  materialPublication: true,
  http: registerInsuranceRadar,
  queues: [newsWorkflowQueue, backlogWorkflowQueue],
  admin: {
    currentJobs: async () => ["insurance.workflow.sweep", "reports.compose"],
    runs: workflowStatus,
  },
  schedules: [{
    name: "insurance.nfra-bodies",
    cron: "*/5 * * * *",
    when: () => process.env.COLLECT_ENABLED === "true",
    run: () => enrichNfra(10),
  }],
} satisfies ServerModule;
