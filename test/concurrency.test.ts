import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readMemory,
  updateMemory,
  addActivity,
  writeMemory,
  deleteMemoryFiles,
  markDeleted,
  memoryPath,
  emptyMemory,
  type PendingTurn,
} from "../src/storage"
import { appendNote } from "../src/memory"

async function storeNote(sid: string, text: string) {
  const { value } = await updateMemory(sid, (m) => appendNote(m, text, [], "manual"))
  return value.id
}

async function activityHook(sid: string, entries: Parameters<typeof addActivity>[1][]) {
  await updateMemory(sid, (m) => { for (const e of entries) addActivity(m, e) })
}

describe("concurrency", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("50 concurrent updateMemory preserve all pending turns", async () => {
    const sid = "ses_conc_turns"
    const promises = Array.from({ length: 50 }, (_, i) =>
      updateMemory(sid, (m) => {
        const turn: PendingTurn = {
          turnId: `t${i}`,
          messageID: `m${i}`,
          userExcerpt: `excerpt ${i}`,
          createdAt: new Date().toISOString(),
        }
        m.pendingTurns = [...m.pendingTurns, turn]
      }),
    )
    await Promise.all(promises)
    const m = await readMemory(sid)
    expect(m.pendingTurns.length).toBe(50)
  })

  test("summary update does not lose pendingActivity writes", async () => {
    const sid = "ses_conc_activity"
    const activityPromises = Array.from({ length: 50 }, (_, i) =>
      updateMemory(sid, (m) => {
        addActivity(m, { kind: "file", target: `/f${i}.ts` })
      }),
    )
    const summaryPromise = updateMemory(sid, (m) => {
      m.summary = "summarized"
    })
    await Promise.all([...activityPromises, summaryPromise])
    const m = await readMemory(sid)
    expect(m.summary).toBe("summarized")
    // capActivity caps at 40 distinct entries
    expect(m.pendingActivity.length).toBe(40)
  })

  test("lima puluh StoreParalelMenyimpanSemuaNote", async () => {
    const sid = "ses_conc_store"
    const promises = Array.from({ length: 50 }, (_, i) =>
      storeNote(sid, `note-${i}`),
    )
    await Promise.all(promises)
    const m = await readMemory(sid)
    expect(m.notes.length).toBe(50)
  })

  test("enamHookParalelMenyimpanSemuaActivity", async () => {
    const sid = "ses_conc_hook"
    // 6 pemanggilan hook execute.after konkuren, 6 target berbeda
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        activityHook(sid, [{ kind: "command", target: `cmd-${i}`, command: "x" }]),
      ),
    )
    const m = await readMemory(sid)
    expect(m.pendingActivity.length).toBe(6)
  })

  test("a delete during an in-flight write does not resurrect the file (T3.1)", async () => {
    const sid = "ses_delrace"
    // A file on disk so the delete has something to remove.
    await updateMemory(sid, (m) => {
      m.summary = "first"
    })
    const path = memoryPath(sid)
    expect(existsSync(path)).toBe(true)

    // Stall the atomic write inside writeFile(tmp): the tombstone check at the
    // top of the write has already passed, so a delete racing NOW is the bug.
    const fsp = await import("node:fs/promises")
    const realWriteFile = fsp.writeFile
    let stall!: () => void
    const stalled = new Promise<void>((r) => {
      stall = r
    })
    let entered = 0
    const spy = spyOn(fsp as any, "writeFile").mockImplementation(async (p: any, data: any, opts: any) => {
      if (String(p).includes(".tmp.")) {
        entered++
        await stalled
        return realWriteFile(p, data, opts)
      }
      return realWriteFile(p, data, opts)
    })
    try {
      // Holds the session lock. The wait proves the write is stalled INSIDE
      // writeFile(tmp) — i.e. the tombstone check at the top already passed.
      const writer = writeMemory(sid, { ...(await readMemory(sid)), summary: "late write" })
      for (let i = 0; i < 500 && entered === 0; i++) await new Promise((r) => setTimeout(r, 5))
      expect(entered).toBe(1)
      markDeleted(sid)
      const deleter = deleteMemoryFiles(sid)
      // The unfixed delete is not lock-guarded, so it finishes long before the
      // rename resumes; waiting for it (bounded) makes the race deterministic.
      // The fixed delete queues behind the writer instead — the timeout only
      // bounds that wait.
      await Promise.race([deleter, new Promise((r) => setTimeout(r, 250))])
      stall()
      await writer
      await deleter
      // The late rename must not resurrect the deleted session's file.
      expect(existsSync(path)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})