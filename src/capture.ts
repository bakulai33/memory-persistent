/**
 * Capture policy for user prompts.
 *
 * The old keyword heuristic dropped durable intent in Indonesian prompts, so the
 * policy works on three levels instead of one. "always" marks a prompt that
 * carries a decision, an error, a work order or a file reference; "likely"
 * marks everything that is neither chatter nor a strong signal; "noise" marks
 * chatter that must not be stored.
 */

/** How strongly a prompt deserves to be remembered. */
export type CaptureTier = "always" | "likely" | "noise"

/** An explicit request to remember something. */
const MEMORY_MENTION = "@memory-persistent"

/** A source or config file extension, so a prompt that names a file is kept. */
const FILE_EXTENSION_RE = /\.(?:ts|js|tsx|jsx|py|go|rs|java|md|json|ya?ml)\b/i

/**
 * A lone slash is NOT the path signal: "and/or", "yes/no" are phrases, not
 * files (P2-6). A token counts as path-like when it is anchored (/abs, ~/,
 * ./, ../) or when one of its segments carries file shape — a dot, a digit,
 * an underscore or a hyphen, or it names a common source directory.
 */
const ANCHORED_PATH_RE = /^(?:\/|~\/|\.\.?\/)/

/** Directory segments that make "src/x" read as a path, not a phrase. */
const COMMON_SOURCE_DIRS = new Set([
  "src", "lib", "app", "bin", "test", "tests", "docs", "tools", "scripts",
  "config", "components", "utils", "packages", "plugins", "skills", "api",
  "assets", "styles", "build", "dist", "cmd", "internal", "pkg", "public",
  "server", "client", "hooks", "types",
])

function pathLikeToken(token: string): boolean {
  if (ANCHORED_PATH_RE.test(token)) return true
  if (!token.includes("/")) return false
  return token.split("/").some(
    (segment) => segment.includes(".") || /[0-9_-]/.test(segment) || COMMON_SOURCE_DIRS.has(segment.toLowerCase()),
  )
}

function looksLikePath(text: string): boolean {
  return text.split(/\s+/).some(pathLikeToken)
}

/** English decision/error/work-order markers, matched with word boundaries (prevents FP like "shoulders"). */
const ALWAYS_EN_WORD = [
  "decide","decision","approve","agree","error","failed","bug","fix",
  "should","must","research","review","deep",
]

/**
 * Penanda Bahasa Indonesia: dicocokkan sebagai SUBSTRING.
 *
 * PENTUNG: Bahasa Indonesia menempelkan imbuhan (di-, me-, ke-, -nya).
 * "diperbaiki", "melakukan", "kesepakatan", "menganalisis", "risetnya",
 * "tinjauan", "disetujui" semuanya berisi penanda sebagai substring, TETAPI bukan
 * sebagai kata utuh. Kalau memakai batas kata kata, semua jadi tidak cocok ⇒ prompt
 * durable turun ke tier "noise" ⇒ **hilang**.
 *
 * Design v0.4 D2 eksplisit meminta "leksika EN+ID + varian morfologis";
 * kelas ini menjaga bahwa imbuhan tetap mencocokkan meskipun bukan kata utuh.
 */
const ALWAYS_ID_SUBSTRING = [
  "setuju","sepakat","perbaiki","gagal","salah","harus","boleh",
  "lakukan","analisis","riset","tinjau","disetujui",
]

/** Penanda awalan (tanpa batas kanan \b): "analyze", "lanjutkan", "raq", "praq". */
const ALWAYS_PREFIX = ["analyz","praq","raq","lanjut"]

const EN_WORD_RE = new RegExp(`\\b(${ALWAYS_EN_WORD.join("|")})\\b`, "i")
const PREFIX_RE = new RegExp(`\\b(${ALWAYS_PREFIX.join("|")})`, "i")

/** Greetings and acknowledgements, matched exactly after trimming. */
const NOISE_EXACT = ["hi", "halo", "ok", "okay", "thanks", "terima kasih", "siap"]

/** A prompt longer than this is worth keeping even without a marker. */
const LONG_PROMPT = 120

/** A prompt shorter than this carries no information at all. */
const SHORT_PROMPT = 15

/**
 * Classifies a prompt. Only "noise" prompts are dropped, so a durable prompt
 * that no marker catches is still kept as "likely".
 *
 * A strong signal wins over the greeting list: "ok, lanjut" is a work order,
 * not chatter. The extension is matched at the end of a token, so a prompt that
 * names a file in the middle of a sentence is kept as well.
 *
 * Marker priority (first match wins):
 *   1. EN word with boundary (\b...\b)   → avoids "shoulders", "preview" FP
 *   2. Prefix without right boundary (\b... ) → catches "analyze", "lanjutkan"
 *   3. Indonesian substring → preserves morphology ("disetujui", "perbaiki", etc.)
 */
export function capturePolicy(text: string): CaptureTier {
  const trimmed = text.trim()
  if (!trimmed) return "noise"
  const lower = trimmed.toLowerCase()
  if (lower.includes(MEMORY_MENTION)) return "always"
  if (FILE_EXTENSION_RE.test(trimmed)) return "always"
  if (looksLikePath(trimmed)) return "always"
  if (trimmed.length > LONG_PROMPT) return "always"
  if (EN_WORD_RE.test(lower)) return "always"
  if (PREFIX_RE.test(lower)) return "always"
  if (ALWAYS_ID_SUBSTRING.some((marker) => lower.includes(marker))) return "always"
  if (NOISE_EXACT.includes(lower)) return "noise"
  if (trimmed.length < SHORT_PROMPT) return "noise"
  return "likely"
}