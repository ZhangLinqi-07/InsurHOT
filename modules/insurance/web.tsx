import type { WebModule } from "@aihot/web/modules";
import { IconChart, IconGrid } from "@aihot/web/components/icons";

export default {
  name: "insurance",
  sidebar: { section: "内容", items: [
    { to: "/overview", label: "总览", icon: IconGrid, before: "/" },
    { to: "/radar", label: "新闻雷达", icon: IconChart, before: "/" },
  ] },
  tools: [
    { to: "/overview", label: "总览", icon: <IconGrid size={20} /> },
    { to: "/radar", label: "新闻雷达", icon: <IconChart size={20} /> },
  ],
} satisfies WebModule;
