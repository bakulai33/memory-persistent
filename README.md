# memory-persistent

Plugin + skill OpenCode V2 untuk **memori persisten per sesi**. Model bisa mengingat
apa yang sudah terjadi di sesi berjalan, dan memori itu **tidak pernah bocor ke sesi lain**.

## Fitur

- **Hybrid**: ringkasan otomatis + catatan manual.
- **Per-sesi**: file disimpan per `sessionID`; tidak ada akses lintas sesi.
- **Persistent**: bertahan setelah restart server.
- **Auto-cleanup**: file memori terhapus otomatis saat sesi dihapus.

## Konfigurasi

Tambahkan di `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    { "package": "/path/ke/memory-persistent" }
  ]
}
```

Opsi plugin:

| Opsi | Default | Arti |
|---|---|---|
| `tokenBudget` | `5000` | Batas token memori yang diinjeksikan ke konteks |
| `sweepEnabled` | `true` | Aktifkan sweep file memori yatim |
| `sweepIntervalMs` | `21600000` (6 jam) | Jarak antar sweep periodik |

## Lifecycle

| Kejadian | Yang terjadi |
|---|---|
| Prompt penting | Ditandai sebagai pending turn (heuristik, tanpa model); policy capture menentukan apakah disimpan |
| Tool yang mengubah state | Dicatat sebagai activity: file yang diubah, command bermakna, atau error |
| Setiap request | Memori diinjeksikan sebagai system part (maks `tokenBudget` token, default 5000) |
| Sesi idle | Percakapan + activity dikonsolidasi: state `idle` → `running` → `idle` (sukses) atau `failed` (gagal) |
| Konsolidasi berjalan > 5 menit tanpa selesai | Attempt dianggap mati, di-recover menjadi `failed` (consecutiveFailures++), lalu di-retry setelah backoff |
| Konsolidasi gagal | State `failed`, error dicatat, retry dengan backoff 1→2→4→8→10 menit |
| Konsolidasi sukses | State `idle`, `consecutiveFailures` = 0, `needsConsolidation` false bila tidak ada pending |
| Sesi idle dengan background work aktif | Konsolidasi ditunda (defer) hingga 3 kali / 15 menit; ringkasan dapat bersifat parsial |
| Sesi dibuat (child) | Mewarisi snapshot memori parent |
| Sesi di-fork | Mewarisi snapshot memori sumber |
| Sesi dihapus | File memori (dan backup corrupt) dihapus |
| Startup / periodik | Sweep menghapus file memori yatim |

Activity yang dicatat sengaja sempit: hanya file yang ditulis atau diubah,
command yang memang mengubah state (`git`, `bun`, `npm`, `docker`, `pytest`, …),
dan setiap error. Navigasi dan pembacaan (`cd`, `ls`, `grep`, `cat`) tidak
disimpan karena hanya mengaburkan percakapan.

## Anti-leak

- `sessionID` selalu divalidasi (`[A-Za-z0-9_-]+`), path traversal ditolak.
- Tool hanya bekerja pada sesi dari konteks eksekusi — `sessionID` tidak pernah diterima dari argumen.
- Tidak ada tool untuk melihat sesi lain.
- Child/fork hanya mewarisi snapshot saat pembuatan, lalu divergen; tidak ada sinkronisasi balik.
- Isi memori hanya ringkasan dan catatan; output mentah tool tidak disimpan.

## Capture policy

- `always`: prompt yang membawa keputusan, error, perintah kerja, referensi file/path, atau prompt panjang.
- `likely`: prompt lain yang bukan chatter.
- `noise`: sapaan/pengakuan singkat (`hi`, `ok`, `thanks`, …) dan prompt sangat pendek — **tidak disimpan**.
- Niat durable disimpan, chatter dibuang.

## Tool

| Tool | Fungsi |
|---|---|
| `memory_store` | Simpan catatan ringkas untuk sesi ini |
| `memory_recall` | Panggil memori sesi ini (opsional `query`) |
| `memory_list` | Daftar catatan sesi ini |
| `memory_forget` | Hapus catatan berdasarkan `id` |
| `memory_health` | Status konsolidasi sesi ini |
| `tools/measure.ts` | Baca-only efektivitas tool; menyediakan laporan build, drift, dan schema versi tanpa memodifikasi memori |

## Schema

- **Versi skema:** `4` (schema v4 dengan pemisahan facts warisan)
- **Build catatan:** `build.json` mencatat `build: "0.5.0"` dan hash source; drift dilaporkan levia `memory_health`
- **Label "unverified":** Narasi model ditandai sebagai "Notes (model-generated, unverified):" — tidak pernah dijadikan sumber fakta

