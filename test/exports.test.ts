import { describe, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const FILES = ["src/index.ts", "src/build.ts"]
const SNAPSHOT_PATH = join(import.meta.dir, "exports.snapshot.json")

function extractExports(src: string): string[] {
  const names: string[] = []
  const re = /export\s+(?:(?:async\s+)?function|const|interface|type)\s+(\w+)|export\s*\{([^}]+)\}/g
  for (const m of src.matchAll(re)) {
    if (m[1]) {
      names.push(m[1])
    } else if (m[2]) {
      for (const part of m[2].split(",")) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const asMatch = trimmed.match(/^\w+\s+as\s+(\w+)$/)
        if (asMatch) names.push(asMatch[1])
        else names.push(trimmed.split(/\s+/)[0])
      }
    }
  }
  return names
}

describe("export contract", () => {
  test("public exports match snapshot", () => {
    if (!existsSync(SNAPSHOT_PATH)) {
      throw new Error("exports.snapshot.json tidak ditemukan")
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Record<string, string[]>
    for (const file of FILES) {
      const src = readFileSync(join(ROOT, file), "utf8")
      const actual = extractExports(src)
      const expected = snapshot[file] ?? []
      const missing = expected.filter((name) => !actual.includes(name))
      if (missing.length > 0) {
        throw new Error(`Export yang hilang: ${missing.join(", ")}`)
      }
    }
  })
})
