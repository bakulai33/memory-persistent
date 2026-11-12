import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { listAllSessionIDs, sweep, type SessionLister, type SessionPage } from "../src/sweep"
import type { MemoryFileEntry } from "../src/storage"

const page = (ids: string[], next?: string): SessionPage => ({ data: ids.map((id) => ({ id })), cursor: { next } })

/** Serves `total` sessions across pages of `pageSize`, like the real session list. */
const paged = (ids: string[], pageSize: number): SessionLister => {
  return (input) => {
    const offset = input.cursor ? Number(input.cursor) : 0
    const size = input.limit ?? pageSize
    const slice = ids.slice(offset, offset + size)
    const next = offset + size < ids.length ? String(offset + size) : undefined
    return Effect.succeed(page(slice, next))
  }
}

describe("sweep", () => {
  test("keeps memory of sessions that still exist beyond the first page", async () => {
    const ids = Array.from({ length: 149 }, (_, i) => `ses_${i}`)
    const files: MemoryFileEntry[] = ids.map((id) => ({ id, kind: "memory" as const, file: `${id}.json` }))
    const deleted: string[] = []

    const result = await Effect.runPromise(
      sweep({
        listSessions: paged(ids, 50),
        listFiles: () => Effect.succeed(files),
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(result.incomplete).toBe(false)
    expect(deleted).toEqual([])
  })

  test("deletes memory of a session that no longer exists", async () => {
    const ids = ["ses_live"]
    const files: MemoryFileEntry[] = [
      { id: "ses_live", kind: "memory", file: "ses_live.json" },
      { id: "ses_dead", kind: "memory", file: "ses_dead.json" },
    ]
    const deleted: string[] = []

    const result = await Effect.runPromise(
      sweep({
        listSessions: () => Effect.succeed(page(ids)),
        listFiles: () => Effect.succeed(files),
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(result.incomplete).toBe(false)
    expect(deleted).toEqual(["ses_dead"])
    expect(result.deleted).toEqual(["ses_dead"])
  })

  test("deletes the corrupt backup of a session that no longer exists", async () => {
    const deleted: string[] = []

    await Effect.runPromise(
      sweep({
        listSessions: () => Effect.succeed(page([])),
        listFiles: () =>
          Effect.succeed([{ id: "ses_dead", kind: "corrupt" as const, file: "ses_dead.json.corrupt.1" }]),
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(deleted).toEqual(["ses_dead"])
  })

  test("deletes nothing when the session list cannot be read", async () => {
    const deleted: string[] = []

    const result = await Effect.runPromise(
      sweep({
        listSessions: () => Effect.fail(new Error("cannot read")) as any,
        listFiles: () => Effect.succeed([{ id: "ses_live", kind: "memory" as const, file: "ses_live.json" }]),
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(result.incomplete).toBe(true)
    expect(deleted).toEqual([])
  })

  test("deletes nothing when the session list fails midway", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `ses_${i}`)
    const deleted: string[] = []
    let calls = 0

    const result = await Effect.runPromise(
      sweep({
        listSessions: (input) => {
          calls++
          if (calls === 1) return Effect.succeed(page(ids.slice(0, 50), "50"))
          return Effect.fail(new Error("read failed")) as any
        },
        listFiles: () => Effect.succeed([{ id: "ses_x", kind: "memory" as const, file: "ses_x.json" }]),
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(result.incomplete).toBe(true)
    expect(deleted).toEqual([])
  })

  test("deletes nothing when the file listing fails", async () => {
    const deleted: string[] = []

    const result = await Effect.runPromise(
      sweep({
        listSessions: () => Effect.succeed(page(["ses_live"])),
        listFiles: () => Effect.fail(new Error("cannot read dir")) as any,
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(result.incomplete).toBe(true)
    expect(deleted).toEqual([])
  })

  test("keeps memory of an archived session that still exists", async () => {
    const deleted: string[] = []

    await Effect.runPromise(
      sweep({
        listSessions: () => Effect.succeed(page(["ses_archived"])),
        listFiles: () => Effect.succeed([{ id: "ses_archived", kind: "memory" as const, file: "ses_archived.json" }]),
        deleteFiles: (id) =>
          Effect.sync(() => {
            deleted.push(id)
          }),
      }),
    )

    expect(deleted).toEqual([])
  })

  test("listAllSessionIDs returns null when the list cannot be read", async () => {
    const result = await Effect.runPromise(
      listAllSessionIDs(() => Effect.fail(new Error("boom")) as any),
    )
    expect(result).toBe(null)
  })

  test("listAllSessionIDs returns null when a cursor does not advance", async () => {
    const result = await Effect.runPromise(
      listAllSessionIDs(() => Effect.succeed(page(["ses_1"], "same"))),
    )
    expect(result).toBe(null)
  })

  test("listAllSessionIDs returns null when the page limit is exceeded", async () => {
    const result = await Effect.runPromise(
      listAllSessionIDs(() => Effect.succeed(page(["ses_1"], "next")), { maxPages: 2 }),
    )
    expect(result).toBe(null)
  })
})
