const PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  // Nilai header Authorization/Proxy-Authorization (dua token pertama setelah titik dua).
  /(?:proxy-)?authorization\s*:\s*\S+(?:\s+\S+)?/gi,
  // AWS access key id (AKIA + 16 alnum huruf besar).
  /AKIA[0-9A-Z]{16}/g,
  // JWT: tiga segmen base64url dipisah titik, segmen pertama diawali eyJ.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Userinfo kredensial URL pada scheme yang dikenal; scheme dan @host dipertahankan.
  /(?<=(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|ftps?|https?):\/\/)[^:\s/@]+:[^@\s/]+(?=@)/gi,
  // GitHub fine-grained / OAuth app token (ghp_ sudah tercakup pola di atas).
  /(?:github_pat_|gh[opus]_)[A-Za-z0-9_]{20,}/g,
  // Blok private key multiline; body lazy agar teks sekitar selamat.
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
]

export function redact(text: string): string {
  let out = text
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]")
  return out
}
