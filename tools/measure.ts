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

// --- corpus ---
// Kumpulkan semua activity entries dari pendingActivity tiap session
var perSessionEntries = []
for (var _i = 0; _i < sessions.length; _i++) {
  var s = sessions[_i]
  var entries = []
  var pendingActivity = s.pendingActivity
  if (pendingActivity) {
    for (var _j = 0; _j < pendingActivity.length; _j++) {
      var pa = pendingActivity[_j]
      entries.push({ kind: pa.kind, target: pa.target || null, command: pa.command || null, turnID: pa.turnID || null })
    }
  }
  perSessionEntries.push(entries)
}

// entriesDistinctPerSession: for each session, count distinct entries
var entriesDistinctPerSession = []
for (var _k = 0; _k < perSessionEntries.length; _k++) {
  var ents = perSessionEntries[_k]
  var keys = []
  for (var _l = 0; _l < ents.length; _l++) {
    var e = ents[_l]
    keys.push(e.kind + ":" + (e.target || "") + ":" + (e.command || ""))
  }
  // Use Set to count distinct
  var distinctSet = new Set(keys)
  entriesDistinctPerSession.push(distinctSet.size)
}

// Gabungkan semua entries untuk perhitungan lintas session
var allEntries = perSessionEntries.flat()

// newlineArtifacts: entries where target contains literal newline
var newlineArtifacts = 0
for (var _m = 0; _m < allEntries.length; _m++) {
  var e = allEntries[_m]
  if (e.target && e.target.includes("\n")) newlineArtifacts++
}

// fileDistinct: distinct file targets
var fileTargets = []
for (var _n = 0; _n < allEntries.length; _n++) {
  var e = allEntries[_n]
  if (e.kind === "file" && e.target) fileTargets.push(e.target)
}
var fileDistinct = (new Set(fileTargets)).size

// errorDistinct: distinct error targets
var errorTargets = []
for (var _o = 0; _o < allEntries.length; _o++) {
  var e = allEntries[_o]
  if (e.kind === "error" && e.target) errorTargets.push(e.target)
}
var errorDistinct = (new Set(errorTargets)).size

// commandDistinct: distinct command targets
var commandTargets = []
for (var _p = 0; _p < allEntries.length; _p++) {
  var e = allEntries[_p]
  if (e.kind === "command" && e.target) commandTargets.push(e.target)
}
var commandDistinct = (new Set(commandTargets)).size

// commandBareDistinct: distinct bare command (just the binary name)
var bareCommands = []
for (var _q = 0; _q < allEntries.length; _q++) {
  var e = allEntries[_q]
  if (e.kind === "command" && e.command) bareCommands.push(e.command)
}
var commandBareDistinct = (new Set(bareCommands)).size

// fileTargetsContaminated: file targets that are NOT valid paths
var fileTargetsContaminated = 0
for (var _r = 0; _r < fileTargets.length; _r++) {
  var p = fileTargets[_r]
  if (!/^[^\n]*$/.test(p) || p.includes("\n") || p.trim().length === 0) fileTargetsContaminated++
}

// --- loss ---
// expected vs pending pada sesi yang punya pendingActivity
var expectedTotal = 0
var pendingTotal = 0
for (var _s = 0; _s < sessions.length; _s++) {
  var s = sessions[_s]
  var pa = s.pendingActivity || []
  if (pa.length > 0) {
    expectedTotal += 1
    pendingTotal += pa.length
  }
}
var loss = { expected: expectedTotal, pending: pendingTotal, lost: Math.max(0, expectedTotal - pendingTotal) }

/// --- facts ---
var factLinesTotal = 0
var genericCount = 0
var duplicates = 0
var continuationLines = 0

for (var _t = 0; _t < sessions.length; _t++) {
  var s = sessions[_t]
  var factLinesText = s.summaryFactsInherited || ""
  var factLines = factLinesText.split("\n").filter(function (l) { return l.trim().length > 0 }).length
  factLinesTotal += factLines

  // Count "generic" facts
  var genericMatches = factLinesText.match(/- command: (git|bun|python|node|make|cmake|mvn|tsc|jest|pytest) /gi)
  if (genericMatches) genericCount += genericMatches.length

  // duplicates: count lines with "(Nx)" pattern
  var dupMatches = factLinesText.match(/- \w+: .+\((\d+)x\)/g) || []
  duplicates += dupMatches.length

  // continuation lines: lines with "continued on" pattern
  var contMatches = factLinesText.match(/- [\w\/\-\.]+ \(continued on \d+/i) || []
  continuationLines += contMatches.length
}

var genericPct = factLinesTotal > 0 ? Math.round(genericCount / factLinesTotal * 100) : 0
var dupPct = factLinesTotal > 0 ? Math.round(duplicates / factLinesTotal * 100) : 0

// --- capture ---
var promptsAlways = 0
var promptsLikely = 0
var promptsNoise = 0

for (var _u = 0; _u < sessions.length; _u++) {
  var s = sessions[_u]
  for (var _v = 0; _v < (s.pendingTurns || []).length; _v++) {
    var pt = s.pendingTurns[_v]
    var tier = capturePolicy(pt.userExcerpt)
    if (tier === "always") promptsAlways++
    else if (tier === "likely") promptsLikely++
    else promptsNoise++
  }
}

var sessionAlways = 0
var sessionLikely = 0
var sessionNoise = 0
for (var _w = 0; _w < sessions.length; _w++) {
  var cc = sessions[_w].captureCounters || {}
  sessionAlways += cc.always || 0
  sessionLikely += cc.likely || 0
  sessionNoise += cc.noiseSkipped || 0
}

var capture = {
  prompts: sessions.length,
  always: promptsAlways + sessionAlways,
  likely: promptsLikely + sessionLikely,
  noise: promptsNoise + sessionNoise
}

// --- output JSON ---
var output = {
  snapshot: Date.now(),
  corpus: {
    sessions: sessionFiles.length,
    entriesDistinctPerSession: entriesDistinctPerSession,
    newlineArtifacts: newlineArtifacts,
    fileDistinct: fileDistinct,
    errorDistinct: errorDistinct,
    commandDistinct: commandDistinct,
    commandBareDistinct: commandBareDistinct,
    fileTargetsContaminated: fileTargetsContaminated
  },
  loss: loss,
  facts: {
    factLines: factLinesTotal,
    generic: genericCount,
    genericPct: genericPct,
    duplicates: duplicates,
    dupPct: dupPct,
    continuationLines: continuationLines
  },
  capture: capture
}

console.log(JSON.stringify(output, null, 2))

// cleanup
db.close()