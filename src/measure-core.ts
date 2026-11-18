import { BUILD } from "./build.js"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * The honest effectiveness report for a sessions directory.
 *
 * Every number comes from the memory files that were actually read: nothing is
 * copied from the live OpenCode database and nothing is extrapolated, so a
 * missing metric is simply absent instead of fabricated as zero.
 */
export interface MeasureReport {
  /** How many `*.json` memory files the directory holds. */
  totalFiles: number
  /** File count per schema version (the `version` field, `schema` as fallback). */
  schemaVersions: Record<number, number>
  /** File count per writing build. */
  builds: Record<string, number>
  /** Files last written by a build other than the running one. */
  driftCount: number
  facts: {
    /** Files that hold at least one fact line, own or inherited. */
    sessions: number
    ownLines: number
    inheritedLines: number
    /** Share of fact lines shaped `- <kind>: <target>` with a known kind. */
    genericPct: number
    /** Extra occurrences of fact lines that appear more than once. */
    dupLines: number
  }
  pending: { turns: number; activity: number }
  notes: { own: number; inherited: number }
  hygiene: {
    /** Files whose mode is not 0600, relative to the sessions directory. */
    permIssues: string[]
    /** Files matching `*.json.corrupt.*`. */
    corruptBackups: string[]
    /** Files matching `*.tmp.*` untouched for more than an hour. */
    staleTmp: string[]
  }
}

/** A fact line is generic when it names one of the three known kinds. */
const GENERIC_FACT_RE = /^- (?:file|command|error): /

/** A tmp leftover is stale after an hour of silence. */
const STALE_TMP_MS = 60 * 60 * 1000

const CORRUPT_RE = /\.json\.corrupt\./
const TMP_RE = /\.tmp\./

/** The fields the report reads; every one is optional and type-checked here. */
interface RawMemory {
  version?: unknown
  schema?: unknown
  build?: unknown
  summaryFacts?: unknown
  summaryFactsInherited?: unknown
  notes?: unknown
  notesInherited?: unknown
  pendingTurns?: unknown
  pendingActivity?: unknown
}

/** The non-blank lines of a facts field; a field of the wrong type is empty. */
function factLines(text: unknown): string[] {
  if (typeof text !== "string") return []
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The length of an array field; anything else counts as absent. */
function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function emptyReport(): MeasureReport {
  return {
    totalFiles: 0,
    schemaVersions: {},
    builds: {},
    driftCount: 0,
    facts: { sessions: 0, ownLines: 0, inheritedLines: 0, genericPct: 0, dupLines: 0 },
    pending: { turns: 0, activity: 0 },
    notes: { own: 0, inherited: 0 },
    hygiene: { permIssues: [], corruptBackups: [], staleTmp: [] },
  }
}

/**
 * Reads only: builds the effectiveness report for one sessions directory.
 *
 * A missing directory yields an empty report instead of throwing, and a file
 * that fails to parse is skipped rather than crashing the scan. The hygiene
 * checks look at every file in the directory; the statistics only read the
 * `*.json` memory files.
 */
export function buildMeasureReport(sessionsDir: string): MeasureReport {
  const report = emptyReport()

  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return report
  }

  const now = Date.now()
  let genericLines = 0
  let totalLines = 0

  for (const name of entries.sort()) {
    const full = join(sessionsDir, name)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (!stats.isFile()) continue

    if ((stats.mode & 0o777) !== 0o600) report.hygiene.permIssues.push(name)
    if (CORRUPT_RE.test(name)) report.hygiene.corruptBackups.push(name)
    if (TMP_RE.test(name) && now - stats.mtimeMs > STALE_TMP_MS) report.hygiene.staleTmp.push(name)

    if (!name.endsWith(".json")) continue
    report.totalFiles++

    let raw: RawMemory
    try {
      raw = JSON.parse(readFileSync(full, "utf8")) as RawMemory
    } catch {
      continue
    }

    const version =
      typeof raw.version === "number"
        ? raw.version
        : typeof raw.schema === "number"
          ? raw.schema
          : null
    if (version !== null) report.schemaVersions[version] = (report.schemaVersions[version] ?? 0) + 1

    if (typeof raw.build === "string" && raw.build !== "") {
      report.builds[raw.build] = (report.builds[raw.build] ?? 0) + 1
      if (raw.build !== BUILD) report.driftCount++
    }

    const own = factLines(raw.summaryFacts)
    const inherited = factLines(raw.summaryFactsInherited)
    if (own.length + inherited.length > 0) report.facts.sessions++
    report.facts.ownLines += own.length
    report.facts.inheritedLines += inherited.length

    // Duplicates are counted PER FILE (T4.6): the same line recurring inside
    // one session's own+inherited chain is that file's duplication problem;
    // a shared line across two sessions is just two sessions' normal history.
    const fileCounts = new Map<string, number>()
    for (const line of [...own, ...inherited]) {
      totalLines++
      if (GENERIC_FACT_RE.test(line)) genericLines++
      fileCounts.set(line, (fileCounts.get(line) ?? 0) + 1)
    }
    for (const count of fileCounts.values()) {
      if (count > 1) report.facts.dupLines += count - 1
    }

    report.pending.turns += arrayLength(raw.pendingTurns)
    report.pending.activity += arrayLength(raw.pendingActivity)
    report.notes.own += arrayLength(raw.notes)
    report.notes.inherited += arrayLength(raw.notesInherited)
  }

  report.facts.genericPct = totalLines > 0 ? Math.round((genericLines / totalLines) * 100) : 0

  return report
}
