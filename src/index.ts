import { define } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Cause, Effect, Exit, Schema, Stream } from "effect"
import {
  addActivity,
  buildInfoPath,
  copyMemory,
  deleteMemoryFiles,
  listMemoryFiles,
  markDeleted,
  repairPermissions,
  sanitizeSessionID,
  updateMemory,
} from "./storage.js"
import {
  addPendingTurn,
  appendNote,
  removeNote,
  buildConsolidationPrompt,
  buildInjection,
  collectDelta,
  applyDelta,
  runConsolidation,
  loadMemory,
  saveMemory,
  defaultConsolidationMode,
  estimatePromptTokens,
  retryOnce,
} from "./memory.js"
import {
  canConsolidate,
  shouldConsolidate,
  beginAttempt,
  finishSuccess,
  finishFailure,
  deltaAttemptId,
  shouldDefer,
  noteDeferral,
} from "./consolidation.js"
import { sweep, type SessionLister } from "./sweep.js"
import { extractUserExcerpt } from "./heuristics.js"
import { capturePolicy } from "./capture.js"
import { redact } from "./redact.js"
import {
  buildHealthReport,
  captureCounters,
  fileBuildOf,
  healthRuntime,
  lastConsolidation,
  logDrift,
  logEvent,
  recordCapture,
  recordConsolidation,
  resetHealthState,
  setHealthRuntime,
} from "./health.js"
import { classifyToolCall } from "./metadata.js"
import { checkSourceTree, sourceHash } from "./selfcheck.js"
import { BUILD, SCHEMA_VERSION } from "./build.js"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const StringArray = Schema.Array(Schema.String)

const StoreInput = Schema.Struct({
  text: Schema.String,
  tags: Schema.optional(StringArray),
})

const RecallInput = Schema.Struct({
  query: Schema.optional(Schema.String),
})

const ForgetInput = Schema.Struct({
  id: Schema.String,
})

const DEFAULT_TOKEN_BUDGET = 5000
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

// Sweeps are spaced out per plugin instance so an idle session does not rescan on every turn.
let lastSweepAt = 0

// The prompt hook and the tool hook report different message ids, so the last
// user message is tracked to attribute tool activity to the turn that caused it.
// The map is bounded so long-running servers do not accumulate one entry per session.
const LAST_PROMPT_LIMIT = 256
const lastPromptMessageID = new Map<string, string>()