## Facts vs Inherited Facts

- `summaryFacts` : fakta deterministik milisession ini (file, command, error yang plugin catat sendiri)
- `summaryFactsInherited` : fakta warisan dari sesi parent (diisi saat child/fork dibuat; format `"Inherited from parent session:\n<facts>"`)
- Saat injeksi memori, faktanya ditempatkan sebelum narasi model; faktas tetap disimpan meskipun narasi gagal

## Capture Marker Split (EN / ID / Prefix)

Policy menangkap pakai tiga kelas marker (urutan prioritas):

1. **EN word** (`\\bword\\b`) — kata Inggris utuh, menghindari FP seperti "shoulders" dari "should"
2. **Prefix** (tanpa batas kanan `\b`) — contoh: "analyz", "lanjut", "praq", "raq"
3. **ID substring** — imbuhan Indonesia (di-, me-, ke-, -nya); cocok sebagai substring dalam kata ("disetujui", "perbaiki", dll.)

Lainnya: panjang > 120 token → always; greetings → noise; pendek < 15 token → noise.

## Input Validation: `validateStoreInput`

- Menolak teks kosong setelah trim
- Menolak jika `tags` bukan array
- Menolak jika > 16 tag
- Setiap tag harus string, maks 64 karakter, tanpa kontrol karakter (0x1F)
- Error dikembalikan sebagai `null` bila valid, atau pesan rejection string

## Skill Path Derivation (not hard-coded)

- Path dinamis: `resolveSkillPath()` menggunakan `import.meta.url` dan `dirname()` untuk menemukan `skills/memory-persistent/SKILL.md`
- Tidak di-hardcode sebagai `/home/<user>/...` ⇒ plugin bisa dipasang di mana saja

### Anti-leak

- `sessionID` selalu divalidasi (`[A-Za-z0-9_-]+`), path traversal ditolak.
- Tool hanya bekerja pada sesi dari konteks eksekusi — `sessionID` tidak pernah diterima dari argumen.
- Tidak ada tool untuk melihat sesi lain.
- Child/fork hanya mewarisi snapshot saat pembuatan, lalu divergen; tidak ada sinkronisasi balik.
- Isi memori hanya ringkasan dan catatan; output mentah tool tidak disimpan.

## Skill

`@memory-persistent` — memuat kapan harus store/recall, kapan memanggil
`memory_health`, dan larangan menyimpan output mentah atau secret.

## Catatan operasional

- **Restart server jika reload source plugin gagal.** Loader plugin lokal hot-reload perubahan
  source yang konsisten (edit content-only mengevaluasi ulang graph module), tetapi evaluasi
  yang gagal — mis. import nama yang tidak diekspor target — di-cache dan meracuni setiap
  reload berikutnya dalam proses yang sama; plugin tetap menjalankan build sebelumnya sampai
  server di-restart, dan self-check startup melaporkan source tree rusak
  (`source-tree-inconsistent`).
- Saat aktivasi, plugin memeriksa konsistensi graph import (self-check). Jika ada mismatch,
  aktivasi dibatalkan dengan log `source-tree-inconsistent` (FATAL) dan plugin tidak terdaftar.
  Perbaiki nama export/import lalu restart server.
- Konsolidasi menggunakan **panggilan model stateless** (default): hanya prompt yang dibangun
  dari delta (facts + conversation + notes + activity) yang dikirim; riwayat sesi tidak disertakan.
  Memori menyimpan facts deterministik plus naratif model opsional; facts tetap ditulis meskipun
  naratif gagal.
- Build record (`build.json`) mencatat source hash; drift antar aktivasi dilaporkan lewat
  `memory_health` dan log.

## Penyimpanan

```
${XDG_DATA_HOME:-~/.local/share}/opencode/memory-persistent/sessions/<sessionID>.json
${XDG_DATA_HOME:-~/.local/share}/opencode/memory-persistent/plugin.log
```

File log plugin (`plugin.log`) memuat baris terstruktur `[memory-persistent] ...` yang tidak
ditangkap server; dibatasi 64 KiB (tail terbaru dipertahankan). Path-nya juga dilaporkan
oleh `memory_health` (`logPath`).

Permission `0600` untuk file, `0700` untuk direktori. Backup file yang gagal diparse berakhir dengan `.json.corrupt.<timestamp>`. Permission diperbaiki otomatis saat aktivasi (`repairPermissions`).

## Pengembangan

```bash
bun install
bun test
bunx tsc --noEmit
```
