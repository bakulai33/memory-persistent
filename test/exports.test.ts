import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { BUILD } from "../src/build"

const ROOT = join(import.meta.dir, "..")
const FILES = ["src/index.ts", "src/build.ts"]
const SNAPSHOT_PATH = join(import.meta.dir, "exports.snapshot.json")

function extractExports(src: string): string[] {
  const names: string[] = []
  const re = /export\s+default\b|export\s+(?:(?:async\s+)?function|const|interface|type)\s+(\w+)|export\s*\{([^}]+)\}/g
  for (const m of src.matchAll(re)) {
    if (m[0].startsWith("export default")) {
      names.push("default")
    } else if (m[1]) {
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

function missingExports(actual: string[], expected: string[]): string[] {
  return expected.filter((name) => !actual.includes(name))
}

describe("export contract", () => {
  test("public exports match snapshot", () => {
    if (!existsSync(SNAPSHOT_PATH)) {
      throw new Error("exports.snapshot.json tidak ditemukan")
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Record<string, string[]>
    for (const file of FILES) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, file)) {
        throw new Error(`exports.snapshot.json: key "${file}" tidak ditemukan`)
      }
      const expected = snapshot[file]
      if (!Array.isArray(expected)) {
        throw new Error(`exports.snapshot.json: "${file}" must be an array`)
      }
      const src = readFileSync(join(ROOT, file), "utf8")
      const actual = extractExports(src)
      const missing = missingExports(actual, expected)
      if (missing.length > 0) {
        throw new Error(`Export yang hilang: ${missing.join(", ")}`)
      }
      const extra = actual.filter((name) => !expected.includes(name))
      if (extra.length > 0) {
        throw new Error(`Export tak terduga: ${extra.join(", ")}`)
      }
    }
  })

  test("BUILD matches package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
    expect(BUILD).toBe(pkg.version)
  })

  test("reports missing public exports", () => {
    const actual1 = extractExports('export const BUILD = "0.4.0"\n')
    expect(missingExports(actual1, ["BUILD", "SCHEMA_VERSION"])).toEqual(["SCHEMA_VERSION"])

    const actual2 = extractExports('export const BUILD = "0.4.0"\nexport const SCHEMA_VERSION = 3\n')
    expect(missingExports(actual2, ["default", "BUILD", "SCHEMA_VERSION"])).toEqual(["default"])
  })
})
