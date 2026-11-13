import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyMemory, lockCount, readMemory, updateMemory, writeMemory } from "../src/storage"

describe("the session lock", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-lock-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("the lock map keeps no entry per session", async () => {
    const before = lockCount()
    for (let i = 0; i < 60; i++) {
      const sessionID = `ses_lock_${i}`
      await writeMemory(sessionID, emptyMemory(sessionID))
    }
    expect(lockCount()).toBe(before)
  })

  test("the lock map is cleaned after a failed write", async () => {
    const before = lockCount()
    await expect(
      updateMemory("ses_lock_fail", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(lockCount()).toBe(before)
  })

  test("the lock map is cleaned after concurrent writes to one session", async () => {
    const before = lockCount()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateMemory("ses_lock_same", (m) => {
          m.summary = `run ${i}`
        }),
      ),
    )
    expect(lockCount()).toBe(before)
  })

  test("two acquisitions of one key never overlap", async () => {
    const order: string[] = []
    const first = updateMemory("ses_lock_order", async () => {
      order.push("first-start")
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push("first-end")
    })
    const second = updateMemory("ses_lock_order", async () => {
      order.push("second-start")
      order.push("second-end")
    })
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"])
  })

  test("the lock is not reentrant", async () => {
    // The inner acquisition happens while the outer one still holds the key,
    // so it waits for a release that never comes.
    const outer = updateMemory("ses_lock_reentrant", async () => {
      await updateMemory("ses_lock_reentrant", () => null)
      return "done"
    })
    const outcome = await Promise.race([
      outer.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 150)),
    ])
    expect(outcome).toBe("blocked")
  })

  test("updateMemory on one session does not block another", async () => {
    const before = lockCount()
    const slow = updateMemory("ses_lock_slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const other = updateMemory("ses_lock_fast", () => null)
    await Promise.all([slow, other])
    const m = await readMemory("ses_lock_fast")
    expect(m.sessionID).toBe("ses_lock_fast")
    expect(lockCount()).toBe(before)
  })
})
