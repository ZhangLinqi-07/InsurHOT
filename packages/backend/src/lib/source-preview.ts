/** The exact original excerpt displayed by source cards, with a stable length cap. */
export function sourcePreview(excerpt: string | null, body: string | null = null) {
  const text = (excerpt || body || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) + (text.length > 240 ? "…" : "") : null;
}
