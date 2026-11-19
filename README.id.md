[English](README.md) | Bahasa Indonesia

# memory-persistent

Memori persisten per sesi untuk OpenCode V2 — plugin + skill yang membuat model bisa
mengingat apa yang sudah terjadi di sesi berjalan, dan memori itu **tidak pernah bocor
ke sesi lain**.

## Fitur

- **Hybrid** — konsolidasi otomatis sesi + catatan manual.
- **Per-sesi** — file memori disimpan per `sessionID`; tidak ada akses lintas sesi.
- **Persistent** — memori bertahan setelah restart server.
- **Auto-cleanup** — file memori dihapus otomatis saat sesinya dihapus.

## Prasyarat

- OpenCode V2
- [Bun](https://bun.sh) (OpenCode memuat source plugin TypeScript secara langsung)
- `effect` 4.x sebagai peer dependency (disediakan host OpenCode)

## Instalasi

### Dari registry npm

```bash
opencode plugin add opencode-memory-persistent@0.6.1
```

Lalu daftarkan di `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-memory-persistent@0.6.1"]
}
```

atau dengan opsi plugin:

```json
{
  "plugins": [
    { "package": "opencode-memory-persistent@0.6.1", "options": { "tokenBudget": 5000 } }
  ]
}
```

Pin versi eksaknya.

### Dari direktori lokal

```json
{
  "plugins": ["/path/ke/memory-persistent"]
}
```

Direktori lokal dimuat melalui map `exports` paket; tidak perlu build step.

## Konfigurasi

| Opsi | Default | Arti |
|---|---|---|
| `tokenBudget` | `5000` | Batas token memori yang diinjeksikan ke konteks |
| `sweepEnabled` | `true` | Aktifkan sweep file memori yatim |
| `sweepIntervalMs` | `21600000` (6 jam) | Jarak antar sweep periodik |
| `consolidationMode` | `stateless` | Mode panggilan konsolidasi: `stateless` (prompt dibangun dari delta saja; riwayat sesi tidak dikirim) atau `session` (riwayat sesi disertakan) |

## Lifecycle

| Kejadian | Yang terjadi |
|---|---|
| Prompt penting | Ditandai sebagai pending turn (heuristik, tanpa model); policy capture menentukan apakah disimpan |
| Tool yang mengubah state | Dicatat sebagai activity: file yang diubah, command bermakna, atau error |
| Setiap request | Memori diinjeksikan sebagai system part (maks `tokenBudget` token, default 5000) |
| Sesi idle | Percakapan + activity dikonsolidasi: state `idle` → `running` → `idle` (sukses) atau `failed` |
| Konsolidasi berjalan > 5 menit tanpa selesai | Attempt dianggap mati, di-recover menjadi `failed` (`consecutiveFailures++`), lalu di-retry setelah backoff |
| Konsolidasi gagal | State `failed`, error dicatat (di-redaksi), retry pada idle berikutnya setelah backoff 1→2→4→8→10 menit; batch naratif dilengkapi (turn pending tidak hilang) |
| Konsolidasi sukses | State `idle`, `consecutiveFailures` = 0, `needsConsolidation` false bila tidak ada pending |
| Sesi idle dengan background work aktif | Konsolidasi ditunda (defer) hingga 3 kali / 15 menit; ringkasan dapat bersifat parsial |
| Sesi dibuat (child) | Mewarisi snapshot memori parent |
| Sesi di-fork | Mewarisi snapshot memori sumber |
| Sesi dihapus | File memori (dan backup corrupt) dihapus |
| Startup / periodik | Sweep menghapus file memori yatim |

Activity yang dicatat sengaja sempit: hanya file yang ditulis atau diubah, command yang
memang mengubah state (`git`, `bun`, `npm`, `docker`, `pytest`, …), dan setiap error.
Navigasi dan pembacaan (`cd`, `ls`, `grep`, `cat`) tidak disimpan karena hanya
mengaburkan percakapan.

## Anti-leak

- `sessionID` selalu divalidasi (`[A-Za-z0-9_-]{1,128}`); path traversal ditolak.
- Tool hanya bekerja pada sesi dari konteks eksekusi — `sessionID` tidak pernah diterima
  dari argumen.
- Tidak ada tool untuk melihat sesi lain.
- Child/fork hanya mewarisi snapshot saat pembuatan, lalu divergen; tidak ada
  sinkronisasi balik.
- Isi memori hanya ringkasan dan catatan; output mentah tool tidak disimpan.

## Capture policy

- `always`: prompt yang membawa keputusan, error, perintah kerja, referensi file/path,
  atau prompt panjang.
- `likely`: prompt lain yang bukan chatter.
- `noise`: sapaan/pengakuan singkat (`hi`, `ok`, `thanks`, …) dan prompt sangat
  pendek — **tidak disimpan**.
- Niat durable disimpan; chatter dibuang.

## Tool

| Tool | Fungsi |
|---|---|
| `memory_store` | Simpan catatan ringkas untuk sesi ini |
| `memory_recall` | Panggil memori sesi ini (opsional `query`) |
| `memory_list` | Daftar catatan sesi ini |
| `memory_forget` | Hapus catatan berdasarkan `id` |
| `memory_health` | Status konsolidasi sesi ini |

## Schema

- **Versi skema:** `4` (schema v4 dengan pemisahan facts warisan)
- **Build catatan:** `build.json` mencatat `build: "0.6.1"` dan hash source; drift
  dilaporkan via `memory_health`
- **Label "unverified":** narasi model ditandai sebagai
  "Notes (model-generated, unverified):" — tidak pernah dijadikan sumber fakta

## Facts vs Inherited Facts

- `summaryFacts`: fakta deterministik sesi ini (file, command, error yang plugin catat
  sendiri)
- `summaryFactsInherited`: baris fakta warisan dari sesi parent, disimpan **mentah** di
  file (diisi saat child/fork dibuat); label `"Inherited from parent session:"`
  ditambahkan saat **injeksi**, bukan tersimpan di file
- Saat injeksi memori, fakta ditempatkan sebelum narasi model; fakta tetap ditulis
  meskipun narasi gagal

## Capture Marker Split (EN / ID / Prefix)

Policy menangkap pakai tiga kelas marker (urutan prioritas):

1. **EN word** (`\\bword\\b`) — kata Inggris utuh, menghindari FP seperti "shoulders"
   dari "should"
2. **Prefix** (tanpa batas kanan `\b`) — contoh: "analyz", "lanjut", "praq", "raq"
3. **ID substring** — imbuhan Indonesia (di-, me-, ke-, -nya); cocok sebagai substring
   dalam kata ("disetujui", "perbaiki", dll.)

Lainnya: panjang > 120 **karakter** → `always`; greetings → `noise`; pendek < 15
**karakter** → `noise`.

## Validasi Input (`validateStoreInput`)

- Menolak teks kosong setelah trim (`Rejected: text is empty`)
- Menolak teks lebih dari 8192 karakter (`Rejected: text too long (max 8 KB)`)
- Menolak jika `tags` bukan array
- Menolak lebih dari 16 tag
- Setiap tag harus string maks 64 karakter tanpa kontrol karakter (0x00–0x1F)
  (`Rejected: invalid tag`)

## Skill Path Derivation (tidak di-hardcode)

- Path dinamis: `resolveSkillPath()` menggunakan `import.meta.url` dan `dirname()`
  untuk menemukan `skills/memory-persistent/SKILL.md`
- Tidak di-hardcode sebagai `/home/<user>/...` ⇒ plugin bisa dipasang di mana saja

## Skill

`@memory-persistent` — memuat kapan harus store/recall, kapan memanggil
`memory_health`, dan larangan menyimpan output mentah atau secret.

## Catatan operasional

- **Restart server jika reload source plugin gagal.** Loader plugin lokal hot-reload
  perubahan source yang konsisten, tetapi evaluasi yang gagal — mis. import nama yang
  tidak diekspor target — di-cache dan meracuni setiap reload berikutnya dalam proses
  yang sama; plugin tetap menjalankan build sebelumnya sampai server di-restart, dan
  self-check startup melaporkan source tree rusak (`source-tree-inconsistent`).
- Saat aktivasi, plugin memeriksa konsistensi graph import. Jika ada mismatch,
  aktivasi dibatalkan dengan log `source-tree-inconsistent` (FATAL) dan plugin tidak
  terdaftar. Perbaiki nama export/import lalu restart server.
- Konsolidasi menggunakan **panggilan model stateless** (default): hanya prompt yang
  dibangun dari delta (facts + conversation + notes + activity) yang dikirim; riwayat
  sesi tidak disertakan. Memori menyimpan facts deterministik plus naratif model
  opsional; facts tetap ditulis meskipun naratif gagal.
- Build record (`build.json`) mencatat source hash; drift antar aktivasi dilaporkan
  lewat `memory_health` dan log.

## Limitasi yang diterima

Ketimbang-trade-off berikut disengaja dan didokumentasikan agar membaca source tidak
mengejutkan Anda:

- **Tidak ada `fsync` pada penulisan memori.** Penulisan atomik (file `tmp` + rename)
  tetapi tidak di-flush: saat mati daya total, tulisan terbaru bisa hilang atau
  tersisa `.tmp.` usang (dibersihkan sweep dan perbaikan permission). Diterima:
  data ini alat bantu sesi, bukan buku besar.
- **Lock bersifat per-proses.** Lock sesi hanya menyerialisasi penulisan dalam satu
  proses OpenCode. Dua proses server pada direktori data yang sama bisa berlomba;
  rename atomik dan pemeriksaan `sessionID` di dalam file menjaga file agar tidak
  rusak, tetapi last-writer-wins mungkin terjadi. Diterima: pada setup yang
  didukung, satu server pemilik direktori data.
- **`sourceHash` hanya mencakup `src/*.ts`.** Hash pada build record mendeteksi
  drift source modul plugin sendiri, bukan file skill atau perubahan host; ini
  diagnostik, bukan jaminan.
- **Penulisan log sinkron tetapi tanpa fsync.** `plugin.log` di-append sinkron per
  event; crash bisa menghilangkan baris terakhir. Log adalah jejak diagnostik,
  bukan audit log. Benchmark manual jalur steady-state (`tools/log-bench.ts`,
  500–1000 event) mengukur p95 ≈ 0,05–0,5 ms per event — jauh di dalam anggaran
  5 ms yang baru akan memaksa antrean async — jadi penulisan sinkron dipertahankan.
- **Notes manual dibatasi 200 per sesi.** Note paling lama dievakuasi saat batas
  terlampaui (juga diterapkan saat membaca file legacy yang melampauinya).
- **Payload tool dibatasi.** `memory_recall` / `memory_list` mengembalikan preview
  maksimal 500 karakter per note dan payload JSON dibatasi 32 KiB, dengan flag
  `truncated` saat ada yang dipotong.
- **Selfcheck memverifikasi graph import entry, bukan tipe.** Ia membuktikan
  setiap named import menunjuk export nyata; tidak melakukan type-check (jalankan
  `tsc` untuk itu) dan tidak memverifikasi perilaku runtime.
- **Konsolidasi berjalan di background.** Hook `experimental.idle` langsung kembali;
  konsolidasi berjalan sebagai fiber ber-scope plugin, satu per sesi. Menghapus
  sesi memutus fiber konsolidasinya dan membebaskan slot; panggilan model lambat
  dilindungi dari recovery stale selama fiber-nya masih hidup (TTL registrasi:
  30 menit).

## Penyimpanan & privasi

- Memori tersimpan lokal di bawah
  `${XDG_DATA_HOME:-~/.local/share}/opencode/memory-persistent/`:
  - `sessions/<sessionID>.json` — satu file per sesi
  - `plugin.log` — baris terstruktur `[memory-persistent] ...` yang tidak ditangkap
    server; dibatasi 64 KiB (tail terbaru dipertahankan); path-nya juga dilaporkan
    oleh `memory_health` (`logPath`)
- Permission: `0600` untuk file, `0700` untuk direktori, diperbaiki otomatis saat
  aktivasi (`repairPermissions`). File corrupt dipindah jadi
  `.json.corrupt.<timestamp>`.
- File berupa **JSON plaintext — tidak ada enkripsi at-rest**. Andalkan keamanan
  user/disk biasa Anda.
- **Satu-satunya trafik jaringan** adalah panggilan model konsolidasi saat sesi idle:
  mengirim prompt yang dibangun dari delta (facts, conversation, notes, activity) ke
  provider model yang sudah dipakai OpenCode untuk chat Anda. Tidak ada endpoint lain.
- Secret di-redaksi **sebelum apa pun ditulis ke disk** — heuristik best-effort, bukan
  jaminan.
- **Tanpa telemetry.** Tidak ada yang dikirim ke pembuat plugin atau layanan analitik
  mana pun.

## Measure

`tools/measure.ts` adalah CLI **read-only** untuk melaporkan efektivitas tool: ia hanya
membaca file memori dan mencetak JSON laporan — tidak ada angka yang direkayasa;
laporan hanya memuat apa yang benar-benar dibaca dari file.

```bash
bun run tools/measure.ts <sessions-dir>
```

Kolom utama laporan (`MeasureReport`):

| Kolom | Arti |
|---|---|
| `totalFiles` | Jumlah file memori yang dibaca |
| `schemaVersions` | Distribusi versi skema (per field `version`, fallback `schema`) |
| `builds` | Distribusi build yang menulis file |
| `driftCount` | File yang terakhir ditulis oleh build selain build yang berjalan |
| `facts.sessions` | File yang memuat ≥ 1 baris fakta |
| `facts.ownLines` | Jumlah baris fakta milik sesi sendiri |
| `facts.inheritedLines` | Jumlah baris fakta warisan dari parent |
| `facts.genericPct` | Persentase baris fakta berbentuk `- <kind>: <target>` dengan kind yang dikenal |
| `facts.dupLines` | Kemunculan ekstra baris fakta yang terduplikasi |

Laporan juga membawa grup `pending` (hitungan pending turn dan activity), grup `notes`
(own vs inherited note lines), dan grup `hygiene` (masalah permission, backup corrupt,
file tmp stale).

## Pengembangan

```bash
bun install
bun test
bun run check        # bun test && bunx tsc --noEmit
bun run fixtures     # regenerasi fixture tool-call (butuh direktori test/ — tidak dikirim ke npm; hanya untuk kerja dari source)
bun run measure      # laporan efektivitas read-only
```

## Limitations

- Redaksi secret bersifat **best-effort** (heuristik, bukan jaminan).
- Kutipan turn parent tidak diwarisi dalam snapshot child/fork (hanya ringkasan +
  notes).
- Label depth baris fakta warisan default `"parent"` (depth 1); untuk depth > 1
  dirender `Inherited from N earlier sessions:` — depth tersimpan per blok warisan
  (satu angka), bukan per baris.
- Rantai inherited tumbuh di file; cap dilakukan saat injeksi (budget token).
- File sesi yang sudah dihapus dapat muncul kembali maksimal 1 sweep bila
  tombstone-nya ter-evict dari cap 256.
- Retry konsolidasi dijadwalkan pada **idle event berikutnya** setelah backoff
  (1→2→4→8→10 menit); tidak ada timer mandiri.

## License

[MIT](LICENSE) © 2026 bakulai33
