import type { CategoryKey } from "./taxonomy.ts";

export interface RadarItem {
  id: string;
  title: string;
  summary: string | null;
  source: { name: string };
  publishedAt: string;
  category: CategoryKey | null;
  tags: string[];
  selected: boolean;
  prefiltered?: true;
}

export interface RadarResponse {
  items: RadarItem[];
  total: number;
  truncated: boolean;
  limit: number;
  from: string | null;
  to: string;
  days: 30 | 90 | null;
}
