import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import {
  buildHealthReport,
  captureCounters,
  lastConsolidation,
  recordCapture,
  recordConsolidation,
  resetHealthState,
  logEvent,
  logDrift,
  type HealthReport,
} from "../src/health"
import { addActivity, emptyMemory, type MemoryFile } from "../src/storage"
import { addPendingTurn } from "../src/memory"
import { writeMemory, readMemory } from "../src/storage"
import plugin from "../src/index"

const RUNNING = { build: "0.4.0", sourceHash: "hash-abc" }

/** A memory file with a recorded failure that is still inside its backoff. */
function failedMemory(sessionID = "ses_fail"): MemoryFile {
  const memory = emptyMemory(sessionID)
  memory.needsConsolidation = true
  memory.consolidation.state = "failed"
  memory.consolidation.error = "provider timeout"
  memory.consolidation.consecutiveFailures = 2
  memory.consolidation.lastAttemptAt = new Date(Date.now() - 1_000).toISOString()
  return memory
}

beforeEach(() => {
  resetHealthState()
})

afterEach(() => {
  resetHealthState()
})

describe("health report", () => {
  test("drift is true when the file build differs from the running build", () => {
    const memory = emptyMemory("ses_drift")
    memory.build = "0.3.0"
    const report = buildHealthReport(memory, RUNNING)
    expect(report.drift).toBe(true)
    expect(report.fileBuild).toBe("0.3.0")
    expect(report.build).toBe("0.4.0")
  })

  test("drift is false when the file build matches the running build", () => {
    const memory = emptyMemory("ses_same")
    memory.build = RUNNING.build
    expect(buildHealthReport(memory, RUNNING).drift).toBe(false)
  })

  test("pending counts turns, activity and notes", () => {
    const memory = emptyMemory("ses_pending")
    addPendingTurn(memory, { turnId: "t1", messageID: "m1", userExcerpt: "one", createdAt: "2026-01-01T00:00:00.000Z" })
    addPendingTurn(memory, { turnId: "t2", messageID: "m2", userExcerpt: "two", createdAt: "2026-01-01T00:00:00.000Z" })
    addActivity(memory, { kind: "file", target: "src/index.ts" })
    addActivity(memory, { kind: "command", target: "git commit" })
    memory.notes.push({ id: "n1", text: "a note", tags: [], createdAt: "2026-01-01T00:00:00.000Z", source: "manual" })

    const report = buildHealthReport(memory, RUNNING)
    expect(report.pending).toEqual({ turns: 2, activity: 2, notes: 1 })
  })

  test("nextRetryInMs is null when no retry is pending", () => {
    const memory = emptyMemory("ses_idle")
    expect(buildHealthReport(memory, RUNNING).consolidation.nextRetryInMs).toBeNull()
  })

  test("nextRetryInMs is null when nothing needs consolidation", () => {
    const memory = failedMemory("ses_nothing")
    memory.needsConsolidation = false
    expect(buildHealthReport(memory, RUNNING).consolidation.nextRetryInMs).toBeNull()
  })

  test("nextRetryInMs holds the remaining backoff when a retry is pending", () => {
    const memory = failedMemory("ses_retry")
    const now = Date.parse(memory.consolidation.lastAttemptAt!) + 1_000
    const report = buildHealthReport(memory, RUNNING, { now })
    expect(report.consolidation.nextRetryInMs).toBe(119_000)
  })

  test("the consolidation section mirrors the memory file", () => {
    const memory = failedMemory("ses_state")
    const report = buildHealthReport(memory, RUNNING)
    expect(report.consolidation.state).toBe("failed")
    expect(report.consolidation.error).toBe("provider timeout")
    expect(report.consolidation.consecutiveFailures).toBe(2)
  })

  test("the report has exactly the documented shape", () => {
    const report = buildHealthReport(emptyMemory("ses_shape"), RUNNING)
    expect(Object.keys(report)).toEqual([
      "build",
      "fileBuild",
      "drift",
      "sourceTreeOk",
      "sourceHash",
      "consolidation",
      "pending",
      "lastConsolidation",
      "capture",
      "logPath",
    ])
    expect(Object.keys(report.consolidation)).toEqual(["state", "error", "consecutiveFailures", "nextRetryInMs"])
    expect(Object.keys(report.pending)).toEqual(["turns", "activity", "notes"])
    expect(Object.keys(report.capture)).toEqual(["always", "likely", "noiseSkipped"])
    expect(report.sourceHash).toBe("hash-abc")
    expect(report.sourceTreeOk).toBe(true)
  })

  test("the report is a pure function of its inputs", () => {
    const memory = emptyMemory("ses_pure")
    const options = { now: 1_000, capture: { always: 1, likely: 0, noiseSkipped: 0 } }
    const first = buildHealthReport(memory, RUNNING, options)
    const second = buildHealthReport(memory, RUNNING, options)
    expect(second).toEqual(first)
    // The memory file is an input, so a change to it changes the report.
    addPendingTurn(memory, {
      turnId: "t1",
      messageID: "m1",
      userExcerpt: "one",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect(buildHealthReport(memory, RUNNING, options).pending.turns).toBe(1)
  })

  test("the default report reads the recorded state of its own session", () => {
    recordCapture("ses_pure", "always")
    const report = buildHealthReport(emptyMemory("ses_pure"), RUNNING, {
      capture: captureCounters("ses_pure"),
    })
    expect(report.capture.always).toBe(1)
  })

  test("the report never carries another session's counters", () => {
    recordCapture("ses_other", "always")
    recordCapture("ses_other", "always")
    recordConsolidation("ses_other", { estPromptTokens: 900, ms: 12 })
    const report = buildHealthReport(emptyMemory("ses_mine"), RUNNING)
    expect(report.capture).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
    expect(report.lastConsolidation).toBeNull()
  })

  test("lastConsolidation is null until a consolidation is recorded", () => {
    const report = buildHealthReport(emptyMemory("ses_none"), RUNNING)
    expect(report.lastConsolidation).toBeNull()
  })

  test("lastConsolidation carries the recorded attempt", () => {
    recordConsolidation("ses_last", { estPromptTokens: 1234, ms: 56, at: "2026-01-01T00:00:00.000Z" })
    const report = buildHealthReport(emptyMemory("ses_last"), RUNNING, {
      lastConsolidation: lastConsolidation("ses_last"),
    })
    expect(report.lastConsolidation).toEqual({ estPromptTokens: 1234, ms: 56, at: "2026-01-01T00:00:00.000Z" })
  })

  test("consolidation.error is redacted in the report", () => {
    const memory = emptyMemory("ses_redact")
    memory.consolidation.error = "token=sk-abcdefghijklmnopqrstuvwxyz"
    const report = buildHealthReport(memory, RUNNING)
    expect(report.consolidation.error).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(report.consolidation.error).toContain("[REDACTED]")
  })

  test("buildHealthReport is pure given explicit inputs", () => {
    recordCapture("ses_global", "always")
    const memory = emptyMemory("ses_pure_inputs")
    const options = {
      capture: { always: 0, likely: 0, noiseSkipped: 0 },
      lastConsolidation: null,
      sourceTreeOk: true,
    }
    const first = buildHealthReport(memory, RUNNING, options)
    recordCapture("ses_global", "always")
    const second = buildHealthReport(memory, RUNNING, options)
    expect(second).toEqual(first)
  })
})

describe("capture counters", () => {
  test("recordCapture counts every tier", () => {
    recordCapture("ses_capture", "always")
    recordCapture("ses_capture", "likely")
    recordCapture("ses_capture", "likely")
    recordCapture("ses_capture", "noise")
    const report = buildHealthReport(emptyMemory("ses_capture"), RUNNING, {
      capture: captureCounters("ses_capture"),
    })
    expect(report.capture).toEqual({ always: 1, likely: 2, noiseSkipped: 1 })
  })

  test("the counters belong to one session only", () => {
    recordCapture("ses_one", "always")
    const other = buildHealthReport(emptyMemory("ses_two"), RUNNING)
    expect(other.capture).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
  })
})

describe("resetHealthState", () => {
  test("clears a session's counters and last consolidation", () => {
    recordCapture("ses_reset", "always")
    recordConsolidation("ses_reset", { estPromptTokens: 10, ms: 5 })
    resetHealthState("ses_reset")
    expect(captureCounters("ses_reset")).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
    expect(lastConsolidation("ses_reset")).toBeNull()
  })
})

describe("structured log", () => {
  test("logEvent writes one prefixed line of key=value pairs", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("capture", { sid: "ses_1", tier: "always", turns: 3 })
      expect(errors.mock.calls.length).toBe(1)
      expect(errors.mock.calls[0]![0]).toBe("[memory-persistent] capture sid=ses_1 tier=always turns=3")
    } finally {
      errors.mockRestore()
    }
  })

  test("logEvent skips null and undefined values", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("consolidation failed", { sid: "ses_1", error: null, attempt: undefined })
      expect(errors.mock.calls[0]![0]).toBe("[memory-persistent] consolidation failed sid=ses_1")
    } finally {
      errors.mockRestore()
    }
  })

  test("logEvent quotes a value that carries a space", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("activity", { sid: "ses_1", kind: "command", target: "git commit", count: 2 })
      expect(errors.mock.calls[0]![0]).toBe(
        '[memory-persistent] activity sid=ses_1 kind=command target="git commit" count=2',
      )
    } finally {
      errors.mockRestore()
    }
  })

  test("logEvent never writes a secret", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("activity", { sid: "ses_1", target: "export API_KEY=sk-abcdefghijklmnopqrstuvwxyz" })
      const line = String(errors.mock.calls[0]![0])
      expect(line).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
      expect(line).toContain("[REDACTED]")
    } finally {
      errors.mockRestore()
    }
  })

  test("logEvent cuts a long error short", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("consolidation failed", { sid: "ses_1", error: "x".repeat(1_000) })
      const line = String(errors.mock.calls[0]![0])
      expect(line.length).toBeLessThan(500)
      expect(line).toContain("…")
    } finally {
      errors.mockRestore()
    }
  })

  test("logDrift reports a build drift once per build pair", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logDrift("ses_drift", "0.3.0", "0.4.0")
      logDrift("ses_drift", "0.3.0", "0.4.0")
      expect(errors.mock.calls.length).toBe(1)
      expect(errors.mock.calls[0]![0]).toBe(
        "[memory-persistent] drift sid=ses_drift fileBuild=0.3.0 runningBuild=0.4.0",
      )
    } finally {
      errors.mockRestore()
    }
  })

  test("logDrift stays silent when the builds match", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logDrift("ses_same", "0.4.0", "0.4.0")
      expect(errors.mock.calls.length).toBe(0)
    } finally {
      errors.mockRestore()
    }
  })
})

