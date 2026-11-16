/**
 * Parser robustness: a wrong-typed field is repaired to its default and the
 * repair is logged; a broken file is quarantined (renamed + logged); a simply
 * missing file stays silent. Feeds corrupted-but-parseable v4 files through
 * readMemory and pins the normalized result plus the log lines.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCHEMA_VERSION } from "../src/build"
import { emptyMemory, memoryDir, memoryPath, readMemory, writeMemory } from "../src/storage"

const NOW = "2026-01-01T00:00:00.000Z"

/** A fully valid v4 memory object, so each case mutates exactly one field. */
function validFile(id: string): Record<string, unknown> {
  return {
    version: SCHEMA_VERSION,
    sessionID: id,
    parentSnapshotFrom: null,
    build: "0.5.0",
    summary: "worked on the parser",
    summaryFacts: "- command: bun test (3x)",
    summaryFactsInherited: "",
    summaryNarrative: "did parser things",
    notes: [{ id: "n1", text: "note one", tags: ["t"], createdAt: NOW, source: "manual" }],
    pendingTurns: [{ turnId: "t1", messageID: "m1", userExcerpt: "hello", createdAt: NOW }],
    pendingActivity: [{ id: "a1", kind: "command", target: "git commit", command: "git", count: 2, createdAt: NOW }],
    needsConsolidation: true,
    consolidation: {
      state: "failed", attemptId: "att1", startedAt: null, finishedAt: null, error: "boom",
      consecutiveFailures: 2, deferrals: 0, deferredSince: null, lastAttemptAt: NOW,
      pendingSince: null, consolidatedNotes: 0,
    },
    captureCounters: { always: 3, likely: 2, noiseSkipped: 1 },
    updatedAt: NOW,
  }
}

/** Writes a raw file body (object → JSON, string → verbatim) at the session path. */
function seed(id: string, body: unknown): void {
  mkdirSync(memoryDir(), { recursive: true })
  const text = typeof body === "string" ? body : JSON.stringify(body)
  writeFileSync(memoryPath(id), text, { encoding: "utf8", mode: 0o600 })
}

function logLines(errors: any): string[] {
  return errors.mock.calls.map((c: unknown[]) => String(c[0]))
}

function hasCorruptBackup(id: string): boolean {
  return existsDir() && readdirSync(memoryDir()).some((f) => f.startsWith(`${id}.json.corrupt.`))
}

function existsDir(): boolean {
  try {
    return readdirSync(memoryDir()).length >= 0
  } catch {
    return false
  }
}

