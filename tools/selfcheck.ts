/**
 * Preflight CLI: verifies the plugin's full local import graph can link
 * (every named import resolves to a real export, `export *` included).
 *
 * Pemakaian: bun run tools/selfcheck.ts [src-dir]
 * Tanpa argumen: memeriksa ../src relatif terhadap file ini.
 *
 * Exit 0 = graph konsisten; exit 1 = ada mismatch (dicetak ke stdout/stderr).
 */
import { resolve } from "node:path"
import { checkSourceGraph, hardcodedHomePaths } from "../src/selfcheck.ts"

const dir = resolve(process.argv[2] ?? new URL("../src", import.meta.url).pathname)
const mismatches = checkSourceGraph(dir)

if (mismatches.length > 0) {
  for (const mismatch of mismatches) {
    console.error(
      `[memory-persistent] ${mismatch.importer}: ${mismatch.from} does not export ${mismatch.missing.join(", ")}`,
    )
  }
  console.error(`[memory-persistent] source graph BROKEN: ${mismatches.length} mismatch(es) in ${dir}`)
  process.exit(1)
}

// A hardcoded /home/<user>/ path leaks the maintainer's environment into a
// published package: the preflight refuses to pass while one is present.
const offenders = hardcodedHomePaths(dir)
if (offenders.length > 0) {
  for (const name of offenders) {
    console.error(`[memory-persistent] ${name}: hardcoded /home/<user>/ path`)
  }
  console.error(`[memory-persistent] hardcoded home path(s) found in ${dir}`)
  process.exit(1)
}

console.log(`[memory-persistent] source graph ok (${dir})`)
