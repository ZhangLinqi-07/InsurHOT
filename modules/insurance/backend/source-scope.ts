// Explicit origin scope. Language and article relevance never establish publisher trust or country.
import { DOMESTIC_ACCOUNT_PREFIX, DOMESTIC_SOURCE_IDS } from "@aihot/industry/markets";
export const CHINA_SOURCE_IDS = new Set<string>(DOMESTIC_SOURCE_IDS);
export const isChineseSource = (id: string) => CHINA_SOURCE_IDS.has(id) || id.startsWith(DOMESTIC_ACCOUNT_PREFIX);
