export type CollectionView = "related" | "pending" | "review" | "excluded";

export interface CollectedItem {
  id: string;
  title: string;
  url: string;
  source: { id: string; name: string };
  publishedAt: string;
  publicationTime: string | null;
  excerpt: string | null;
  excerptKind: "editorial" | "source" | null;
  state: CollectionView;
  processed: boolean;
  screeningReason: string | null;
  reviewNote: string | null;
}

export interface CollectionLibrary {
  view: CollectionView;
  query: string;
  source: string;
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  counts: Record<CollectionView, number>;
  totalCollected: number;
  enabledSources: number;
  latestCollectionAt: string | null;
  sources: Array<{ id: string; name: string; count: number }>;
  items: CollectedItem[];
}

export interface CollectionCoverage {
  page: number;
  pageCount: number;
  total: number;
  query: string;
  inventoryTotal: number;
  configuredChannels: number;
  enabledChannels: number;
  connectedEntries: number;
  awaitingAuthorization: number;
  entries: Array<{
    id: string;
    name: string;
    url: string | null;
    state: "channel-connected" | "awaiting-authorization" | "not-connected";
    channels: Array<{ name: string; enabled: boolean; lastCollectedAt: string | null; history: "running" | "exhausted" | "limited" | "failed" | "not-started" }>;
  }>;
}

export type CollectionPage = { kind: "materials"; data: CollectionLibrary } | { kind: "sources"; data: CollectionCoverage };
