import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** A named import in the entry module whose target module does not export it. */
export interface ImportMismatch {
  readonly importer: string
  readonly from: string
  readonly missing: string[]
}

// Matches the export forms the source tree uses. TypeScript's erased forms
// (`export type`, `export interface`) still count: a named import of them is
// valid even though nothing lands in the runtime module.
const EXPORT_RE =
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)|export\s+class\s+([A-Za-z_$][\w$]*)|export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)|export\s+(?:type\s+)?\{([^}]*)\}|export\s+default\b/g

// Statements start at the beginning of a line. The clause is non-greedy and is
// rejected when it contains a quote, which means a side-effect import was crossed.
const IMPORT_RE = /^[ \t]*import\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/gm
const REEXPORT_RE = /^[ \t]*export\s+(type\s+)?\{([^}]*)\}\s+from\s*["']([^"']+)["']/gm
const STAR_RE = /^[ \t]*export\s+\*\s+from\s*["']([^"']+)["']/gm

/** Names a module exports, including `default`, re-exports, and type-only exports. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(EXPORT_RE)) {
    if (/^export\s+default\b/.test(match[0])) {
      names.add("default")
      continue
    }
    const direct = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (direct) {
      names.add(direct)
      continue
    }
    if (match[5] !== undefined) {
      for (const part of match[5].split(",")) {
        const item = part.trim().replace(/^type\s+/, "")
        if (!item) continue
        const alias = item.match(/\s+as\s+([A-Za-z_$][\w$]*)$/)
        names.add(alias ? alias[1]! : item.split(/\s+/)[0]!)
      }
    }
  }
  return names
}

/** The names an import clause requests, ignoring specifiers erased at runtime. */
function clauseNames(clause: string): string[] {
  const names: string[] = []
  const brace = clause.match(/\{([\s\S]*)\}/)
  if (brace) {
    for (const part of brace[1]!.split(",")) {
      const raw = part.trim()
      if (!raw || raw.startsWith("type ")) continue
      const item = raw.replace(/^type\s+/, "")
      const as = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/)
      names.push(as ? as[1]! : item.split(/\s+/)[0]!)
    }
  }
  const beforeBrace = (brace ? clause.slice(0, clause.indexOf("{")) : clause).trim()
  if (beforeBrace && /^[A-Za-z_$]/.test(beforeBrace) && !beforeBrace.startsWith("*")) {
    const def = beforeBrace.match(/^([A-Za-z_$][\w$]*)/)
    if (def) names.push("default")
  }
  return names
}

/** Enumerates runtime imports exactly like OpenCode's loader, so type-only imports are excluded. */
function scannedImports(source: string): string[] {
  try {
    return new Bun.Transpiler({ loader: "ts", target: "bun" }).scan(source).imports.map((item) => item.path)
  } catch {
    return []
  }
}

function importRequests(source: string): Map<string, Set<string>> {
  const requests = new Map<string, Set<string>>()
  const add = (path: string, name: string) => {
    let names = requests.get(path)
    if (!names) requests.set(path, (names = new Set()))
    names.add(name)
  }

  for (const match of source.matchAll(IMPORT_RE)) {
    const typeOnly = Boolean(match[1])
    const clause = match[2]!
    const path = match[3]!
    if (typeOnly) continue
    if (clause.includes('"') || clause.includes("'")) continue
    for (const name of clauseNames(clause)) add(path, name)
  }

  for (const match of source.matchAll(REEXPORT_RE)) {
    if (match[1]) continue
    for (const name of clauseNames(`{${match[2]!}}`)) add(match[3]!, name)
  }

  return requests
}

/**
 * Names a module exports, following `export * from` chains (depth-capped) so a
 * star re-export never produces a false positive.
 */
function exportedNamesFull(source: string, dir: string, depth = 0): Set<string> {
  const names = exportedNames(source)
  if (depth >= 8) return names
  for (const match of source.matchAll(STAR_RE)) {
    const target = resolveModule(dir, match[1]!)
    if (!target) continue
    try {
      for (const name of exportedNamesFull(readFileSync(target, "utf8"), dirname(target), depth + 1)) {
        names.add(name)
      }
    } catch {}
  }
  return names
}

/** Maps a `./x.js`-style specifier to the `.ts` file that provides it, if any. */
function resolveModule(importerDir: string, specifier: string): string | null {
  const base = resolve(importerDir, specifier)
  const candidates: string[] = []
  if (base.endsWith(".js")) candidates.push(base.slice(0, -".js".length) + ".ts")
  else if (base.endsWith(".jsx")) candidates.push(base.slice(0, -".jsx".length) + ".tsx")
  if (existsSync(base)) candidates.push(base)
  if (!/\.[A-Za-z]+$/.test(base)) {
    candidates.push(`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * The FULL import graph check: BFS over local runtime imports starting at
 * `<dir>/index.ts`, verifying every named import against its target module
 * (including `export *` chains). An empty result means the whole reachable
 * graph can link — not just the entry's own imports.
 */
export function checkSourceGraph(dir: string): ImportMismatch[] {
  const entry = join(dir, "index.ts")
  let entrySource: string
  try {
    entrySource = readFileSync(entry, "utf8")
  } catch {
    return []
  }

  const mismatches: ImportMismatch[] = []
  const visited = new Set<string>()
  const queue: string[] = [entry]

  while (queue.length > 0) {
    const importer = queue.shift()!
    if (visited.has(importer)) continue
    visited.add(importer)

    let source: string
    try {
      source = readFileSync(importer, "utf8")
    } catch {
      continue
    }

    const scanned = new Set(scannedImports(source))
    for (const [specifier, names] of importRequests(source)) {
      if (!specifier.startsWith(".") || !scanned.has(specifier)) continue
      const target = resolveModule(dirname(importer), specifier)
      if (!target) continue
      if (!visited.has(target)) queue.push(target)

      let targetSource: string
      try {
        targetSource = readFileSync(target, "utf8")
      } catch {
        continue
      }

      const exported = exportedNamesFull(targetSource, dirname(target))
      const missing = [...names].filter((name) => !exported.has(name)).sort()
      if (missing.length > 0) mismatches.push({ importer, from: specifier, missing })
    }
  }

  return mismatches.sort((a, b) => a.importer.localeCompare(b.importer) || a.from.localeCompare(b.from))
}

/**
 * Reads only: reports named imports in `<dir>/index.ts` whose local target does
 * not export them. Kept as the entry-focused wrapper over `checkSourceGraph`.
 */
export function checkSourceTree(dir: string): ImportMismatch[] {
  const entry = join(dir, "index.ts")
  return checkSourceGraph(dir).filter((mismatch) => mismatch.importer === entry)
}

/**
 * sha256 over every `*.ts` file in `dir`, in filename order. Sorted input makes
 * the hash independent of directory enumeration order.
 */
export function sourceHash(dir: string): string {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    entries = []
  }

  const hash = createHash("sha256")
  for (const file of entries.filter((entry) => entry.endsWith(".ts")).sort()) {
    const full = join(dir, file)
    try {
      if (!statSync(full).isFile()) continue
      hash.update(file)
      hash.update("\0")
      hash.update(readFileSync(full))
      hash.update("\0")
    } catch {}
  }
  return hash.digest("hex")
}
