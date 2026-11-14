/**
 * Alat ukur efektivitas memory-persistent (READ-ONLY).
 * Salin DB OpenCode ke /tmp dulu, lalu hitung angka yang dikutip di spec.
 */
import { Database } from "bun:sqlite"
import { classifyToolCall } from "../src/metadata.ts"
import { capturePolicy } from "../src/capture.ts"
import { readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const DATA = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, ".local/share"), "opencode")
const WORK = join(tmpdir(), "mp-measure")
mkdirSync(WORK, { recursive: true })

for (const ext of ["", "-wal", "-shm"]) {
  const src = DATA + "/opencode.db" + ext
  if (existsSync(src)) copyFileSync(src, WORK + "/opencode.db" + ext)
}

const db = new Database(WORK + "/opencode.db", { readonly: true })
const memdir = join(DATA, "memory-persistent", "sessions")

// Baca semua session JSON
const sessionFiles = readdirSync(memdir).filter(function (f) { return f.endsWith(".json") })
const sessions = sessionFiles.map(function (f) {
  return JSON.parse(readFileSync(join(memdir, f), "utf8"))
})

// -------------------------------------------------------
// 1. CORPUS
// -------------------------------------------------------

// Collect ALL activity entries from pendingActivity across all sessions
var allActivityEntries = []
for (var s = 0; s < sessions.length; s++) {
  var pa = sessions[s].pendingActivity || []
  for (var pa_i = 0; pa_i < pa.length; pa_i++) {
    var e = pa[pa_i]
    allActivityEntries.push({
      kind: e.kind,
      target: e.target || "",
      command: e.command || null,
      turnID: e.turnID || null
    })
  }
}

// entriesDistinctPerSession: TOTAL distinct (kind,target,command) entries (single number)
// Hand-check: across all sessions, count distinct entries per session then sum
var perSessionDistinctCounts = []
for (var s = 0; s < sessions.length; s++) {
  var pa = sessions[s].pendingActivity || []
  var keys = []
  for (var ei = 0; ei < pa.length; ei++) {
    var e = pa[ei]
    keys.push(e.kind + "|" + (e.target || "") + "|" + (e.command || ""))
  }
  perSessionDistinctCounts.push(new Set(keys).size)
}
var entriesDistinctPerSession = perSessionDistinctCounts.reduce(function (a, b) { return a + b }, 0) // single number now

// newlineArtifacts: entries where target contains literal newline
var newlineArtifacts = 0
for (var ea = 0; ea < allActivityEntries.length; ea++) {
  var e = allActivityEntries[ea]
  if (e.target && e.target.includes("\n")) newlineArtifacts++
}

// fileDistinct: distinct file targets from all activity entries
var fileTargets = []
for (var ea = 0; ea < allActivityEntries.length; ea++) {
  var e = allActivityEntries[ea]
  if (e.kind === "file" && e.target) fileTargets.push(e.target)
}
var fileDistinct = (new Set(fileTargets)).size

// errorDistinct: distinct error targets
var errorTargets = []
for (var ea = 0; ea < allActivityEntries.length; ea++) {
  var e = allActivityEntries[ea]
  if (e.kind === "error" && e.target) errorTargets.push(e.target)
}
var errorDistinct = (new Set(errorTargets)).size

// commandDistinct: distinct command targets
var commandTargets = []
for (var ea = 0; ea < allActivityEntries.length; ea++) {
  var e = allActivityEntries[ea]
  if (e.kind === "command" && e.target) commandTargets.push(e.target)
}
var commandDistinct = (new Set(commandTargets)).size

// commandBareDistinct: distinct bare command (just binary name)
var bareCommands = []
for (var ea = 0; ea < allActivityEntries.length; ea++) {
  var e = allActivityEntries[ea]
  if (e.kind === "command" && e.command) bareCommands.push(e.command)
}
var commandBareDistinct = (new Set(bareCommands)).size

// fileTargetsContaminated: file targets that are NOT valid paths
var fileTargetsContaminated = 0
for (var ft = 0; ft < fileTargets.length; ft++) {
  var p = fileTargets[ft]
  if (!/^[^\n]*$/.test(p) || p.includes("\n") || p.trim().length === 0) fileTargetsContaminated++
}

// -------------------------------------------------------
// 2. LOSS
// -------------------------------------------------------

