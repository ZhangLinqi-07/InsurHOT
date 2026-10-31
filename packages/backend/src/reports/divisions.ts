import type { ReportDivision } from "@aihot/contracts/site";
import { serverModules } from "../modules.ts";

export interface DivisionPlan {
  divisions: readonly (Pick<ReportDivision, "key" | "label"> & { keepEmpty?: boolean })[];
  assignments: Map<string, string>;
}

export async function divisionPlan(ids: string[]): Promise<DivisionPlan | null> {
  const policy = serverModules().find(m => m.reportDivisions)?.reportDivisions;
  return policy ? { divisions: policy.divisions, assignments: await policy.assign(ids) } : null;
}

/** Visit each division's best remaining event before any division's next event. */
export function balancedEntries<T>(entries: T[], division: (entry: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = division(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  const out: T[] = [];
  const queues = [...groups.values()];
  for (let i = 0; queues.some(q => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  return out;
}

export function divisionBrief(items: Array<{ title: string; summary: string }>): string | null {
  if (!items.length) return null;
  // Exact, complete sentences from stored summaries; no new claims or inferred trends.
  const first = items[0]!;
  const sentence = first.summary.match(/^[^。！？]+[。！？]/u)?.[0];
  return sentence && [...sentence].length <= 200 ? sentence : `${first.title}。`;
}
