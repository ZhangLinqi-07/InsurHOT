import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { CategoryKey } from "@aihot/contracts/taxonomy";
import type { ArticleClassification, ClassificationInput } from "@aihot/backend/modules";

interface Keyword {
  id: string;
  chinese: string;
  english: string;
  category: string;
  level: string;
  base_score: number;
}
interface Spec { version: string; categories: Array<{ key: string; label: string }>; keywords: Keyword[] }
interface Span { start: number; end: number; index: number; lang: "chinese" | "english" }
interface Hit {
  keyword_id: string; chinese: string; english: string; category: string; level: string;
  field: string; matched_language: string; base_score: number; multiplier: number; points: number; span: number[];
}

const raw = readFileSync(new URL("../../../industry/classification/keywords-v2.json", import.meta.url), "utf8");
const spec = JSON.parse(raw) as Spec;
const folds = JSON.parse(readFileSync(new URL("../../../industry/classification/casefold.json", import.meta.url), "utf8")) as Record<string, string>;
const order = new Map(spec.categories.map((c, i) => [c.key, i]));
const labels = new Map(spec.categories.map(c => [c.key, c.label]));
// Existing URLs and API identities keep the same keys for equivalent insurance categories.
const categoryKeys: Record<string, CategoryKey> = { corporate: "industry", research: "paper", product: "products", technology: "insurtech" };
export const CLASSIFICATION_VERSION = `insurance-keywords-v${spec.version}-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;

// Python's casefold differs from JavaScript's lowercasing for characters such as ß and final sigma.
const normalize = (text: string | null | undefined) => [...(text ?? "").normalize("NFKC")]
  .map(c => folds[c] ?? c.toLowerCase()).join("").replaceAll("’", "'").replace(/[–—]/g, "-");
const asciiAlnum = (c: string | undefined) => !!c && /^[a-z0-9]$/.test(c);

class Matcher {
  next: Array<Map<string, number>> = [new Map()];
  fail = [0];
  out: Array<Array<{ index: number; lang: Span["lang"]; length: number }>> = [[]];

  constructor() {
    spec.keywords.forEach((k, index) => {
      for (const lang of ["chinese", "english"] as const) {
        const term = [...normalize(k[lang])];
        let node = 0;
        for (const ch of term) {
          if (!this.next[node]!.has(ch)) {
            this.next[node]!.set(ch, this.next.length);
            this.next.push(new Map()); this.fail.push(0); this.out.push([]);
          }
          node = this.next[node]!.get(ch)!;
        }
        this.out[node]!.push({ index, lang, length: term.length });
      }
    });
    const queue = [...this.next[0]!.values()];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i]!;
      for (const [ch, v] of this.next[u]!) {
        queue.push(v);
        let f = this.fail[u]!;
        while (f && !this.next[f]!.has(ch)) f = this.fail[f]!;
        this.fail[v] = this.next[f]!.get(ch) ?? 0;
        this.out[v]!.push(...this.out[this.fail[v]!]!);
      }
    }
  }

  find(text: string): Span[] {
    const chars = [...text];
    const spans: Span[] = [];
    let node = 0;
    chars.forEach((ch, i) => {
      while (node && !this.next[node]!.has(ch)) node = this.fail[node]!;
      node = this.next[node]!.get(ch) ?? 0;
      for (const { index, lang, length } of this.out[node]!) {
        const end = i + 1, start = end - length;
        if (lang === "english" && (asciiAlnum(chars[start - 1]) || asciiAlnum(chars[end]))) continue;
        spans.push({ start, end, index, lang });
      }
    });
    spans.sort((a, b) => (b.end - b.start) - (a.end - a.start)
      || spec.keywords[b.index]!.base_score - spec.keywords[a.index]!.base_score || a.start - b.start || a.index - b.index);
    const chosen: Span[] = [];
    for (const hit of spans) if (!chosen.some(old => hit.start < old.end && old.start < hit.end)) chosen.push(hit);
    return chosen.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index || a.lang.localeCompare(b.lang));
  }
}

const matcher = new Matcher();

/** Exact v2 scoring, including original tie-breaking and synonym scope. Scores are not news value. */
export function classifyInsurance(input: ClassificationInput): ArticleClassification {
  const concepts = new Map<string, Hit>();
  for (const [field, text, multiplier] of [["标题", input.title, 2], ["标题", input.originalTitle, 2], ["摘要", input.summary, 1]] as const) {
    for (const { start, end, index, lang } of matcher.find(normalize(text))) {
      const k = spec.keywords[index]!;
      const concept = `${k.category}:${normalize(k.english)}`;
      const hit: Hit = { keyword_id: k.id, chinese: k.chinese, english: k.english, category: k.category, level: k.level,
        field, matched_language: lang === "chinese" ? "中文" : "英文", base_score: k.base_score,
        multiplier, points: k.base_score * multiplier, span: [start, end] };
      if (!concepts.has(concept) || hit.points > concepts.get(concept)!.points) concepts.set(concept, hit);
    }
  }
  const hits = [...concepts.values()].sort((a, b) => order.get(a.category)! - order.get(b.category)! || b.points - a.points || a.keyword_id.localeCompare(b.keyword_id));
  const emptyScores = () => Object.fromEntries(spec.categories.map(c => [c.key, 0]));
  const totals = emptyScores(), primary = emptyScores(), title = emptyScores(), length = emptyScores();
  for (const h of hits) {
    totals[h.category]! += h.points;
    if (h.level === "主要") primary[h.category]! += h.points;
    if (h.field === "标题") title[h.category]! += h.points;
    length[h.category] = Math.max(length[h.category]!, [...h.chinese].length);
  }
  const rank = (a: string, b: string) => totals[b]! - totals[a]! || primary[b]! - primary[a]! || title[b]! - title[a]!
    || length[b]! - length[a]! || order.get(a)! - order.get(b)!;
  const winner = hits.length ? spec.categories.map(c => c.key).sort(rank)[0]! : "other";
  return {
    category: categoryKeys[winner] ?? winner as CategoryKey,
    evidence: { version: CLASSIFICATION_VERSION, category: winner, label: labels.get(winner), score: totals[winner], category_scores: totals,
      hits, primary_points: primary[winner], secondary_points: totals[winner]! - primary[winner]! },
  };
}
