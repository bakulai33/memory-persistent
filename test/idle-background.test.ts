/**
 * Idle-hook background tests (T1.3): consolidation must run in a plugin-scoped
 * FiberMap so `experimental.idle` returns immediately instead of blocking the
 * host on a model call (CRITICAL finding of the 0.6.1 analysis). Every "returns
 * quickly" claim is proven with `Effect.timeout`, never guessed.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Queue, Stream } from "effect"
import plugin from "../src/index"
import { emptyMemory, writeMemory, readMemory } from "../src/storage"
import { addPendingTurn } from "../src/memory"

describe("idle background (T1.3)", () => {
  let dir: string
  let orig: string | undefined
  let errors: any

  /**
   * Minimal plugin context for these tests: hook capture, a queue-backed event
   * stream (events can be pushed mid-test), and a controllable generator.
   */
  function mockContext(sessionID: string) {
    const hooks: Record<string, any> = {}
    const queue = Effect.runSync(Queue.unbounded<any>())
    const ctx: any = {
      options: {},
      tool: {
        transform: (fn: any) => {
          fn({ add: () => {} })
          return Effect.void
        },
        hook: () => Effect.void,
      },
      skill: {
        transform: (fn: any) => {
          fn({ add: () => {} })
          return Effect.void
        },
      },
      session: {
        hook: (name: string, fn: any) => {
          hooks[name] = fn
          return Effect.void
        },
        list: (input: any) => Effect.succeed({ data: [{ id: sessionID }], cursor: undefined }),
        get: () => Effect.succeed({ model: undefined }),
        generate: () => Effect.succeed({ text: "a summary" }),
      },
      experimental: { generate: { text: () => Effect.succeed({ text: "a summary" }) } },
      event: { subscribe: () => Stream.fromQueue(queue) as any },
    }
    ;(ctx as any).hooks = hooks
    ;(ctx as any).push = (event: any) => {
      Effect.runSync(Queue.offer(queue, event))
    }
    return ctx
  }

  /** Runs the test body while the activation scope is HELD OPEN, so plugin-scoped
   * fibers (FiberMap) stay alive exactly like in the real server. */
  async function withHeldScope<T>(ctx: any, body: () => Promise<T>): Promise<T> {
    let result!: T
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (plugin.effect(ctx) as any)
          yield* Effect.promise(async () => {
            result = await body()
          })
        }) as any,
      ) as any,
    )
    return result
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "idlebg-"))
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

  const runHook = (fn: any, event: any) => Effect.runPromise(fn(event) as any)

  /** Fails when the hook does not return within `ms` — proving non-blocking. */
  const runHookWithin = (fn: any, event: any, ms = 1000) =>
    Effect.runPromise(Effect.timeout(fn(event) as any, ms) as any)

  async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
    const start = Date.now()
    for (;;) {
      if (await check()) return
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  const seedPending = async (sessionID: string, turns = 4) => {
    const m = emptyMemory(sessionID)
    for (let i = 0; i < turns; i++) {
      addPendingTurn(m, { turnId: `t${i}`, messageID: `m${i}`, userExcerpt: `quote ${i}`, createdAt: "", tier: "likely" })
    }
    m.needsConsolidation = true
    await writeMemory(sessionID, m)
  }

  test("idle hook returns while the model call is held", async () => {
    const ctx = mockContext("ses_hold")
    let calls = 0
    ctx.experimental.generate.text = () => {
      calls++
      return Effect.never as any
    }
    await withHeldScope(ctx, async () => {
      await seedPending("ses_hold", 4)
      const idle = (ctx as any).hooks["experimental.idle"]
      // Hook must return quickly even though generate never completes.
      await runHookWithin(idle, { sessionID: "ses_hold", background: [] })
      // The fiber did start (collect marked the attempt running)...
      await waitFor(async () => (await readMemory("ses_hold")).consolidation.state === "running")
      // ...but nothing was consolidated while generate is held.
      const after = await readMemory("ses_hold")
      expect(after.pendingTurns).toHaveLength(4)
      expect(calls).toBe(1)
    })
  })

  test("after the model responds, the background fiber consolidates", async () => {
    const ctx = mockContext("ses_release")
    // The plugin reads `outcome.value?.text`, so the model result is { text }.
    let release!: (value: { text: string }) => void
    const gate = new Promise<{ text: string }>((resolve) => {
      release = resolve
    })
    ctx.experimental.generate.text = () => Effect.promise(() => gate) as any
    await withHeldScope(ctx, async () => {
      await seedPending("ses_release", 6)
      const idle = (ctx as any).hooks["experimental.idle"]
      await runHookWithin(idle, { sessionID: "ses_release", background: [] })
      await waitFor(async () => (await readMemory("ses_release")).consolidation.state === "running")
      release({ text: "a summary from the fiber" })
      await waitFor(async () => {
        const m = await readMemory("ses_release")
        return m.pendingTurns.length === 0 && m.consolidation.state === "idle"
      })
      expect((await readMemory("ses_release")).summary).toContain("a summary from the fiber")
    })
  })

  test("a second idle while consolidation runs does not start another attempt", async () => {
    const ctx = mockContext("ses_only")
    let calls = 0
    ctx.experimental.generate.text = () => {
      calls++
      return Effect.never as any
    }
    await withHeldScope(ctx, async () => {
      await seedPending("ses_only", 4)
      const idle = (ctx as any).hooks["experimental.idle"]
      await runHookWithin(idle, { sessionID: "ses_only", background: [] })
      await waitFor(() => calls === 1)
      await runHookWithin(idle, { sessionID: "ses_only", background: [] })
      await new Promise((r) => setTimeout(r, 50))
      // onlyIfMissing: the running fiber is left alone.
      expect(calls).toBe(1)
    })
  })

  test("session.deleted interrupts the running consolidation fiber", async () => {
    const ctx = mockContext("ses_doomfiber")
    let release!: (value: { text: string }) => void
    const gate = new Promise<{ text: string }>((resolve) => {
      release = resolve
    })
    ctx.experimental.generate.text = () => Effect.promise(() => gate) as any
    await withHeldScope(ctx, async () => {
      await seedPending("ses_doomfiber", 4)
      const idle = (ctx as any).hooks["experimental.idle"]
      await runHookWithin(idle, { sessionID: "ses_doomfiber", background: [] })
      await waitFor(async () => (await readMemory("ses_doomfiber")).consolidation.state === "running")
      ;(ctx as any).push({ type: "session.deleted", data: { sessionID: "ses_doomfiber" } })
      // The delete handler removes the files while the fiber is still held.
      await waitFor(() => !existsSync(join(dir, "opencode", "memory-persistent", "ses_doomfiber.json")))
      // FiberMap.remove freed the session's slot: a NEW idle hook forks a NEW
      // fiber, whose collect logs write-skipped-deleted. Without the remove,
      // onlyIfMissing would reuse the held fiber and the line would never
      // appear. (The fiber's own onInterrupt is unobservable here: the whole
      // pipeline runs inside one uninterruptible Effect.promise region, so the
      // interrupt lands as soon as the model promise settles.)
      const logFile = join(dir, "opencode", "memory-persistent", "plugin.log")
      await runHookWithin(idle, { sessionID: "ses_doomfiber", background: [] })
      await waitFor(() => existsSync(logFile) && readFileSync(logFile, "utf8").includes("write-skipped-deleted"))
      // Releasing the gate lets the zombie proceed: its writes must stay skipped.
      release({ text: "late summary" })
      await waitFor(() => readFileSync(logFile, "utf8").split("write-skipped-deleted").length - 1 >= 2)
      expect(existsSync(join(dir, "opencode", "memory-persistent", "ses_doomfiber.json"))).toBe(false)
    })
  })

  test("the periodic sweep runs in the background and does not block the hook", async () => {
    const ctx = mockContext("ses_sweepbg")
    ctx.options = { sweepIntervalMs: 0 }
    let listCalls = 0
    ctx.session.list = () => {
      listCalls++
      return Effect.never as any
    }
    await withHeldScope(ctx, async () => {
      const idle = (ctx as any).hooks["experimental.idle"]
      // Startup sweep is already held in its fiber.
      await waitFor(() => listCalls === 1)
      // A hook whose periodic sweep is held must still return quickly.
      await runHookWithin(idle, { sessionID: "ses_sweepbg", background: [] })
      await waitFor(() => listCalls === 2)
      // The held sweep fiber is reused (onlyIfMissing): no third list call.
      await runHookWithin(idle, { sessionID: "ses_sweepbg", background: [] })
      await new Promise((r) => setTimeout(r, 50))
      expect(listCalls).toBe(2)
    })
  })
})
