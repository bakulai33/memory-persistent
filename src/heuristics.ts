// The decision about which prompt is worth keeping lives in src/capture.ts;
// this module only prepares the text that is stored.

export function extractUserExcerpt(text: string, maxChars = 500): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, maxChars) + "…"
}
