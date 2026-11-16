/**
 * Plugin-level tests: tools and hooks of src/index.ts, driven through a
 * mocked plugin context (the same mockContext shape test/health.test.ts
 * uses). These cover the activation surface, every tool execution, the
 * prompt / context / activity hooks, the idle consolidation path and the
 * event subscription — the code that only runs inside a real server.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import plugin from "../src/index"
import { emptyMemory, writeMemory, readMemory, memoryDir, updateMemory } from "../src/storage"
import { appendNote, addPendingTurn } from "../src/memory"

describe("plugin (tools, hooks, events)", () => {
  let dir: string
  let orig: string | undefined
  let errors: any

  /** A context that records registered tools and hook callbacks. */
  function mockContext(sessionID: string, events: unknown[] = []) {
    const tools = new Map<string, any>()
    const hooks: Record<string, any> = {}
    let listCalls = 0
    const ctx: any = {
      options: {},
      tool: {
        transform: (fn: any) => {
          fn({ add: (tool: any) => tools.set(tool.name, tool) })
          return Effect.void
        },
        hook: (name: string, fn: any) => {
          hooks[`tool:${name}`] = fn
          return Effect.void
        },
      },
      skill: {
        transform: (fn: any) => {
          const added: any[] = []
          fn({ add: (skill: any) => added.push(skill) })
          ;(ctx as any).skillsAdded = added
          return Effect.void
        },
      },
      session: {
        hook: (name: string, fn: any) => {
          hooks[name] = fn
          return Effect.void
        },
        list: (input: any) => {
          listCalls += 1
          return Effect.succeed({ data: [{ id: sessionID }], cursor: undefined })
        },
        get: () => Effect.succeed({ model: undefined }),
        generate: () => Effect.succeed({ text: "a summary" }),
      },
      experimental: { generate: { text: () => Effect.succeed({ text: "a summary" }) } },
      event: { subscribe: () => Stream.fromIterable(events) as any },
    }
    ;(ctx as any).listCalls = () => listCalls
    return { ctx, tools, hooks }
  }

  /** Runs one captured hook callback to completion. */
  const runHook = (fn: any, event: any) => Effect.runPromise(fn(event) as any)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plug-"))
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

  async function activate(ctx: any) {
    await Effect.runPromise(Effect.scoped(plugin.effect(ctx)))
  }

  /** A fresh context bound to no particular session. */
  function ctx0(): any {
    return mockContext("ses_ctx0").ctx
  }

  /**
   * Activates while HOLDING the scope open, so fibers the plugin forks at
   * activation (startup sweep, event subscription) finish before the scope
   * closes. In production the server scope stays open for the process
   * lifetime; a bare runPromise(Effect.scoped(...)) closes it immediately
   * and interrupts those fibers mid-flight.
   */
  async function activateHeld(ctx: any, ms = 600) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (plugin.effect(ctx) as any)
          yield* Effect.sleep(ms)
        }) as any,
      ),
    )
  }

  // ---------------------------------------------------------------- tools
  test("memory_store stores a note and returns its id", async () => {
    const { ctx, tools } = mockContext("ses_store")
    await activate(ctx)
    const tool = tools.get("memory_store")!
    const result = (await Effect.runPromise(tool.execute({ text: "remember this", tags: ["t"] }, { sessionID: "ses_store" }))) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0].text).toMatch(/^Stored note [0-9a-f-]{36}$/)
    const m = await readMemory("ses_store")
    expect(m.notes).toHaveLength(1)
    expect(m.notes[0]!.text).toBe("remember this")
    expect(m.notes[0]!.source).toBe("manual")
  })

  test("memory_store rejects invalid input without writing", async () => {
    const { ctx, tools } = mockContext("ses_rej")
    await activate(ctx)
    const tool = tools.get("memory_store")!
    for (const [input, message] of [
      [{ text: "   " }, "Rejected: text is empty"],
      [{ text: "" }, "Rejected: text is empty"],
      [{ text: "ok", tags: Array.from({ length: 17 }, () => "t") }, "Rejected: too many tags (max 16)"],
      [{ text: "ok", tags: ["x".repeat(65)] }, "Rejected: invalid tag"],
      [{ text: "ok", tags: ["bad\u0000tag"] }, "Rejected: invalid tag"],
    ] as const) {
      const result = (await Effect.runPromise(tool.execute(input as any, { sessionID: "ses_rej" }))) as {
        content: { type: string; text: string }[]
      }
      expect(result.content[0].text).toBe(message)
    }
    const m = await readMemory("ses_rej")
    expect(m.notes).toHaveLength(0)
  })

  test("memory_forget removes by id and reports a missing id", async () => {
    const { ctx, tools } = mockContext("ses_forget")
    await activate(ctx)
    const m = emptyMemory("ses_forget")
    const note = appendNote(m, "to forget", [], "manual")
    await writeMemory("ses_forget", m)

    const forget = tools.get("memory_forget")!
    const miss = (await Effect.runPromise(forget.execute({ id: "nope" }, { sessionID: "ses_forget" }))) as {
      content: { type: string; text: string }[]
    }
    expect(miss.content[0].text).toBe("Not found: nope")

    const hit = (await Effect.runPromise(forget.execute({ id: note.id }, { sessionID: "ses_forget" }))) as {
      content: { type: string; text: string }[]
    }
    expect(hit.content[0].text).toBe(`Forgot ${note.id}`)
    expect((await readMemory("ses_forget")).notes).toHaveLength(0)
  })

  test("memory_recall returns the full payload and filters by query", async () => {
    const { ctx, tools } = mockContext("ses_recall")
    await activate(ctx)
    const m = emptyMemory("ses_recall")
    appendNote(m, "alpha probe note", ["a"], "manual")
    appendNote(m, "beta other note", ["b"], "manual")
    m.notesInherited = [
      { id: "i1", text: "gamma inherited note", tags: [], createdAt: new Date().toISOString(), source: "manual" },
    ]
    m.summaryFacts = "- file: src/x.ts"
    m.summaryNarrative = "narrative"
    addPendingTurn(m, { turnId: "t1", messageID: "m1", userExcerpt: "quote", createdAt: "", tier: "likely" })
    await writeMemory("ses_recall", m)

    const recall = tools.get("memory_recall")!
    const all = JSON.parse(((await Effect.runPromise(recall.execute({}, { sessionID: "ses_recall" }))) as { content: { text: string }[] }).content[0]!.text)
    expect(Object.keys(all)).toContain("summaryNarrativeVerified")
    expect(all.summaryNarrativeVerified).toBe(false)
    expect(all.notes).toHaveLength(2)
    expect(all.injection).toContain("src/x.ts")
    // catatan warisan dikembalikan terpisah, tanpa tercampur ke notes own
    expect(all.notesInherited).toHaveLength(1)
    expect(all.notesInherited[0].text).toContain("gamma")
    expect(all.notes.map((n: any) => n.text)).toEqual(["alpha probe note", "beta other note"])

    const filtered = JSON.parse(((await Effect.runPromise(recall.execute({ query: "alpha" }, { sessionID: "ses_recall" }))) as { content: { text: string }[] }).content[0]!.text)
    expect(filtered.notes).toHaveLength(1)
    expect(filtered.notes[0]!.text).toContain("alpha")
    // filter query yang sama diterapkan ke inherited
    expect(filtered.notesInherited).toHaveLength(0)
    const filteredInh = JSON.parse(((await Effect.runPromise(recall.execute({ query: "gamma" }, { sessionID: "ses_recall" }))) as { content: { text: string }[] }).content[0]!.text)
    expect(filteredInh.notesInherited).toHaveLength(1)
    expect(filteredInh.notesInherited[0].text).toContain("gamma inherited")
  })

  test("memory_list returns the notes array", async () => {
    const { ctx, tools } = mockContext("ses_list")
    await activate(ctx)
    const m = emptyMemory("ses_list")
    appendNote(m, "n1", [], "manual")
    appendNote(m, "n2", ["x"], "manual")
    await writeMemory("ses_list", m)
    const list = JSON.parse(((await Effect.runPromise(tools.get("memory_list")!.execute({}, { sessionID: "ses_list" }))) as { content: { text: string }[] }).content[0]!.text)
    expect(list.map((n: any) => n.text)).toEqual(["n1", "n2"])
  })

  // ---------------------------------------------------------------- hooks: prompt
  test("prompt hook stores always/likely turns and counts noise", async () => {
    const { ctx, hooks } = mockContext("ses_prompt")
    await activate(ctx)

    // noise: recorded as skipped, nothing stored
    await runHook(hooks["prompt"], { sessionID: "ses_prompt", messageID: "m0", prompt: { text: "hi" } })
    expect((await readMemory("ses_prompt")).pendingTurns).toHaveLength(0)

    // always: stored with tier
    await runHook(hooks["prompt"], { sessionID: "ses_prompt", messageID: "m1", prompt: { text: "perbaiki src/index.ts sekarang" } })
    const m = await readMemory("ses_prompt")
    expect(m.pendingTurns).toHaveLength(1)
    expect(m.pendingTurns[0]!.tier).toBe("always")
    expect(m.pendingTurns[0]!.userExcerpt).toContain("perbaiki")
    expect(m.captureCounters).toEqual({ always: 1, likely: 0, noiseSkipped: 1 })
    expect(m.consolidation.pendingSince).not.toBeNull()

    // empty prompt: early return, nothing changes
    await runHook(hooks["prompt"], { sessionID: "ses_prompt", messageID: "m2", prompt: { text: "   " } })
    expect((await readMemory("ses_prompt")).pendingTurns).toHaveLength(1)
  })

  test("prompt hook survives an invalid session id via hook-error", async () => {
    const { ctx, hooks } = mockContext("ses_ok")
    await activate(ctx)
    const logged: string[] = []
    const logRead = errors.mockImplementation((...args: any[]) => logged.push(args.join(" ")))
    await runHook(hooks["prompt"], { sessionID: "bad/id", messageID: "m1", prompt: { text: "perbaiki ini" } })
    logRead.mockRestore()
    // The error is logged and swallowed: the hook must not throw.
    expect(logged.some((l: string) => l.includes("hook-error") && l.includes("prompt"))).toBe(true)
  })

  test("prompt tracking evicts old message ids (bounded map)", async () => {
    const { ctx, hooks } = mockContext("ses_lru")
    await activate(ctx)
    for (let i = 0; i < 260; i++) {
      await runHook(hooks["prompt"], { sessionID: "ses_lru", messageID: `m${i}`, prompt: { text: "hi" } })
    }
    // No crash and the counter kept up: 260 noise prompts recorded.
    expect((await readMemory("ses_lru")).captureCounters.noiseSkipped).toBe(260)
  })

  // ---------------------------------------------------------------- hooks: activity
  test("activity hook records meaningful commands and folds repeats", async () => {
    const { ctx, hooks } = mockContext("ses_act")
    await activate(ctx)
    const after = hooks["tool:execute.after"]
    await runHook(after, { tool: "shell", sessionID: "ses_act", input: { command: "git commit -m x" }, status: "completed" })
    await runHook(after, { tool: "shell", sessionID: "ses_act", input: { command: "git commit -m y" }, status: "completed" })
    // read-only: nothing recorded
    await runHook(after, { tool: "shell", sessionID: "ses_act", input: { command: "ls -la" }, status: "completed" })
    const m = await readMemory("ses_act")
    expect(m.pendingActivity).toHaveLength(1)
    expect(m.pendingActivity[0]!.target).toBe("git commit")
    expect(m.pendingActivity[0]!.count).toBe(2)
  })

  test("activity hook records errors redacted and skips unknown tools", async () => {
    const { ctx, hooks } = mockContext("ses_err")
    await activate(ctx)
    const after = hooks["tool:execute.after"]
    await runHook(after, { tool: "read", sessionID: "ses_err", input: { path: "/x" }, status: "completed" })
    await runHook(after, { tool: "edit", sessionID: "ses_err", input: { path: "/x.ts" }, status: "error", error: "boom password=hunter2" })
    const m = await readMemory("ses_err")
    const kinds = m.pendingActivity.map((a) => a.kind)
    expect(kinds).toContain("error")
    expect(m.pendingActivity.find((a) => a.kind === "file")).toBeDefined()
    expect(m.pendingActivity.find((a) => a.kind === "error")!.target).toContain("[REDACTED]")
    expect(m.pendingActivity.find((a) => a.kind === "error")!.target).not.toContain("hunter2")
  })

  // ---------------------------------------------------------------- hooks: context
  test("context hook injects session memory once", async () => {
    const { ctx, hooks } = mockContext("ses_ctx")
    await activate(ctx)
    const m = emptyMemory("ses_ctx")
    m.summaryFacts = "- file: src/ctx.ts"
    await writeMemory("ses_ctx", m)

    const event: any = { sessionID: "ses_ctx", system: [] }
    await runHook(hooks["context"], event)
    expect(event.system).toHaveLength(1)
    expect(event.system[0]!.text).toContain("Session Memory")
    expect(event.system[0]!.text).toContain("src/ctx.ts")
    expect(event.system[0]!.metadata.source).toBe("memory-persistent")

    // already present: no duplicate injection
    await runHook(hooks["context"], event)
    expect(event.system).toHaveLength(1)
  })

  test("context hook does nothing when there is nothing to inject", async () => {
    const { ctx, hooks } = mockContext("ses_empty_ctx")
    await activate(ctx)
    const event: any = { sessionID: "ses_empty_ctx", system: [] }
    await runHook(hooks["context"], event)
    expect(event.system ?? []).toHaveLength(0)
  })

  // ---------------------------------------------------------------- idle: consolidation
  test("idle hook consolidates pending work and clears it", async () => {
    const { ctx, hooks } = mockContext("ses_idle")
    await activate(ctx)
    const m = emptyMemory("ses_idle")
    for (let i = 0; i < 4; i++) {
      addPendingTurn(m, { turnId: `t${i}`, messageID: `m${i}`, userExcerpt: `quote ${i}`, createdAt: "", tier: "likely" })
    }
    m.needsConsolidation = true
    await writeMemory("ses_idle", m)

    await runHook(hooks["experimental.idle"], { sessionID: "ses_idle", background: [] })

    const after = await readMemory("ses_idle")
    expect(after.pendingTurns).toHaveLength(0)
    expect(after.needsConsolidation).toBe(false)
    expect(after.consolidation.state).toBe("idle")
    expect(after.consolidation.consecutiveFailures).toBe(0)
    expect(after.summary).toContain("a summary")
  })

  test("idle hook records failure when the model call fails, facts survive", async () => {
    const failing = mockContext("ses_fail")
    failing.ctx.experimental.generate.text = () => Effect.fail(new Error("provider down") as any)
    failing.ctx.session.get = () => Effect.succeed({ model: undefined })
    await activate(failing.ctx)
    const m = emptyMemory("ses_fail")
    // 8 entries cross the pendingActivity trigger threshold.
    m.pendingActivity = Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`, kind: "command", target: `git commit ${i}`, command: "git", count: 1, createdAt: "",
    }))
    m.needsConsolidation = true
    await writeMemory("ses_fail", m)

    await runHook(failing.hooks["experimental.idle"], { sessionID: "ses_fail", background: [] })

    const after = await readMemory("ses_fail")
    expect(after.consolidation.state).toBe("failed")
    expect(after.consolidation.consecutiveFailures).toBe(1)
    // facts survive the failed model call (hybrid promise)
    expect(after.summaryFacts).toContain("- command: git commit")
    expect(after.pendingActivity).toHaveLength(0)
  })

  test("idle hook defers while background work is outstanding", async () => {
    const { ctx, hooks } = mockContext("ses_defer")
    await activate(ctx)
    const m = emptyMemory("ses_defer")
    for (let i = 0; i < 6; i++) {
      addPendingTurn(m, { turnId: `t${i}`, messageID: `m${i}`, userExcerpt: `q${i}`, createdAt: "", tier: "likely" })
    }
    m.needsConsolidation = true
    await writeMemory("ses_defer", m)

    await runHook(hooks["experimental.idle"], { sessionID: "ses_defer", background: [{ id: "b1" }] })

    const after = await readMemory("ses_defer")
    expect(after.consolidation.deferrals).toBe(1)
    // nothing consolidated: pending turns stay
    expect(after.pendingTurns).toHaveLength(6)
  })

  test("second idle inside the sweep interval skips the sweep", async () => {
    const { ctx, hooks } = mockContext("ses_sweep")
    await activate(ctx)
    const hook = hooks["experimental.idle"]
    await runHook(hook, { sessionID: "ses_sweep", background: [] })
    const callsAfterFirst = (ctx as any).listCalls()
    await runHook(hook, { sessionID: "ses_sweep", background: [] })
    // Default sweep interval is 6h: the second idle must not list sessions again.
    expect((ctx as any).listCalls()).toBe(callsAfterFirst)
  })

  // ---------------------------------------------------------------- events
  test("session.forked copies the parent memory as inherited", async () => {
    const parent = emptyMemory("ses_parent_ev")
    parent.summaryFacts = "- command: git commit (2x)"
    await writeMemory("ses_parent_ev", parent)

    const { ctx } = mockContext("ses_child_ev", [
      { type: "session.forked", data: { sessionID: "ses_child_ev", parentID: "ses_parent_ev" } },
    ])
    await activateHeld(ctx)
    expect(existsSync(join(memoryDir(), "ses_child_ev.json"))).toBe(true)
    const child = await readMemory("ses_child_ev")
    expect(child.summaryFactsInherited).toContain("git commit")
    expect(child.parentSnapshotFrom).toBe("ses_parent_ev")
  })

  test("session.deleted removes the memory files", async () => {
    const doomed = emptyMemory("ses_doomed")
    await writeMemory("ses_doomed", doomed)
    expect(existsSync(join(memoryDir(), "ses_doomed.json"))).toBe(true)

    const { ctx } = mockContext("ses_x", [
      { type: "session.deleted", data: { sessionID: "ses_doomed" } },
    ])
    await activateHeld(ctx)
    expect(existsSync(join(memoryDir(), "ses_doomed.json"))).toBe(false)
    // the deleted-session tombstone blocks a late write from recreating it
    await writeMemory("ses_doomed", emptyMemory("ses_doomed"))
    expect(existsSync(join(memoryDir(), "ses_doomed.json"))).toBe(false)
  })

  test("events without a sessionID are ignored", async () => {
    const { ctx } = mockContext("ses_none", [
      { type: "session.created", data: {} },
      { type: "session.created" },
    ])
    // Activation must not throw on malformed events, and no memory file is written.
    await activate(ctx)
    const files = existsSync(memoryDir()) ? readdirSync(memoryDir()).filter((f) => f.endsWith(".json")) : []
    expect(files).toHaveLength(0)
  })

  // ---------------------------------------------------------------- activation
  test("activation registers the skill with content from the derived path", async () => {
    const { ctx } = mockContext("ses_skill")
    await activate(ctx)
    const added = (ctx as any).skillsAdded as any[]
    expect(added).toHaveLength(1)
    expect(added[0]!.id).toBe("memory-persistent")
    expect(added[0]!.content).toContain("Memory Persistent")
  })

  test("activation logs a drift event when the recorded source hash differs", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "build.json"), JSON.stringify({ sourceHash: "stale-hash" }))

    const { ctx } = mockContext("ses_drift")
    await activate(ctx)

    const log = readFileSync(join(root, "plugin.log"), "utf8")
    expect(log).toContain("drift")
    expect(log).toContain("activation")

    // the build record now carries the running hash
    const record = JSON.parse(readFileSync(join(root, "build.json"), "utf8"))
    expect(record.build).toBe("0.5.0")
    expect(record.sourceHash).not.toBe("stale-hash")
    expect(statSync(join(root, "build.json")).mode & 0o777).toBe(0o600)
  })

  test("prompt tracking evicts across many distinct sessions", async () => {
    const { ctx, hooks } = mockContext("ses_seed")
    await activate(ctx)
    // 260 DISTINCT session ids push the bounded prompt map past its limit.
    for (let i = 0; i < 260; i++) {
      await runHook(hooks["prompt"], { sessionID: `ses_map_${i}`, messageID: "m1", prompt: { text: "hi" } })
    }
    // A later tool event for the FIRST session no longer carries its prompt id
    // (evicted), but the hook still records the activity.
    const after = hooks["tool:execute.after"]
    await runHook(after, { tool: "shell", sessionID: "ses_map_0", input: { command: "git commit" }, status: "completed" })
    const m = await readMemory("ses_map_0")
    expect(m.pendingActivity[0]!.target).toBe("git commit")
  })

  test("idle consolidation in session mode goes through session.generate", async () => {
    const scoped = mockContext("ses_modescoped")
    scoped.ctx.options = { consolidationMode: "session" }
    let generated = 0
    scoped.ctx.session.generate = () => {
      generated += 1
      return Effect.succeed({ text: "session-mode summary" })
    }
    await activate(scoped.ctx)
    const m = emptyMemory("ses_modescoped")
    m.pendingActivity = Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`, kind: "command", target: `git commit ${i}`, command: "git", count: 1, createdAt: "",
    }))
    m.needsConsolidation = true
    await writeMemory("ses_modescoped", m)

    await runHook(scoped.hooks["experimental.idle"], { sessionID: "ses_modescoped", background: [] })
    expect(generated).toBe(1)
    const after = await readMemory("ses_modescoped")
    expect(after.consolidation.state).toBe("idle")
    expect(after.summary).toContain("session-mode summary")
  })

  test("a sweep whose session listing fails is recorded as incomplete", async () => {
    const failingList = mockContext("ses_sweep_inc")
    failingList.ctx.session.list = () => Effect.fail(new Error("db closed") as any)
    await activateHeld(failingList.ctx)
    const log = readFileSync(join(dir, "opencode", "memory-persistent", "plugin.log"), "utf8")
    expect(log).toContain("sweep status=incomplete")
  })

  test("a sweep whose lister throws is caught and logged as failed", async () => {
    const throwing = mockContext("ses_sweep_fail")
    throwing.ctx.session.list = () => {
      throw new Error("boom")
    }
    await activateHeld(throwing.ctx)
    const log = readFileSync(join(dir, "opencode", "memory-persistent", "plugin.log"), "utf8")
    expect(log).toContain("sweep status=failed")
  })

  test("activation tolerates a corrupt build record", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "build.json"), "{ not json")
    await activate(ctx0())
    // The record was rewritten with the running build.
    const record = JSON.parse(readFileSync(join(root, "build.json"), "utf8"))
    expect(record.build).toBe("0.5.0")
  })

  test("activity and context hooks swallow an invalid session id", async () => {
    const { ctx, hooks } = mockContext("ses_hk")
    await activate(ctx)
    // Neither hook throws; both log hook-error and move on.
    await runHook(hooks["tool:execute.after"], { tool: "shell", sessionID: "bad/id", input: { command: "git commit" }, status: "completed" })
    await runHook(hooks["context"], { sessionID: "bad/id", system: [] })
    const log = readFileSync(join(dir, "opencode", "memory-persistent", "plugin.log"), "utf8")
    expect(log.split("hook-error").length - 1).toBeGreaterThanOrEqual(2)
  })

  test("the startup sweep deletes orphan memory files and logs it", async () => {
    // An orphan: a memory file whose session does not exist in the listing.
    await writeMemory("ses_orphan_live", emptyMemory("ses_orphan_live"))
    const sweeping = mockContext("ses_live_now")
    await activateHeld(sweeping.ctx)
    expect(existsSync(join(memoryDir(), "ses_orphan_live.json"))).toBe(false)
    const log = readFileSync(join(dir, "opencode", "memory-persistent", "plugin.log"), "utf8")
    expect(log).toContain("sweep deleted=1")
  })

  test("the deferral fallback consolidates with a partial note when deferrals are exhausted", async () => {
    const fb = mockContext("ses_fallback")
    await activate(fb.ctx)
    const m = emptyMemory("ses_fallback")
    m.pendingActivity = Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`, kind: "command", target: `git commit ${i}`, command: "git", count: 1, createdAt: "",
    }))
    m.needsConsolidation = true
    await writeMemory("ses_fallback", m)
    // Exhaust the deferral budget first.
    await updateMemory("ses_fallback", (mm) => {
      mm.consolidation.deferrals = 3
      mm.consolidation.deferredSince = new Date(Date.now() - 20 * 60_000).toISOString()
    })
    await runHook(fb.hooks["experimental.idle"], { sessionID: "ses_fallback", background: [{ id: "b1" }] })
    const after = await readMemory("ses_fallback")
    // Fallback: consolidation ran DESPITE background work.
    expect(after.pendingActivity).toHaveLength(0)
    expect(after.needsConsolidation).toBe(false)
  })

  test("session-mode consolidation logs the retry when the first attempt fails", async () => {
    const scoped = mockContext("ses_mode_retry")
    scoped.ctx.options = { consolidationMode: "session" }
    let calls = 0
    scoped.ctx.session.generate = () => {
      calls += 1
      return calls === 1 ? Effect.fail(new Error("transient") as any) : Effect.succeed({ text: "retried summary" })
    }
    await activate(scoped.ctx)
    const m = emptyMemory("ses_mode_retry")
    m.pendingActivity = Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`, kind: "command", target: `git commit ${i}`, command: "git", count: 1, createdAt: "",
    }))
    m.needsConsolidation = true
    await writeMemory("ses_mode_retry", m)

    await runHook(scoped.hooks["experimental.idle"], { sessionID: "ses_mode_retry", background: [] })
    expect(calls).toBe(2)
    const after = await readMemory("ses_mode_retry")
    expect(after.consolidation.state).toBe("idle")
    expect(after.summary).toContain("retried summary")
  })

  test("malformed lifecycle events are swallowed", async () => {
    const { ctx } = mockContext("ses_life", [
      { type: "session.deleted", data: { sessionID: "bad/id" } },   // sanitize throws -> catch
      { type: "session.forked", data: { sessionID: "bad/id", parentID: "bad/parent" } },
      { type: "session.forked", data: { sessionID: "ses_fk", parentID: "bad/parent" } },
    ])
    await activateHeld(ctx)
  })

  test("activation survives an unwritable build-record path", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    mkdirSync(root, { recursive: true })
    // Make the data root read-only so writing build.json fails.
    chmodSync(root, 0o500)
    try {
      const { ctx } = mockContext("ses_ro")
      await activate(ctx)
      // Plugin still activated (tools registered) despite the failed record write.
      expect((ctx as any).skillsAdded).toHaveLength(1)
    } finally {
      chmodSync(root, 0o700)
    }
  })
})
