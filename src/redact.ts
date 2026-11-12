const PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
]

export function redact(text: string): string {
  let out = text
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]")
  return out
}
