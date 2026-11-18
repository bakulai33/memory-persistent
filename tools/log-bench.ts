/**
 * Benchmarks the synchronous log path (T4.10, P2-7).
 *
 * Decision rule from the plan: p95 ≤ 5 ms → synchronous logging stays and the
 * measurement is documented; p95 > 5 ms → the log moves to an async queue with
 * a flush test.
 *
 * Manual only — never run in CI. All writes land in a temp XDG_DATA_HOME, and
 * the run stays below the 64 KiB log cap so no rotation pollutes the samples
 * (rotation cost is documented separately as an extreme, not steady state).
 *
 * Pemakaian: bun run tools/log-bench.ts [runs]   (default 500, stderr diredam
 * di shell dengan `2>/dev/null`; hasil keputusan tetap ke stdout).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logEvent, logPath } from "../src/log.ts"

const runs = Math.max(100, Number(process.argv[2] ?? 500) || 500)
const warmup = 50

// Never touch the live data directory.
const dir = mkdtempSync(join(tmpdir(), "log-bench-"))
process.env.XDG_DATA_HOME = dir

for (let i = 0; i < warmup; i++) logEvent("bench warmup", { i })

const durations: number[] = []
for (let i = 0; i < runs; i++) {
  const start = performance.now()
  logEvent("bench", { i, note: "x".repeat(40) })
  durations.push(performance.now() - start)
}

durations.sort((a, b) => a - b)
const pct = (p: number): number => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))]!
const mean = durations.reduce((a, b) => a + b, 0) / durations.length
const p95 = pct(95)
const verdict = p95 <= 5 ? "SYNC stays (p95 within the 5 ms budget)" : "ASYNC QUEUE required (p95 over 5 ms)"

console.log(
  JSON.stringify(
    {
      runs,
      meanMs: Number(mean.toFixed(3)),
      p50Ms: Number(pct(50).toFixed(3)),
      p95Ms: Number(p95.toFixed(3)),
      p99Ms: Number(pct(99).toFixed(3)),
      maxMs: Number(durations[durations.length - 1]!.toFixed(3)),
      bytes: { logFile: logPath() },
      decision: verdict,
    },
    null,
    2,
  ),
)

rmSync(dir, { recursive: true, force: true })
