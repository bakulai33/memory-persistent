/**
 * Logging primitives, extracted to their own module so the plugin's import
 * graph stays acyclic: this file is a leaf (only redact/build/node below),
 * while storage and health both need the paths and the event writer.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { redact } from "./redact.js"

export function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode")
}

/** Where the plugin writes its structured log lines. Next to the sessions dir. */
export function logPath(): string {
  return join(dataRoot(), "memory-persistent", "plugin.log")
}

/** A logged value is cut short at this length. */
export const ERROR_LIMIT = 300

/** Every log line of the plugin starts with this prefix. */
export const LOG_PREFIX = "[memory-persistent] "

// Cap for the plugin log file: keep the most recent lines so the file cannot
// grow without bound. 64 KiB is small enough to read at a glance and large
// enough to hold a useful tail of structured events.
const LOG_MAX_BYTES = 64 * 1024

/** A logged value never carries a secret, so every string is redacted first. */
function formatValue(key: string, value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0"
  if (typeof value === "boolean") return value ? "true" : "false"
  let text = redact(String(value))
  if (key === "error" && text.length > ERROR_LIMIT) text = `${text.slice(0, ERROR_LIMIT)}…`
  if (text === "") return '""'
  if (/[\s"]/.test(text)) return JSON.stringify(text)
  return text
}

/**
 * Writes one structured log line: the prefix, the event, then key=value pairs.
 * A value that carries a space is quoted, so the line stays parseable.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const parts = [event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue
    parts.push(`${key}=${formatValue(key, value)}`)
  }
  const line = `${LOG_PREFIX}${parts.join(" ")}`
  console.error(line)
  // Persist the same line to the plugin's own log file, since the server does
  // not capture plugin console output. Redaction already happened above.
  try {
    const path = logPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 })
    let size = 0
    let mode = 0
    try {
      const stat = statSync(path)
      size = stat.size
      mode = stat.mode & 0o777
    } catch {
      size = 0
    }
    // The mode of a write only applies to a file it creates, so a log that
    // already exists keeps its old permissions until they are corrected here.
    if (mode !== 0o600) {
      try {
        chmodSync(path, 0o600)
      } catch {
        // A log that cannot be tightened is still worth writing.
      }
    }
    if (size > LOG_MAX_BYTES) {
      const content = readFileSync(path, "utf8")
      const lines = content.split("\n")
      if (lines.length && lines[lines.length - 1] === "") lines.pop()
      const kept: string[] = []
      let keptBytes = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i], "utf8") + 1
        if (kept.length > 0 && keptBytes + lineBytes > LOG_MAX_BYTES) break
        kept.unshift(lines[i])
        keptBytes += lineBytes
      }
      writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        // The truncation already happened; a tighter mode is best effort.
      }
    }
  } catch {
    // Logging must never throw into the plugin.
  }
}