describe("parser robustness (normalize + log)", () => {
  let dir: string
  let orig: string | undefined
  let errors: any

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parse-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
    errors = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errors.mockRestore()
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("captureCounters of the wrong type is repaired to zeros and logged", async () => {
    seed("ses_cc", { ...validFile("ses_cc"), captureCounters: 5 })
    const m = await readMemory("ses_cc")
    expect(m.captureCounters).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=captureCounters"))
    expect(fix).toBeDefined()
    expect(fix).toContain("sid=ses_cc")
    // the good fields survive untouched
    expect(m.summaryFacts).toBe("- command: bun test (3x)")
  })

  test("[pin] a simply missing file returns an empty memory and logs nothing", async () => {
    const m = await readMemory("ses_absent")
    expect(m.sessionID).toBe("ses_absent")
    expect(m.notes).toEqual([])
    const lines = logLines(errors).filter((l) => l.includes("normalize") || l.includes("quarantine"))
    expect(lines).toEqual([])
  })

  test("captureCounters with a missing key is filled (partial → complete) and logged", async () => {
    seed("ses_ccp", { ...validFile("ses_ccp"), captureCounters: { always: 3 } })
    const m = await readMemory("ses_ccp")
    expect(m.captureCounters).toEqual({ always: 3, likely: 0, noiseSkipped: 0 })
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=captureCounters"))
    expect(fix).toBeDefined()
  })

  test("summaryFacts of the wrong type is repaired to an empty string and logged", async () => {
    seed("ses_sf", { ...validFile("ses_sf"), summaryFacts: 5 })
    const m = await readMemory("ses_sf")
    expect(m.summaryFacts).toBe("")
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=summaryFacts"))
    expect(fix).toBeDefined()
    expect(fix).toContain("sid=ses_sf")
  })

  test("notes of the wrong type is repaired to an empty array and logged", async () => {
    seed("ses_n", { ...validFile("ses_n"), notes: 42 })
    const m = await readMemory("ses_n")
    expect(m.notes).toEqual([])
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=notes"))
    expect(fix).toBeDefined()
    expect(fix).not.toContain("dropped")
  })

  test("non-conforming pendingTurns elements are dropped, counted, and logged", async () => {
    seed("ses_pt", { ...validFile("ses_pt"), pendingTurns: [42] })
    const m = await readMemory("ses_pt")
    expect(m.pendingTurns).toEqual([])
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=pendingTurns"))
    expect(fix).toBeDefined()
    expect(fix).toContain("dropped=1")
  })

  test("conforming pendingTurns elements survive next to dropped ones", async () => {
    const turn = { turnId: "t1", messageID: "m1", userExcerpt: "hello", createdAt: NOW }
    seed("ses_ptk", { ...validFile("ses_ptk"), pendingTurns: [42, turn] })
    const m = await readMemory("ses_ptk")
    expect(m.pendingTurns).toEqual([{ turnId: "t1", messageID: "m1", userExcerpt: "hello", createdAt: NOW, tier: "likely" }])
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=pendingTurns"))
    expect(fix).toContain("dropped=1")
  })

  test("a non-array pendingTurns is repaired and logged, NOT quarantined", async () => {
    seed("ses_nt", { ...validFile("ses_nt"), pendingTurns: "abc" })
    const m = await readMemory("ses_nt")
    expect(m.pendingTurns).toEqual([])
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=pendingTurns"))
    expect(fix).toBeDefined()
    // behavior change vs the old parser: a wrong-typed array field is a repair,
    // not a quarantine — no corrupt backup, no quarantine log
    expect(hasCorruptBackup("ses_nt")).toBe(false)
    expect(logLines(errors).some((l) => l.includes("quarantine"))).toBe(false)
  })

  test("a non-array pendingActivity is repaired and logged, NOT quarantined", async () => {
    seed("ses_pa", { ...validFile("ses_pa"), pendingActivity: "nope" })
    const m = await readMemory("ses_pa")
    expect(m.pendingActivity).toEqual([])
    const fix = logLines(errors).find((l) => l.includes("normalize") && l.includes("field=pendingActivity"))
    expect(fix).toBeDefined()
    expect(hasCorruptBackup("ses_pa")).toBe(false)
  })

  test("broken JSON is quarantined: renamed beside itself and logged", async () => {
    seed("ses_bad", "{ definitely not json")
    const m = await readMemory("ses_bad")
    expect(m.sessionID).toBe("ses_bad")
    expect(m.summaryFacts).toBe("")
    expect(logLines(errors).some((l) => l.includes("quarantine") && l.includes("sid=ses_bad"))).toBe(true)
    expect(hasCorruptBackup("ses_bad")).toBe(true)
  })

  test("a foreign version is quarantined and logged", async () => {
    seed("ses_ver", { ...validFile("ses_ver"), version: 99 })
    const m = await readMemory("ses_ver")
    expect(m.sessionID).toBe("ses_ver")
    expect(logLines(errors).some((l) => l.includes("quarantine") && l.includes("sid=ses_ver"))).toBe(true)
    expect(hasCorruptBackup("ses_ver")).toBe(true)
  })

  test("a sessionID mismatch is quarantined and logged", async () => {
    seed("ses_mm", { ...validFile("ses_mm"), sessionID: "ses_imposter" })
    const m = await readMemory("ses_mm")
    expect(m.sessionID).toBe("ses_mm")
    expect(logLines(errors).some((l) => l.includes("quarantine") && l.includes("sid=ses_mm"))).toBe(true)
    expect(hasCorruptBackup("ses_mm")).toBe(true)
  })

  test("[pin] round-trip: parse → write → parse is identity except build and updatedAt", async () => {
    const first = await readMemory("ses_rt")
    first.summary = "worked on the parser"
    first.summaryFacts = "- command: bun test (3x)"
    first.summaryNarrative = "did parser things"
    first.parentSnapshotFrom = "ses_parent_rt"
    first.notes = [{ id: "n1", text: "note one", tags: ["t"], createdAt: NOW, source: "manual" }]
    first.notesInherited = [{ id: "n0", text: "inherited", tags: [], createdAt: NOW, source: "auto" }]
    first.inheritedDepth = 1
    first.pendingTurns = [{ turnId: "t1", messageID: "m1", userExcerpt: "hello", createdAt: NOW, tier: "always" }]
    first.pendingActivity = [{ id: "a1", kind: "command", target: "git commit", command: "git", count: 2, turnID: "t1", createdAt: NOW }]
    first.needsConsolidation = true
    first.consolidation = {
      state: "failed", attemptId: null, startedAt: null, finishedAt: NOW, error: "boom",
      consecutiveFailures: 2, deferrals: 1, deferredSince: NOW, lastAttemptAt: NOW,
      pendingSince: NOW, consolidatedNotes: 4,
    }
    first.captureCounters = { always: 3, likely: 2, noiseSkipped: 1 }
    await writeMemory("ses_rt", first)
    expect(statSync(memoryPath("ses_rt")).mode & 0o777).toBe(0o600)

    const second = await readMemory("ses_rt")
    const strip = (m: Record<string, unknown>) => {
      const { build: _build, updatedAt: _updatedAt, ...rest } = m
      return rest
    }
    expect(strip(second as unknown as Record<string, unknown>)).toEqual(strip(JSON.parse(JSON.stringify(first))))
    // the round-trip itself repairs nothing and quarantines nothing
    const lines = logLines(errors).filter((l) => l.includes("normalize") || l.includes("quarantine"))
    expect(lines).toEqual([])
  })
})