function trackPrompt(sessionID: string, messageID: string): void {
  lastPromptMessageID.delete(sessionID)
  lastPromptMessageID.set(sessionID, messageID)
  while (lastPromptMessageID.size > LAST_PROMPT_LIMIT) {
    const oldest = lastPromptMessageID.keys().next()
    if (oldest.done) break
    lastPromptMessageID.delete(oldest.value)
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

export default define({
  id: "memory-persistent",
  effect: Effect.fn(function* (ctx: Context) {
    const dir = dirname(fileURLToPath(import.meta.url))

    // A module graph that fails to link makes OpenCode cache the rejection and keep
    // running the previous generation forever. Refuse activation loudly instead.
    const mismatches = checkSourceTree(dir)
    if (mismatches.length > 0) {
      setHealthRuntime({ build: BUILD, sourceHash: "", sourceTreeOk: false })
      for (const mismatch of mismatches) {
        console.error(
          `[memory-persistent] FATAL source-tree-inconsistent importer=${mismatch.importer} from=${mismatch.from} missing=${mismatch.missing.join(",")}`,
        )
      }
      return
    }

    // Record this generation's source hash so the next activation can spot a stale
    // process. A missing or unreadable build record is not an error.
    const hash = sourceHash(dir)
    setHealthRuntime({ build: BUILD, sourceHash: hash, sourceTreeOk: true })
    logEvent("activation", { build: BUILD, schema: SCHEMA_VERSION, sourceHash: hash })
    try {
      const path = buildInfoPath()
      let previous: string | null = null
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { sourceHash?: unknown }
        if (typeof parsed.sourceHash === "string") previous = parsed.sourceHash
      } catch {}
      if (previous !== null && previous !== hash) {
        logEvent("drift", { fileBuild: previous, runningBuild: hash })
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        JSON.stringify(
          {
            build: BUILD,
            schema: SCHEMA_VERSION,
            sourceHash: hash,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      )
    } catch (error) {
      logEvent("build record", { error: error instanceof Error ? error.message : String(error) })
    }

    const options = (ctx.options ?? {}) as Record<string, any>
    const budget = typeof options.tokenBudget === "number" ? options.tokenBudget : DEFAULT_TOKEN_BUDGET
    // Stateless is the default: consolidation must not carry the session history.
    const consolidationMode = options.consolidationMode === "session" ? "session" : defaultConsolidationMode()
    const sweepEnabled = options.sweepEnabled !== false
    const sweepIntervalMs =
      typeof options.sweepIntervalMs === "number" ? options.sweepIntervalMs : DEFAULT_SWEEP_INTERVAL_MS

    // Register tools
    yield* ctx.tool.transform((editor: any) => {
      editor.add({
        name: "memory_store",
        description: "Store a concise memory note for the current session only.",
        input: StoreInput,
        execute: (input: any, context: any) =>
          Effect.promise(async () => {
            const sessionID = sanitizeSessionID(context.sessionID)
            const memory = await loadMemory(sessionID)
            const note = appendNote(memory, input.text, input.tags ?? [], "manual")
            await saveMemory(sessionID, memory)
            return textResult(`Stored note ${note.id}`)
          }),
      })

      editor.add({
        name: "memory_recall",
        description: "Recall memory for the current session only.",
        input: RecallInput,
        execute: (input: any, context: any) =>
          Effect.promise(async () => {
            const sessionID = sanitizeSessionID(context.sessionID)
            const memory = await loadMemory(sessionID)
            const injection = buildInjection(memory, budget)
            let notes = memory.notes
            if (input.query) {
              const q = String(input.query).toLowerCase()
              notes = notes.filter((n) => n.text.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)))
            }
            const payload = {
              summary: memory.summary,
              summaryFacts: memory.summaryFacts,
              summaryNarrative: memory.summaryNarrative,
              notes,
              pendingTurns: memory.pendingTurns.map((t) => t.userExcerpt),
              injection,
            }
            return textResult(JSON.stringify(payload, null, 2))
          }),
      })

      editor.add({
        name: "memory_list",
        description: "List memory notes for the current session only.",
        input: Schema.Struct({}),
        execute: (_input: any, context: any) =>
          Effect.promise(async () => {
            const sessionID = sanitizeSessionID(context.sessionID)
            const memory = await loadMemory(sessionID)
            return textResult(JSON.stringify(memory.notes, null, 2))
          }),
      })

      editor.add({
        name: "memory_forget",
        description: "Forget a memory note by id in the current session only.",
        input: ForgetInput,
        execute: (input: any, context: any) =>
          Effect.promise(async () => {
            const sessionID = sanitizeSessionID(context.sessionID)
            const memory = await loadMemory(sessionID)
            const ok = removeNote(memory, input.id)
            if (ok) await saveMemory(sessionID, memory)
            return textResult(ok ? `Forgot ${input.id}` : `Not found: ${input.id}`)
          }),
      })

      editor.add({
        name: "memory_health",
        description: "Report memory consolidation health for the current session only.",
        input: Schema.Struct({}),
        options: { codemode: false },
        execute: (_input: any, context: any) =>
          Effect.promise(async () => {
            const sessionID = sanitizeSessionID(context.sessionID)
            const memory = await loadMemory(sessionID)
            const runtime = healthRuntime()
            logDrift(sessionID, fileBuildOf(memory))
            const report = buildHealthReport(
              memory,
              { build: runtime.build, sourceHash: runtime.sourceHash },
              {
                sourceTreeOk: runtime.sourceTreeOk,
                capture: captureCounters(sessionID),
                lastConsolidation: lastConsolidation(sessionID),
              },
            )
            return textResult(JSON.stringify(report, null, 2))
          }),
      })
    })

    // Register skill
    try {
      const skillPath = "/home/<user>/Documents/project/memory-persistent/skills/memory-persistent/SKILL.md"
      const skillContent = readFileSync(skillPath, "utf8")
      yield* ctx.skill.transform((editor: any) => {
        editor.add({
          id: "memory-persistent",
          name: "memory-persistent",
          description: "Per-session persistent memory tools and guidance.",
          path: skillPath,
          content: skillContent,
        })
      })
    } catch {}

    // Hook: prompt (turn tagging)
    yield* ctx.session.hook("prompt", (event: any) =>
      Effect.promise(async () => {
        try {
          const sessionID = sanitizeSessionID(event.sessionID)
          const text = event.prompt?.text ?? ""
          if (!text.trim()) return
          trackPrompt(sessionID, event.messageID)
          const tier = capturePolicy(text)
          if (tier === "noise") {
            recordCapture(sessionID, tier)
            logEvent("capture", { sid: sessionID, tier, turns: 0 })
            return
          }
          const memory = await loadMemory(sessionID)
          logDrift(sessionID, fileBuildOf(memory))
          addPendingTurn(memory, {
            turnId: `${event.sessionID}:${event.messageID}`,
            messageID: event.messageID,
            userExcerpt: redact(extractUserExcerpt(text)),
            createdAt: new Date().toISOString(),
            tier,
          })
          await saveMemory(sessionID, memory)
          recordCapture(sessionID, tier)
          logEvent("capture", { sid: sessionID, tier, turns: 1 })
        } catch (err: any) {
          logEvent("hook-error", { hook: "prompt", error: err instanceof Error ? err.message : String(err) })
        }
      }),
    )

    // Hook: tool.execute.after (activity)
    yield* ctx.tool.hook("execute.after", (event: any) =>
      Effect.promise(async () => {
        try {
          const sessionID = sanitizeSessionID(event.sessionID)
          const entries = classifyToolCall(event.tool, event.input, event, lastPromptMessageID.get(sessionID))
          if (entries.length === 0) return
          const memory = await loadMemory(sessionID)
          logDrift(sessionID, fileBuildOf(memory))
          for (const entry of entries) {
            addActivity(memory, entry)
            const stored = memory.pendingActivity.find(
              (item) => item.kind === entry.kind && item.target === entry.target,
            )
            logEvent("activity", {
              sid: sessionID,
              kind: entry.kind,
              target: entry.target,
              count: stored?.count ?? 1,
            })
          }
          await saveMemory(sessionID, memory)
        } catch (err: any) {
          logEvent("hook-error", { hook: "activity", error: err instanceof Error ? err.message : String(err) })
        }
      }),
    )

    // Hook: context (injection)
    yield* ctx.session.hook("context", (event: any) =>
      Effect.promise(async () => {
        try {
          const sessionID = sanitizeSessionID(event.sessionID)
          const memory = await loadMemory(sessionID)
          const injection = buildInjection(memory, budget)
          if (!injection) return
          const already = (event.system ?? []).some((p: any) => p?.metadata?.source === "memory-persistent")
          if (already) return
          event.system = event.system ?? []
          event.system.push({
            type: "text",
            text: `Session Memory (per-session, max ${budget} tokens):\n${injection}`,
            metadata: { source: "memory-persistent" },
          })
        } catch (err: any) {
          logEvent("hook-error", { hook: "context", error: err instanceof Error ? err.message : String(err) })
        }
      }),
    )

    // Sweep: remove memory files whose session is gone. Deleting nothing is correct
    // whenever the session list cannot be enumerated completely.
    const listSessions: SessionLister = (input) =>
      ctx.session
        .list({ limit: input.limit, cursor: input.cursor as any })
        .pipe(Effect.map((page: any) => ({ data: page.data, cursor: page.cursor })))

    const runSweep = Effect.gen(function* () {
      const result = yield* sweep({
        listSessions,
        listFiles: () => Effect.promise(() => listMemoryFiles()),
        deleteFiles: (sessionID) => Effect.promise(() => deleteMemoryFiles(sessionID)),
      })
      if (result.incomplete) {
        logEvent("sweep", { status: "incomplete" })
        return
      }
      if (result.deleted.length) {
        logEvent("sweep", { deleted: result.deleted.length })
      }
    }).pipe(
      Effect.catchCause((cause) => {
        logEvent("sweep", { status: "failed", error: Cause.pretty(cause) })
        return Effect.void
      }),
    )

    // Repair file/directory permissions for files written by older versions.
    const runRepair = Effect.promise(() => repairPermissions()).pipe(
      Effect.catchCause((cause) => {
        console.error(`[memory-persistent] permission repair failed: ${Cause.pretty(cause)}`)
        return Effect.void
      }),
    )
    yield* Effect.forkScoped(runRepair, { startImmediately: true })

    if (sweepEnabled) {
      // Startup sweep, forked into the plugin scope so it never blocks activation.
      yield* Effect.forkScoped(runSweep, { startImmediately: true })
    }

    // Hook: idle (consolidation + periodic sweep)
    yield* ctx.session.hook("experimental.idle", (event: any) =>
      Effect.gen(function* () {
        const sessionID = sanitizeSessionID(event.sessionID)
        const backgroundCount = event.background?.length ?? 0

        // Deferral: while background work is outstanding, postpone consolidation
        // so we never summarize a half-finished session. A bounded fallback
        // (3 deferrals or 15 minutes) prevents an eternal deferral.
        let deferred = false
        yield* Effect.promise(async () => {
          const memory = await loadMemory(sessionID)
          if (shouldDefer(memory, backgroundCount)) {
            await updateMemory(sessionID, (m) => {
              noteDeferral(m)
            })
            deferred = true
          }
        })

        if (deferred) {
          logEvent("deferral", { sid: sessionID, reason: "background" })
          return
        }

        const fallbackNote = backgroundCount > 0
          ? "\n\nCatatan: background work mungkin masih berjalan; ringkasan dapat belum lengkap."
          : ""
        let narrativeError: string | null = null
        let estPromptTokens = 0
        const attemptStartedAt = Date.now()
        const finishAttempt = () => {
          const ms = Date.now() - attemptStartedAt
          recordConsolidation(sessionID, {
            estPromptTokens,
            ms,
            at: new Date(attemptStartedAt).toISOString(),
          })
          return ms
        }
        yield* Effect.promise(() =>
          runConsolidation({
            collect: async () =>
              (
                await updateMemory(sessionID, (m) => {
                  if (!shouldConsolidate(m)) return null
                  if (!canConsolidate(m)) return null
                  beginAttempt(m, deltaAttemptId())
                  return collectDelta(m)
                })
              ).value,
            generate: async (delta) => {
              try {
                const prompt = buildConsolidationPrompt(delta, Math.floor(budget * 0.9)) + fallbackNote
                estPromptTokens = estimatePromptTokens(prompt)
                logEvent("consolidation start", {
                  sid: sessionID,
                  attempt: delta.attemptId,
                  estPromptTokens,
                  mode: consolidationMode,
                  turns: delta.turns.length,
                  activity: delta.activityIds.length,
                })

                const sessionScoped = async () => {
                  const outcome = await Effect.runPromiseExit(ctx.session.generate({ sessionID, prompt }))
                  if (Exit.isFailure(outcome)) throw new Error(Cause.pretty(outcome.cause))
                  return String(outcome.value?.text ?? "").trim()
                }

                const retryLogged = async (
                  run: () => Promise<string>,
                  onFirstFailure: (error: string) => void,
                ): Promise<string> => {
                  let first = true
                  return retryOnce(async () => {
                    try {
                      return await run()
                    } catch (err) {
                      if (first) {
                        first = false
                        onFirstFailure(err instanceof Error ? err.message : String(err))
                      }
                      throw err
                    }
                  })
                }

                if (consolidationMode === "session") {
                  return await retryLogged(sessionScoped, (error) =>
                    logEvent("consolidation retry", { sid: sessionID, attempt: 1, error }),
                  )
                }

                const info = await Effect.runPromiseExit(ctx.session.get({ sessionID }))
                const model = Exit.isSuccess(info) ? info.value?.model : undefined
                return await retryLogged(
                  async () => {
                    const outcome = await Effect.runPromiseExit(
                      ctx.experimental.generate.text(model ? { prompt, model } : { prompt }),
                    )
                    if (Exit.isFailure(outcome)) throw new Error(Cause.pretty(outcome.cause))
                    return String(outcome.value?.text ?? "").trim()
                  },
                  (error) => logEvent("consolidation retry", { sid: sessionID, attempt: 1, error }),
                )
              } catch (err) {
                narrativeError = err instanceof Error ? err.message : String(err)
                return ""
              }
            },
            apply: async (delta, narrative) => {
              const error = narrative.trim() ? null : (narrativeError ?? "model returned no narrative")
              await updateMemory(sessionID, (m) => {
                applyDelta(m, delta, narrative, budget)
                if (error === null) {
                  finishSuccess(m, delta.attemptId)
                } else {
                  finishFailure(m, delta.attemptId, error)
                }
              })
              const ms = finishAttempt()
              if (error === null) {
                logEvent("consolidation ok", {
                  sid: sessionID,
                  attempt: delta.attemptId,
                  ms,
                  tokens: estimatePromptTokens(narrative),
                })
              } else {
                logEvent("consolidation failed", { sid: sessionID, attempt: delta.attemptId, ms, error })
              }
            },
            fail: async (delta, error) => {
              await updateMemory(sessionID, (m) => {
                finishFailure(m, delta.attemptId, error)
              })
              const ms = finishAttempt()
              logEvent("consolidation failed", { sid: sessionID, attempt: delta.attemptId, ms, error })
            },
          }),
        )

        if (sweepEnabled && Date.now() - lastSweepAt >= sweepIntervalMs) {
          lastSweepAt = Date.now()
          yield* runSweep
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory-persistent idle hook failed", { cause }))),
    )

    // Event subscription: session lifecycle
    yield* ctx.event.subscribe({ types: ["session.created", "session.deleted", "session.forked"] }).pipe(
      Stream.runForEach((event: any) => {
        const data = event?.data ?? event
        const sessionID = data?.sessionID
        if (!sessionID) return Effect.void

        if (event.type === "session.deleted") {
          return Effect.promise(async () => {
            try {
              const id = sanitizeSessionID(sessionID)
              markDeleted(id)
              await deleteMemoryFiles(id)
              resetHealthState(id)
            } catch {}
          })
        }

        // A child session inherits a snapshot of its parent; a fork inherits one too.
        const parentID = data?.parentID
        if (!parentID) return Effect.void
        return Effect.promise(async () => {
          try {
            const to = sanitizeSessionID(sessionID)
            const from = sanitizeSessionID(parentID)
            await copyMemory(from, to)
          } catch {}
        })
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
