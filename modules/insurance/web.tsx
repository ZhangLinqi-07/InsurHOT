import type { WebModule } from "@aihot/web/modules";
import { IconList } from "@aihot/web/components/icons";

export default {
  name: "insurance",
  sidebar: { section: "内容", items: [{ to: "/library", label: "保险资料库", icon: IconList }] },
  tools: [{ to: "/library", label: "保险资料库", icon: <IconList size={20} /> }],
} satisfies WebModule;
