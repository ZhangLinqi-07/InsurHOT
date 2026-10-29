import { defineModule } from "@aihot/contracts/modules";

export default defineModule({ name: "insurance", pages: [{ path: "library", file: "web/library.tsx" }], apiPaths: [/^\/api\/site\/insurance\//] });
