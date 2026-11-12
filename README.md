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
| Prompt penting | Ditandai sebagai pending turn (heuristik, tanpa model) |
| Tool yang mengubah state | Dicatat sebagai activity: file yang diubah, command bermakna, atau error |
| Setiap request | Memori diinjeksikan sebagai system part (maks 5000 token) |
| Sesi idle | Percakapan + activity dikonsolidasi menjadi ringkasan (model sesi) |
| Konsolidasi gagal | Dicatat `lastFailure`, di-log, retry dengan backoff 1→2→4→8→10 menit |
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

## Tool

| Tool | Fungsi |
|---|---|
| `memory_store` | Simpan catatan ringkas untuk sesi ini |
| `memory_recall` | Panggil memori sesi ini (opsional `query`) |
| `memory_list` | Daftar catatan sesi ini |
| `memory_forget` | Hapus catatan berdasarkan `id` |
| `memory_health` | Status konsolidasi sesi ini (jika konsolidasi gagal) |

## Skill

`@memory-persistent` — memuat kapan harus store/recall, kapan memanggil
`memory_health`, dan larangan menyimpan output mentah atau secret.

## Penyimpanan

```
${XDG_DATA_HOME:-~/.local/share}/opencode/memory-persistent/sessions/<sessionID>.json
```

Permission `0600`. Backup file yang gagal diparse berakhir dengan `.json.corrupt.<timestamp>`.

## Pengembangan

```bash
bun install
bun test
bunx tsc --noEmit
```
