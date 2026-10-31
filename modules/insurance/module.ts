import { defineModule } from "@aihot/contracts/modules";

export default defineModule({ name: "insurance", pages: [
  { path: "overview", file: "web/overview.tsx" },
  { path: "radar", file: "web/radar.tsx" },
  { path: "library", file: "web/library.tsx" },
], apiPaths: [/^\/api\/site\/insurance\//] });
