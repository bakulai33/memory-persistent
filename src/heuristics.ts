const IMPORTANT_KEYWORDS = [
  "decide", "decision", "keputusan", "change", "ubah", "fix", "perbaiki",
  "error", "bug", "refactor", "implement", "tambah", "remove", "delete",
  "config", "architecture", "design", "plan", "remember", "catat",
]

export function isImportantPrompt(text: string): boolean {
  const lower = text.toLowerCase()
  if (text.trim().length < 8) return false
  if (IMPORTANT_KEYWORDS.some((k) => lower.includes(k))) return true
  if (/\b[A-Za-z0-9_./-]+\.(ts|js|tsx|jsx|py|go|rs|java|md|json|yaml|yml)\b/.test(text)) return true
  return false
}

export function extractUserExcerpt(text: string, maxChars = 500): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, maxChars) + "…"
}
