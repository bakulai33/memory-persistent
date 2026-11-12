import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capturePolicy, type CaptureTier } from "../src/capture"
import { memoryDir, readMemory } from "../src/storage"

interface SyntheticCase {
  id: string
  lang: string
  kind: string
  text: string
  tier: CaptureTier
}

interface LabeledCase {
  id: string
  lang: string
  label: "durable" | "noise"
  text: string
}

const FIXTURES = join(import.meta.dir, "fixtures")

const synthetic = JSON.parse(readFileSync(join(FIXTURES, "prompts-synthetic.json"), "utf8")) as SyntheticCase[]
const labeled = JSON.parse(readFileSync(join(FIXTURES, "prompts-labeled.json"), "utf8")) as LabeledCase[]

/** A prompt is captured unless the policy calls it noise. */
function captured(text: string): boolean {
  return capturePolicy(text) !== "noise"
}

function rate(hits: number, total: number): number {
  return total === 0 ? 0 : hits / total
}

describe("capture policy", () => {
  test("the examples from the brief hold", () => {
    expect(capturePolicy("hi")).toBe("noise")
    expect(capturePolicy("saya setuju dengan masukan anda")).toBe("always")
    expect(capturePolicy("lakukan deep analysis pada source code")).toBe("always")
    expect(capturePolicy("perbaiki bug di src/index.ts")).toBe("always")
    expect(capturePolicy("@memory-persistent simpan konteks")).toBe("always")
  })

  test("greetings are noise", () => {
    for (const greeting of ["hi", "halo", "ok", "okay", "thanks", "terima kasih", "siap"]) {
      expect(`${greeting}:${capturePolicy(greeting)}`).toBe(`${greeting}:noise`)
    }
  })

  test("a short prompt without a marker is noise", () => {
    expect(capturePolicy("hmm")).toBe("noise")
    expect(capturePolicy("  cek  ")).toBe("noise")
  })

  test("an empty prompt is noise", () => {
    expect(capturePolicy("")).toBe("noise")
    expect(capturePolicy("   \n  ")).toBe("noise")
  })

  test("a plain question is kept as likely", () => {
    expect(capturePolicy("apa perbedaan antara cache dan buffer di kode ini?")).toBe("likely")
  })

  test("a long prompt is always kept", () => {
    const long = "a".repeat(121)
    expect(capturePolicy(long)).toBe("always")
    expect(capturePolicy("a".repeat(120))).toBe("likely")
  })

  test("every synthetic case lands on the tier the fixture expects", () => {
    for (const item of synthetic) {
      expect(`${item.id}:${capturePolicy(item.text)}`).toBe(`${item.id}:${item.tier}`)
    }
  })
})

describe("capture policy on the labeled set", () => {
  test("the labeled set holds a hundred cases", () => {
    expect(labeled.length).toBe(100)
    expect(labeled.filter((item) => item.label === "durable").length).toBeGreaterThan(0)
    expect(labeled.filter((item) => item.label === "noise").length).toBeGreaterThan(0)
  })

  test("durable intent recall is at least 85 percent", () => {
    const durable = labeled.filter((item) => item.label === "durable")
    const hits = durable.filter((item) => captured(item.text)).length
    expect(rate(hits, durable.length)).toBeGreaterThanOrEqual(0.85)
  })

  test("noise that is captured stays at or below 5 percent", () => {
    const noise = labeled.filter((item) => item.label === "noise")
    const leaks = noise.filter((item) => captured(item.text)).length
    expect(rate(leaks, noise.length)).toBeLessThanOrEqual(0.05)
  })

  test("indonesian recall is at least 85 percent", () => {
    const durable = labeled.filter((item) => item.label === "durable" && item.lang === "id")
    expect(durable.length).toBeGreaterThan(10)
    const hits = durable.filter((item) => captured(item.text)).length
    expect(rate(hits, durable.length)).toBeGreaterThanOrEqual(0.85)
  })

  test("english recall is at least 85 percent", () => {
    const durable = labeled.filter((item) => item.label === "durable" && item.lang === "en")
    expect(durable.length).toBeGreaterThan(10)
    const hits = durable.filter((item) => captured(item.text)).length
    expect(rate(hits, durable.length)).toBeGreaterThanOrEqual(0.85)
  })
})

describe("pending turn tier", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-tier-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("a v3 file without a tier loads with the default tier", async () => {
    mkdirSync(memoryDir(), { recursive: true })
    writeFileSync(
      join(memoryDir(), "ses_legacy.json"),
      JSON.stringify({
        version: 3,
        sessionID: "ses_legacy",
        parentSnapshotFrom: null,
        build: "0.4.0",
        summary: "",
        summaryFacts: "",
        summaryNarrative: "",
        notes: [],
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "an old turn", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
        pendingActivity: [],
        needsConsolidation: false,
        consolidation: {
          state: "idle",
          attemptId: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          consecutiveFailures: 0,
          deferrals: 0,
          deferredSince: null,
          lastAttemptAt: null,
          consolidatedNotes: 0,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    )

    const memory = await readMemory("ses_legacy")
    expect(memory.pendingTurns.length).toBe(1)
    expect(memory.pendingTurns[0]?.tier).toBe("likely")
  })

  test("a stored tier survives a roundtrip", async () => {
    mkdirSync(memoryDir(), { recursive: true })
    writeFileSync(
      join(memoryDir(), "ses_tier.json"),
      JSON.stringify({
        version: 3,
        sessionID: "ses_tier",
        parentSnapshotFrom: null,
        build: "0.4.0",
        summary: "",
        summaryFacts: "",
        summaryNarrative: "",
        notes: [],
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "a strong turn", createdAt: "2026-01-01T00:00:00.000Z", tier: "always" },
        ],
        pendingActivity: [],
        needsConsolidation: false,
        consolidation: {
          state: "idle",
          attemptId: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          consecutiveFailures: 0,
          deferrals: 0,
          deferredSince: null,
          lastAttemptAt: null,
          consolidatedNotes: 0,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    )

    const memory = await readMemory("ses_tier")
    expect(memory.pendingTurns[0]?.tier).toBe("always")
  })

  test("an unknown tier falls back to the default tier", async () => {
    mkdirSync(memoryDir(), { recursive: true })
    writeFileSync(
      join(memoryDir(), "ses_bad_tier.json"),
      JSON.stringify({
        version: 3,
        sessionID: "ses_bad_tier",
        parentSnapshotFrom: null,
        build: "0.4.0",
        summary: "",
        summaryFacts: "",
        summaryNarrative: "",
        notes: [],
        pendingTurns: [
          { turnId: "t1", messageID: "m1", userExcerpt: "a broken turn", createdAt: "2026-01-01T00:00:00.000Z", tier: "bogus" },
        ],
        pendingActivity: [],
        needsConsolidation: false,
        consolidation: {
          state: "idle",
          attemptId: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          consecutiveFailures: 0,
          deferrals: 0,
          deferredSince: null,
          lastAttemptAt: null,
          consolidatedNotes: 0,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    )

    const memory = await readMemory("ses_bad_tier")
    expect(memory.pendingTurns[0]?.tier).toBe("likely")
  })
})