describe("health report on a stored session", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-health-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("a stored session reports its own pending state only", async () => {
    const memory = emptyMemory("ses_stored")
    addPendingTurn(memory, { turnId: "t1", messageID: "m1", userExcerpt: "one", createdAt: "2026-01-01T00:00:00.000Z" })
    await writeMemory("ses_stored", memory)

    const other = emptyMemory("ses_other")
    addActivity(other, { kind: "file", target: "src/index.ts" })
    await writeMemory("ses_other", other)

    const stored = await readMemory("ses_stored")
    const report: HealthReport = buildHealthReport(stored, RUNNING)
    expect(report.pending).toEqual({ turns: 1, activity: 0, notes: 0 })
    expect(JSON.stringify(report)).not.toContain("src/index.ts")
  })
})

describe("the memory_health tool", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-health-tool-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  /** A context with the parts of the plugin API the activation touches. */
  function mockContext(sessionID: string) {
    const tools = new Map<string, any>()
    const ctx: any = {
      options: {},
      tool: {
        transform: (fn: any) => {
          fn({ add: (tool: any) => tools.set(tool.name, tool) })
          return Effect.void
        },
        hook: () => Effect.void,
      },
      skill: { transform: (fn: any) => { fn({ add: () => {} }); return Effect.void } },
      session: {
        hook: () => Effect.void,
        list: () => Effect.succeed({ data: [{ id: sessionID }], cursor: undefined }),
        get: () => Effect.succeed({ model: undefined }),
        generate: () => Effect.succeed({ text: "a summary" }),
      },
      experimental: { generate: { text: () => Effect.succeed({ text: "a summary" }) } },
      event: { subscribe: () => Stream.empty },
    }
    return { ctx, tools }
  }

  test("the tool returns the documented report for its own session", async () => {
    const { ctx, tools } = mockContext("ses_tool")
    // The plugin logs its activation; the test output stays quiet.
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      await Effect.runPromise(Effect.scoped(plugin.effect(ctx)))
    } finally {
      errors.mockRestore()
    }

    const memory = emptyMemory("ses_tool")
    addPendingTurn(memory, {
      turnId: "t1",
      messageID: "m1",
      userExcerpt: "one",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    await writeMemory("ses_tool", memory)

    const tool = tools.get("memory_health")
    expect(tool).toBeDefined()
    const result = (await Effect.runPromise(tool.execute({}, { sessionID: "ses_tool" }))) as {
      content: { type: string; text: string }[]
    }
    const report = JSON.parse(result.content[0]!.text)

    expect(Object.keys(report)).toEqual([
      "build",
      "fileBuild",
      "drift",
      "sourceTreeOk",
      "sourceHash",
      "consolidation",
      "pending",
      "lastConsolidation",
      "capture",
      "logPath",
    ])
    expect(report.pending).toEqual({ turns: 1, activity: 0, notes: 0 })
    expect(report.build).toBe("0.4.0")
    expect(report.sourceTreeOk).toBe(true)
    expect(report.sourceHash.length).toBeGreaterThan(0)
    expect(report.capture).toEqual({ always: 0, likely: 0, noiseSkipped: 0 })
  })
})