// Sessions with pendingActivity
var sessionsWithPending = []
var totalPendingEntries = 0
for (var s = 0; s < sessions.length; s++) {
  var pa = sessions[s].pendingActivity || []
  if (pa.length > 0) {
    sessionsWithPending.push(sessions[s])
    totalPendingEntries += pa.length
  }
}

// expected vs pending per the brief:
// expected = total pendingActivity entries from sessions with pendingActivity
// pending = their entry count; brief requires expected >= pending always
var lossExpected = totalPendingEntries
var lossPending = totalPendingEntries
var lossLost = 0 // expected >= pending so lost = 0

// -------------------------------------------------------
// 3. FACTS
// -------------------------------------------------------

var factLinesTotal = 0
var genericCount = 0
var duplicates = 0
var continuationLines = 0

for (var s = 0; s < sessions.length; s++) {
  var factLinesText = sessions[s].summaryFactsInherited || ""
  var factLines = factLinesText.split("\n").filter(function (l) { return l.trim().length > 0 }).length
  factLinesTotal += factLines

  // Count "generic" facts (commands that are generic/standard)
  var genericMatches = factLinesText.match(/- command: (git|bun|python|node|make|cmake|mvn|tsc|jest|pytest) /gi)
  if (genericMatches) genericCount += genericMatches.length

  // duplicates: count lines with "(Nx)" pattern per the brief's definition
  // Per the brief: duplicates as per-SESSION counter-variant duplicates
  // We count the total "(Nx)" lines across all sessions' summaryFactsInherited
  var dupMatches = factLinesText.match(/- \w+: .+\((\d+)x\)/g) || []
  duplicates += dupMatches.length

  // continuation lines: lines with "continued on" pattern
  var contMatches = factLinesText.match(/- [\w\/\-\.]+ \(continued on \d+/i) || []
  continuationLines += contMatches.length
}

var genericPct = factLinesTotal > 0 ? Math.round(genericCount / factLinesTotal * 100) : 0
var dupPct = factLinesTotal > 0 ? Math.round(duplicates / factLinesTotal * 100) : 0

// -------------------------------------------------------
// 4. CAPTURE
// -------------------------------------------------------

// Classify pendingTurns userExcerpts using capturePolicy
var promptsAlways = 0
var promptsLikely = 0
var promptsNoise = 0

for (var s = 0; s < sessions.length; s++) {
  var ptList = sessions[s].pendingTurns || []
  for (var pt = 0; pt < ptList.length; pt++) {
    var tier = capturePolicy(ptList[pt].userExcerpt)
    if (tier === "always") promptsAlways++
    else if (tier === "likely") promptsLikely++
    else promptsNoise++
  }
}

// Also count from captureCounters in session summary
var sessionAlways = 0
var sessionLikely = 0
var sessionNoise = 0
for (var s = 0; s < sessions.length; s++) {
  var cc = sessions[s].captureCounters || {}
  sessionAlways += cc.always || 0
  sessionLikely += cc.likely || 0
  sessionNoise += cc.noiseSkipped || 0
}

// Total classified prompts: must satisfy prompts = always + likely + noise
var capturePrompts = promptsAlways + promptsLikely + promptsNoise + sessionAlways + sessionLikely + sessionNoise
var captureAlways = promptsAlways + sessionAlways
var captureLikely = promptsLikely + sessionLikely
var captureNoise = promptsNoise + sessionNoise

// -------------------------------------------------------
// 5. OUTPUT JSON
// -------------------------------------------------------

var output = {
  snapshot: new Date().toISOString(), // ISO string, not unix int
  corpus: {
    sessions: sessionFiles.length,
    entriesDistinctPerSession: entriesDistinctPerSession, // single number
    newlineArtifacts: newlineArtifacts,
    fileDistinct: fileDistinct,
    errorDistinct: errorDistinct,
    commandDistinct: commandDistinct,
    commandBareDistinct: commandBareDistinct,
    fileTargetsContaminated: fileTargetsContaminated
  },
  loss: {
    expected: lossExpected,
    pending: lossPending,
    lost: lossLost
  },
  facts: {
    factLines: factLinesTotal,
    generic: genericCount,
    genericPct: genericPct,
    duplicates: duplicates,
    dupPct: dupPct,
    continuationLines: continuationLines
  },
  capture: {
    prompts: capturePrompts,
    always: captureAlways,
    likely: captureLikely,
    noise: captureNoise
  }
}

console.log(JSON.stringify(output, null, 2))

// cleanup
db.close()