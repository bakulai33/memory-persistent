/**
 * Capture policy for user prompts.
 *
 * The old keyword heuristic dropped durable intent in Indonesian prompts, so the
 * policy works on two levels instead of one. "always" marks a prompt that
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

/** A slash is the other half of the path signal: "src/parser" names a file too. */
const PATH_SEPARATOR = "/"

/** Decision, error and work-order markers, in English and Indonesian. */
const ALWAYS_MARKERS = [
  // English
  "decide", "decision", "approve", "agree", "error", "failed", "bug", "fix",
  "should", "must", "analyz", "research", "review", "deep",
  // Indonesian
  "setuju", "sepakat", "lanjut", "praq", "raq", "perbaiki", "gagal", "salah",
  "harus", "boleh", "lakukan", "analisis", "riset", "tinjau",
]

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
 */
export function capturePolicy(text: string): CaptureTier {
  const trimmed = text.trim()
  if (!trimmed) return "noise"
  const lower = trimmed.toLowerCase()
  if (lower.includes(MEMORY_MENTION)) return "always"
  if (FILE_EXTENSION_RE.test(trimmed)) return "always"
  if (trimmed.includes(PATH_SEPARATOR)) return "always"
  if (trimmed.length > LONG_PROMPT) return "always"
  if (ALWAYS_MARKERS.some((marker) => lower.includes(marker))) return "always"
  if (NOISE_EXACT.includes(lower)) return "noise"
  if (trimmed.length < SHORT_PROMPT) return "noise"
  return "likely"
}
