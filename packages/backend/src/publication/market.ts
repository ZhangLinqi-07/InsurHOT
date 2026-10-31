// News lists use publisher location. Report editions retain their event-market evidence.
import type { MarketFilter } from "@aihot/contracts/site";
import { MARKET_MATCH, DOMESTIC_MARKET_EXCLUSIONS, DOMESTIC_SOURCE_IDS, DOMESTIC_ACCOUNT_PREFIX } from "@aihot/industry/markets";
import { RUBRIC_VERSION } from "@aihot/industry/rubric";
import { sql } from "../db.ts";

/** Same p-alias predicate for selected anchors, groups, pool counts, search and pagination. */
export function marketCondition(market: MarketFilter | null | undefined) {
  if (!market || market === "all") return sql``;
  const domestic = sql`(p.source_id = ANY(${[...DOMESTIC_SOURCE_IDS]}::text[]) OR starts_with(p.source_id,${DOMESTIC_ACCOUNT_PREFIX}))`;
  return market === "domestic" ? sql`AND ${domestic}` : sql`AND NOT ${domestic}`;
}

/** Stored event evidence is used only for the existing report-division policy. */
export function eventMarketCondition(market: MarketFilter | null | undefined) {
  if (!market || market === "all") return sql``;
  const policy = MARKET_MATCH[market];
  const jurisdiction = market === "domestic"
    ? sql`regexp_replace(market_pass.data #>> '{raw,event,jurisdiction}', ${DOMESTIC_MARKET_EXCLUSIONS}, ' ', 'gi')`
    : sql`market_pass.data #>> '{raw,event,jurisdiction}'`;
  return sql`AND (p.tags && ${[...policy.tags]}::text[] OR EXISTS (
    SELECT 1 FROM analyses market_analysis JOIN articles market_article ON market_article.id = market_analysis.article_id
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(market_analysis.output #> '{rubric,passes}') = 'array'
      THEN market_analysis.output #> '{rubric,passes}' ELSE '[]'::jsonb END AS passes) market_material
    WHERE market_analysis.id = p.analysis_id AND market_analysis.article_id = p.article_id
      AND market_analysis.input_revision = market_article.revision
      AND market_analysis.output #>> '{rubric,version}' = ${RUBRIC_VERSION}
      AND market_analysis.output #> '{rubric,reviewRequired}' = 'false'::jsonb
      AND market_analysis.output #>> '{rubric,material,articleId}' = p.article_id
      AND market_analysis.output #>> '{rubric,material,revision}' = market_analysis.input_revision::text
      AND market_analysis.output #>> '{rubric,material,sourceHash}' ~ '^[a-f0-9]{64}$'
      AND jsonb_array_length(market_material.passes) = 2
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(market_material.passes) AS market_pass(data)
        WHERE (jsonb_typeof(market_pass.data->'score') = 'number'
          AND market_pass.data->'holdReasons' = '[]'::jsonb
          AND ${jurisdiction} ~* ${policy.jurisdiction}) IS NOT TRUE)
  ))`;
}
