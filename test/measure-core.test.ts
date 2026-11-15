import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, chmodSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildMeasureReport, type MeasureReport } from "../src/measure-core"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const dirs: string[] = []

function tmpSessions(): string {
  const dir = mkdtempSync(join(tmpdir(), "mp-measure-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** A minimal schema-v4 memory file. Every field is invented, nothing real. */
function writeSession(dir: string, id: string, fields: Record<string, unknown>): void {
  const base = {
    version: 4,
    sessionID: id,
    build: "0.5.0",
    summary: "",
    summaryFacts: "",
    summaryFactsInherited: "",
    summaryNarrative: "",
    notes: [],
    notesInherited: [],
    pendingTurns: [],
    pendingActivity: [],
  }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...base, ...fields }, null, 2), {
    mode: 0o600,
  })
}

describe("buildMeasureReport", () => {
  test("facts section reads both summaryFacts and summaryFactsInherited", () => {
    const dir = tmpSessions()
    writeSession(dir, "fixture-alpha", {
      summaryFacts: "- file: /tmp/proj/a.ts\n- command: bun test (2x)\n- noticed: parser skips blanks",
      summaryFactsInherited: "- file: /tmp/proj/a.ts\n- error: boom at line 3",
      notes: [
        { id: "n1", text: "own note one", tags: [], createdAt: "2026-01-01T00:00:00Z", source: "manual" },
        { id: "n2", text: "own note two", tags: [], createdAt: "2026-01-01T00:00:00Z", source: "manual" },
      ],
      notesInherited: [
        { id: "n3", text: "inherited note", tags: [], createdAt: "2026-01-01T00:00:00Z", source: "manual" },
      ],
      pendingTurns: [
        { turnId: "t1", messageID: "m1", userExcerpt: "one", createdAt: "2026-01-01T00:00:00Z" },
        { turnId: "t2", messageID: "m2", userExcerpt: "two", createdAt: "2026-01-01T00:00:00Z" },
      ],
      pendingActivity: [
        { id: "a1", kind: "file", target: "/tmp/proj/a.ts", command: null, count: 1, createdAt: "2026-01-01T00:00:00Z" },
        { id: "a2", kind: "file", target: "/tmp/proj/b.ts", command: null, count: 1, createdAt: "2026-01-01T00:00:00Z" },
        { id: "a3", kind: "error", target: "boom at line 3", command: null, count: 1, createdAt: "2026-01-01T00:00:00Z" },
      ],
    })
    writeSession(dir, "fixture-beta", {
      version: 3,
      build: "0.4.0",
      summaryFactsInherited: "- command: bun test (2x)",
      pendingTurns: [
        { turnId: "t3", messageID: "m3", userExcerpt: "three", createdAt: "2026-01-01T00:00:00Z" },
      ],
    })

    const report = buildMeasureReport(dir)

    expect(report.totalFiles).toBe(2)
    expect(report.schemaVersions).toEqual({ 3: 1, 4: 1 })
    expect(report.builds).toEqual({ "0.4.0": 1, "0.5.0": 1 })
    // fixture-beta was written by another build than the running plugin.
    expect(report.driftCount).toBe(1)

    // Both fields feed the facts section: alpha owns 3 lines, alpha inherits
    // 2, beta inherits 1. Six fact lines in total, five of them generic.
    expect(report.facts.sessions).toBe(2)
    expect(report.facts.ownLines).toBe(3)
    expect(report.facts.inheritedLines).toBe(3)
    expect(report.facts.genericPct).toBe(83)
    // Two lines appear twice (own vs inherited copy), so two extra occurrences.
    expect(report.facts.dupLines).toBe(2)

    expect(report.pending).toEqual({ turns: 3, activity: 3 })
    expect(report.notes).toEqual({ own: 2, inherited: 1 })
  })

  test("a missing directory yields an empty report instead of throwing", () => {
    const dir = tmpSessions()
    const report = buildMeasureReport(join(dir, "does-not-exist"))
    const expected: MeasureReport = {
      totalFiles: 0,
      schemaVersions: {},
      builds: {},
      driftCount: 0,
      facts: { sessions: 0, ownLines: 0, inheritedLines: 0, genericPct: 0, dupLines: 0 },
      pending: { turns: 0, activity: 0 },
      notes: { own: 0, inherited: 0 },
      hygiene: { permIssues: [], corruptBackups: [], staleTmp: [] },
    }
    expect(report).toEqual(expected)
  })

  test("an empty directory yields an empty report", () => {
    const dir = tmpSessions()
    expect(buildMeasureReport(dir)).toEqual(buildMeasureReport(join(dir, "nope")))
  })

  test("hygiene detects loose permissions, corrupt backups and stale tmp files", () => {
    const dir = tmpSessions()
    const loose = join(dir, "fixture-loose.json")
    writeFileSync(loose, "{}")
    chmodSync(loose, 0o644)
    const tight = join(dir, "fixture-tight.json")
    writeFileSync(tight, "{}")
    chmodSync(tight, 0o600)

    const backup = join(dir, "fixture-old.json.corrupt.1700000000000")
    writeFileSync(backup, "{")
    chmodSync(backup, 0o600)

    const stale = join(dir, "fixture-old.json.tmp.123")
    writeFileSync(stale, "{}")
    chmodSync(stale, 0o600)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, twoHoursAgo, twoHoursAgo)

    const fresh = join(dir, "fixture-new.json.tmp.456")
    writeFileSync(fresh, "{}")
    chmodSync(fresh, 0o600)

    const report = buildMeasureReport(dir)
    expect(report.hygiene.permIssues).toEqual(["fixture-loose.json"])
    expect(report.hygiene.corruptBackups).toEqual(["fixture-old.json.corrupt.1700000000000"])
    expect(report.hygiene.staleTmp).toEqual(["fixture-old.json.tmp.123"])
  })

  test("a malformed file and a fact-free file are skipped without throwing", () => {
    const dir = tmpSessions()
    const bad = join(dir, "fixture-bad.json")
    writeFileSync(bad, "{not json", { mode: 0o600 })
    writeSession(dir, "fixture-empty", {})
    // A file whose fact fields hold the wrong type must not break the scan.
    writeSession(dir, "fixture-weird", { summaryFacts: 42, pendingTurns: "nope", notes: null })

    const report = buildMeasureReport(dir)
    expect(report.totalFiles).toBe(3)
    expect(report.facts).toEqual({ sessions: 0, ownLines: 0, inheritedLines: 0, genericPct: 0, dupLines: 0 })
    expect(report.pending).toEqual({ turns: 0, activity: 0 })
    expect(report.notes).toEqual({ own: 0, inherited: 0 })
  })

  test("the report is honest: no loss section at all", () => {
    const dir = tmpSessions()
    writeSession(dir, "fixture-honest", { summaryFacts: "- file: /tmp/proj/a.ts" })
    const report = buildMeasureReport(dir)
    expect(Object.keys(report)).not.toContain("loss")
  })
})

describe("tools/measure.ts CLI", () => {
  test("prints the report for the directory argument and exits 0", () => {
    const dir = tmpSessions()
    writeSession(dir, "fixture-cli", {
      summaryFacts: "- file: /tmp/proj/a.ts",
      pendingActivity: [
        { id: "a1", kind: "file", target: "/tmp/proj/a.ts", command: null, count: 1, createdAt: "2026-01-01T00:00:00Z" },
      ],
    })

    const proc = Bun.spawnSync([process.execPath, join(ROOT, "tools", "measure.ts"), dir])
    expect(proc.exitCode).toBe(0)
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as Record<string, unknown>
    expect(parsed.totalFiles).toBe(1)
    expect(Object.keys(parsed)).not.toContain("loss")
    const facts = parsed.facts as Record<string, unknown>
    expect(facts.ownLines).toBe(1)
    const pending = parsed.pending as Record<string, unknown>
    expect(pending.activity).toBe(1)
  })

  test("without an argument it prints usage and exits non-zero", () => {
    const proc = Bun.spawnSync([process.execPath, join(ROOT, "tools", "measure.ts")])
    expect(proc.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(proc.stderr)).toContain("usage:")
  })
})
