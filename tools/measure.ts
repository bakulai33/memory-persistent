/**
 * Alat ukur efektivitas memory-persistent (READ-ONLY).
 *
 * CLI tipis: menerima direktori sessions sebagai argumen, mencetak laporan
 * JSON dari `buildMeasureReport`. Tidak ada akses DB dan tidak ada angka
 * rekaan — laporan hanya berisi apa yang benar-benar terbaca dari berkas.
 *
 * Pemakaian: bun run tools/measure.ts <sessions-dir>
 */
import { buildMeasureReport } from "../src/measure-core.ts"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: bun run tools/measure.ts <sessions-dir>")
  process.exit(1)
}

console.log(JSON.stringify(buildMeasureReport(dir), null, 2))
