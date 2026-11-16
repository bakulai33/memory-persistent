import { Effect, Exit } from "effect"
import type { MemoryFileEntry } from "./storage.js"

export interface SessionPage {
  readonly data: readonly { readonly id: string }[]
  readonly cursor?: { readonly next?: string }
}

export type SessionLister = (input: { limit?: number; cursor?: string }) => Effect.Effect<SessionPage, unknown>

export interface SweepOptions {
  readonly listSessions: SessionLister
  readonly listFiles: () => Effect.Effect<readonly MemoryFileEntry[], unknown>
  readonly deleteFiles: (sessionID: string) => Effect.Effect<void, unknown>
  readonly limit?: number
  readonly maxPages?: number
}

export interface SweepResult {
  readonly deleted: readonly string[]
  /** True when the session list could not be enumerated completely, so nothing was deleted. */
  readonly incomplete: boolean
}

/**
 * Collects every session id. Returns null when the list cannot be enumerated completely,
 * which tells the caller to delete nothing rather than to guess.
 */
export const listAllSessionIDs = (
  lister: SessionLister,
  options: { limit?: number; maxPages?: number } = {},
): Effect.Effect<readonly string[] | null> =>
  Effect.gen(function* () {
    const limit = options.limit ?? 200
    const maxPages = options.maxPages ?? 50
    const ids = new Set<string>()
    let cursor: string | undefined = undefined
    for (let page = 0; page < maxPages; page++) {
      const outcome: Exit.Exit<SessionPage, unknown> = yield* lister({ limit, cursor }).pipe(Effect.exit)
      if (Exit.isFailure(outcome)) return null
      const current: SessionPage = outcome.value
      for (const session of current.data ?? []) ids.add(session.id)
      const next: string | undefined = current.cursor?.next
      if (!next) return [...ids]
      if (next === cursor) return null
      cursor = next
    }
    return null
  })

/**
 * Removes the memory files of sessions that no longer exist. Deleting nothing is the
 * correct outcome whenever the session list cannot be read completely.
 *
 * The file listing runs FIRST: files are the deletion targets, so they are
 * enumerated before the session list is read. A file created after the file
 * listing is never a target, even though the session page it is compared
 * against is already stale by then.
 */
export const sweep = (options: SweepOptions): Effect.Effect<SweepResult> =>
  Effect.gen(function* () {
    const files: Exit.Exit<readonly MemoryFileEntry[], unknown> = yield* options.listFiles().pipe(Effect.exit)
    if (Exit.isFailure(files)) return { deleted: [], incomplete: true }

    const ids = yield* listAllSessionIDs(options.listSessions, {
      limit: options.limit,
      maxPages: options.maxPages,
    })
    if (ids === null) return { deleted: [], incomplete: true }

    const live = new Set(ids)
    const orphans = new Set<string>()
    for (const file of files.value) if (!live.has(file.id)) orphans.add(file.id)

    const deleted: string[] = []
    for (const id of orphans) {
      const outcome: Exit.Exit<void, unknown> = yield* options.deleteFiles(id).pipe(Effect.exit)
      if (Exit.isSuccess(outcome)) deleted.push(id)
    }
    return { deleted, incomplete: false }
  })
