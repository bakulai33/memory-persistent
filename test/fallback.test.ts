/**
 * v0.6.2 fallback: stateless quota/auth errors hand off exactly once to the
 * session-scoped generator. Self-contained context; live data never touched.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import plugin from "../src/index"
import { emptyMemory, writeMemory, readMemory } from "../src/storage"
import { addPendingTurn } from "../src/memory"

let dir: string
let orig: string | undefined
let errors: any
let lines: string[]

function mockContext(sessionID: string) {
  const hooks: Record<string, any> = {}
  const ctx: any = {
    options: {},
    tool: {
      transform: (fn: any) => { fn({ add: () => {} }); return Effect.void },
      hook: () => Effect.void,
    },
    skill: {
      transform: (fn: any) => { fn({ add: () => {} }); return Effect.void },
    },
    session: {
      hook: (name: string, fn: any) => { hooks[name] = fn; return Effect.void },
      list: () => Effect.succeed({ data: [{ id: sessionID }], cursor: undefined }),
      get: () => Effect.succeed({ model: undefined }),
      generate: () => Effect.succeed({ text: "a summary" }),
    },
    experimental: { generate: { text: () => Effect.succeed({ text: "a summary" }) } },
    event: { subscribe: () => Stream.fromIterable([]) as any },
  }
  ;(ctx as any).hooks = hooks
  return { ctx, hooks }
}

async function withHeldScope<T>(ctx: any, body: () => Promise<T>): Promise<T> {
  let result!: T
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (plugin.effect(ctx) as any)
        yield* Effect.promise(async () => { result = await body() })
      }) as any,
    ) as any,
  )
  return result
}

const runHook = (fn: any, event: any) => Effect.runPromise(fn(event) as any)

async function seed(sid: string) {
  const m = emptyMemory(sid)
  for (let i = 0; i < 4; i++) {
    addPendingTurn(m, {
      turnId: `${sid}:t${i}`,
      messageID: `m${i}`,
      userExcerpt: `turn ${i}`,
      createdAt: new Date().toISOString(),
      tier: "always",
    })
  }
  await writeMemory(sid, m)
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("waitFor timeout")
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fb062-"))
  orig = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dir
  lines = []
  errors = spyOn(console, "error").mockImplementation((line: any) => { lines.push(String(line)) })
})

afterEach(() => {
  errors.mockRestore()
  if (orig === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = orig
  rmSync(dir, { recursive: true, force: true })
})

describe("v0.6.2 stateless → session fallback", () => {
  test("stateless quota error falls back once to session mode", async () => {
    const sid = "ses_fb_quota"
    const { ctx, hooks } = mockContext(sid)
    let stateless = 0, scoped = 0
    ctx.experimental.generate.text = () => {
      stateless++
      return Effect.fail(new Error("insufficient_quota") as any)
    }
    ctx.session.generate = () => {
      scoped++
      return Effect.succeed({ text: "fallback summary" })
    }
    await seed(sid)
    await withHeldScope(ctx, async () => {
      await runHook(hooks["experimental.idle"], { sessionID: sid, background: [] })
      await waitFor(async () => (await readMemory(sid)).summary.includes("fallback summary"))
    })
    expect(stateless).toBe(1)
    expect(scoped).toBe(1)
    expect(lines.some((l) => l.includes("consolidation fallback"))).toBe(true)
  })

  test("transient 5xx retries stateless without fallback", async () => {
    const sid = "ses_fb_5xx"
    const { ctx, hooks } = mockContext(sid)
    let stateless = 0, scoped = 0
    ctx.experimental.generate.text = () => {
      stateless++
      return Effect.fail(new Error("500 Internal Server Error") as any)
    }
    ctx.session.generate = () => {
      scoped++
      return Effect.succeed({ text: "unexpected" })
    }
    await seed(sid)
    await withHeldScope(ctx, async () => {
      await runHook(hooks["experimental.idle"], { sessionID: sid, background: [] })
      await waitFor(async () => (await readMemory(sid)).consolidation.state === "failed")
    })
    expect(stateless).toBe(2)
    expect(scoped).toBe(0)
    expect(lines.some((l) => l.includes("consolidation fallback"))).toBe(false)
  })

  test("auth status 401 is eligible but 400 is not", async () => {
    const sid401 = "ses_fb_401"
    const a = mockContext(sid401)
    let aScoped = 0
    a.ctx.experimental.generate.text = () => Effect.fail({ status: 401, message: "Unauthorized" } as any)
    a.ctx.session.generate = () => {
      aScoped++
      return Effect.succeed({ text: "auth fallback" })
    }
    await seed(sid401)
    await withHeldScope(a.ctx, async () => {
      await runHook(a.hooks["experimental.idle"], { sessionID: sid401, background: [] })
      await waitFor(async () => (await readMemory(sid401)).summary.includes("auth fallback"))
    })
    expect(aScoped).toBe(1)

    const sid400 = "ses_fb_400"
    const b = mockContext(sid400)
    let bScoped = 0
    b.ctx.experimental.generate.text = () => Effect.fail({ status: 400, message: "Bad Request" } as any)
    b.ctx.session.generate = () => {
      bScoped++
      return Effect.succeed({ text: "should not run" })
    }
    await seed(sid400)
    await withHeldScope(b.ctx, async () => {
      await runHook(b.hooks["experimental.idle"], { sessionID: sid400, background: [] })
      await waitFor(async () => (await readMemory(sid400)).consolidation.state === "failed")
    })
    expect(bScoped).toBe(0)
  })

  test("explicit session mode does not attempt stateless", async () => {
    const sid = "ses_fb_mode"
    const { ctx, hooks } = mockContext(sid)
    ctx.options = { consolidationMode: "session" }
    let stateless = 0, scoped = 0
    ctx.experimental.generate.text = () => {
      stateless++
      return Effect.fail(new Error("quota") as any)
    }
    ctx.session.generate = () => {
      scoped++
      return Effect.succeed({ text: "mode summary" })
    }
    await seed(sid)
    await withHeldScope(ctx, async () => {
      await runHook(hooks["experimental.idle"], { sessionID: sid, background: [] })
      await waitFor(async () => (await readMemory(sid)).summary.includes("mode summary"))
    })
    expect(stateless).toBe(0)
    expect(scoped).toBe(1)
    expect(lines.some((l) => l.includes("consolidation fallback"))).toBe(false)
  })

  test("fallback failure keeps pending turns", async () => {
    const sid = "ses_fb_fail"
    const { ctx, hooks } = mockContext(sid)
    ctx.experimental.generate.text = () => Effect.fail(new Error("quota") as any)
    ctx.session.generate = () => Effect.fail(new Error("quota again") as any)
    await seed(sid)
    const before = await readMemory(sid)
    await withHeldScope(ctx, async () => {
      await runHook(hooks["experimental.idle"], { sessionID: sid, background: [] })
      await waitFor(async () => (await readMemory(sid)).consolidation.state === "failed")
    })
    const after = await readMemory(sid)
    expect(after.consolidation.state).toBe("failed")
    expect(after.needsConsolidation).toBe(true)
    expect(after.pendingTurns.length).toBe(before.pendingTurns.length)
  })

  test("consolidation ok marks fallback true and quota emits no retry log", async () => {
    const sid = "ses_fb_oklog"
    const { ctx, hooks } = mockContext(sid)
    ctx.experimental.generate.text = () => Effect.fail(new Error("quota") as any)
    ctx.session.generate = () => Effect.succeed({ text: "logged summary" })
    await seed(sid)
    await withHeldScope(ctx, async () => {
      await runHook(hooks["experimental.idle"], { sessionID: sid, background: [] })
      await waitFor(async () => (await readMemory(sid)).summary.includes("logged summary"))
    })
    expect(lines.some((l) => l.includes("consolidation ok") && l.includes("fallback=true"))).toBe(true)
    expect(lines.some((l) => l.includes("consolidation retry"))).toBe(false)
  })
})

describe("v0.6.2 fallback — status through the real error path (review fix)", () => {
  test("status 429 with generic message falls back", async () => {
    const sid = "ses_fb_status429"
    const { ctx, hooks } = mockContext(sid)
    let scoped = 0
    ctx.experimental.generate.text = () =>
      Effect.fail({ status: 429, message: "Too Many Requests" } as any)
    ctx.session.generate = () => {
      scoped++
      return Effect.succeed({ text: "status fallback" })
    }
    await seed(sid)
    await withHeldScope(ctx, async () => {
      await runHook(hooks["experimental.idle"], { sessionID: sid, background: [] })
      await waitFor(async () => (await readMemory(sid)).summary.includes("status fallback"))
    })
    expect(scoped).toBe(1)
  })
})
