import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { REPO_ROOT } from "@aihot/backend/config";
import { loadCollectedLibrary, loadCollectionCoverage, type CollectionCatalogEntry } from "@aihot/backend/publication/collection";
import { readIngestionPolicy } from "../backend/archive.ts";

export function registerInsuranceLibrary(app: FastifyInstance) {
  app.get("/api/site/insurance/library", { schema: { querystring: { type: "object", additionalProperties: false, properties: {
    view: { type: "string", enum: ["related", "pending", "review", "excluded", "sources"] }, q: { type: "string", maxLength: 160 },
    source: { type: "string", maxLength: 80 }, page: { type: "integer", minimum: 1, maximum: 1000 },
  } } } }, async (request, reply) => {
    const query = request.query as Record<string, string>;
    const policy = readIngestionPolicy();
    const options = { from: policy.from, screeningPrefix: "insurance.relevance.", archivePrefix: "insurance.archive." };
    reply.header("Cache-Control", "no-store");
    if (query.view === "sources") {
      const catalog = JSON.parse(readFileSync(resolve(REPO_ROOT, "industry/source-catalog.json"), "utf8"));
      const links = (policy as any).supplementalAssociations ?? [];
      const entries: CollectionCatalogEntry[] = catalog.sources.map((entry: any) => ({
        id: entry.catalogId, name: entry.name, url: entry.url, needsAuthorization: !!entry.accountId,
        collectorIds: [...(entry.runtimeMapping?.collectorIds ?? []), ...links.filter((link: any) => link.catalogIds.includes(entry.catalogId)).map((link: any) => link.sourceId)],
      }));
      return { kind: "sources", data: await loadCollectionCoverage(options, entries, { q: query.q, page: Number(query.page) }) };
    }
    return { kind: "materials", data: await loadCollectedLibrary(options, { view: query.view, q: query.q, source: query.source, page: Number(query.page) }) };
  });
}
