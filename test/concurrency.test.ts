import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMemory, updateMemory, addActivity, type PendingTurn } from "../src/storage"
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
})