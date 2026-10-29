# HANDOFF — pindah proyek ke laptop lain

> Panduan pindah + setup + prompt pembuka untuk sesi Cline/GLM baru.
> Baca juga **`PROJECT_CONTEXT.md`** (state pekerjaan) dan **`.clinerules`** (konvensi kode).
> Untuk instalasi ke server produksi (VPS Ubuntu: nginx, systemd, HTTPS), pakai **`DEPLOY-VPS.md`**.

---

## 1. Yang disalin (dan yang tidak)

Ukuran terukur **2026-10-24** (dari folder kerja sekarang, `D:\Cline\Pay`): **source cuma ±1.54 MB / 116 file**, tapi `node_modules` **±1.28 GB** (76 ribu file) dan `.next` **±522 MB** — dua folder itu **jangan** ikut disalin, nanti di-install ulang di laptop.

Jalankan di PowerShell (ganti drive tujuan sesuai PC baru):

```powershell
robocopy "D:\Cline\Pay" "D:\Projects\Pay" /E /XD node_modules .next /XF *.tsbuildinfo
```

Hasil ukur per 24 Okt 2026: **116 file / ±1.54 MB** (tanpa `node_modules`, tanpa `.next`, tanpa `tsbuildinfo`). Robocopy keluar dengan kode **1** kalau ada file yang disalin — itu normal, bukan error (0 = tidak ada perubahan, ≥8 = gagal).

**Kalau folder tujuan sudah ada isinya**, `/E` **tidak** menghapus file lama (misalnya `PROJECT_CONTEXT.md` versi lama, `dev.log`, `rounds_resp.json`, `.v3backup/`), jadi pakai `/MIR` supaya tujuan persis sama dengan sumber:

```powershell
robocopy "D:\Cline\Pay" "D:\Projects\Pay" /MIR /XD node_modules .next /XF *.tsbuildinfo
```

Setelah sync, cek ukurannya — `PROJECT_CONTEXT.md` harus **±192 KB** (196.590 byte; versi lama 87 KB, itu tanda state-nya ketinggalan):
```powershell
Get-ChildItem D:\Projects\Pay\PROJECT_CONTEXT.md, D:\Projects\Pay\HANDOFF.md | Select-Object Name,Length,LastWriteTime
```

Yang **wajib** ikut (semua ada di root, sudah tercakup perintah di atas):

| Item | Kenapa penting |
|---|---|
| `src/` | seluruh app, lib, scripts |
| `prisma/schema.prisma` | definisi DB (tidak ada folder `migrations/`) |
| `public/` | aset (logo, dll) |
| `package.json` + `package-lock.json` | versi dependency terkunci → pakai `npm ci` |
| `tsconfig.json`, `postcss.config.mjs`, `next.config.mjs` | build config (webpack + Buffer polyfill!) |
| `.clinerules` | aturan proyek yang auto-load di Cline |
| `PROJECT_CONTEXT.md` | memori/handoff state — **wajib**, ini yang dibaca Cline pertama |
| `.env` | semua kredensial (lihat peringatan keamanan di §8) |
| `data/buyback.json` | ledger buyback & burn — **sumber kebenaran** `/treasury` (bukan tabel DB; kalau hilang, halaman itu balik ke tanda "—") |
| `HANDOFF.md` | file ini |

Boleh dibuang: `.next`, `node_modules`, `tsconfig.tsbuildinfo`, `*.log`, `.build.*`, `.install.*`, `.npm.*`, `dev.log`, `rounds_resp.json`, `.v3backup/` (backup lama migrasi v3).

> Catatan: proyek ini **belum pakai git** (`git` tidak terinstall di mesin ini). Setelah sampai di laptop, pertimbangkan `git init` + commit pertama supaya perubahan copy bisa di-diff/rollback.

---

## 2. Prasyarat di laptop

- **Node.js ≥ 20.9** (Next 16 menolak versi lebih lama). Di mesin ini jalan di **Node 24.19 / npm 11.17**; Node 22 LTS juga aman. Cek: `node -v`.
- **npm** (lock file v3, npm 10+).
- **Tidak perlu** PostgreSQL lokal — DB-nya **Neon** (cloud), tinggal pakai `DATABASE_URL` yang sama.
- Internet (RPC Helius + drand butuh jaringan).
- Phantom extension hanya kalau mau mengetes tombol connect wallet.

---

## 3. Langkah setup (urutannya penting)

```powershell
cd D:\Projects\Pay
npm ci                      # install persis sesuai package-lock.json
npm run db:generate         # generate Prisma client (WAJIB, kalau tidak: "@prisma/client did not initialize yet")
npx tsc --noEmit            # baseline harus 0 error
npm run dev                 # → http://localhost:3000
```

**Jangan** jalankan `npm run db:push` / `db:migrate` kalau tetap memakai database Neon yang sekarang — itu DB berisi data asli (rounds, holders). `db:push` hanya untuk DB baru/kosong.

Kalau memakai **DB Neon baru** (proyek kosong, mis. untuk VPS/lingkungan terpisah), urutannya:
buat proyek di dashboard Neon → isi `.env` dengan string **pooled** (`-pooler`) + `?sslmode=require`
→ dorong skema **sekali** dengan string **direct** (tanpa `-pooler`), karena DDL lewat pooler bisa
menggantung → isi holder dengan `npm run holders:sync`. Detail lengkap + perintah verifikasi 8 tabel
ada di **`DEPLOY-VPS.md` §6.1 jalur B**.

Kalau `.env` tidak ikut tersalin, buat baru di root. Yang **wajib** (kalau kosong, `getConfig()` langsung throw `Missing required env var: ...`):

| Key | Isi |
|---|---|
| `SOLANA_RPC_URL` | RPC server (Helius mainnet) |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | RPC untuk browser (wallet connect) |
| `TOKEN_MINT` | mint PAY |
| `PLATFORM_WALLET_SECRET` | secret key wallet platform (JSON array **atau** base58) |
| `DATABASE_URL` | connection string Neon **pooled** (`-pooler`, pakai `?sslmode=require`) |
| `ADMIN_PASSWORD` | login `/admin` |
| `ADMIN_SESSION_SECRET` | secret cookie admin |

Yang punya default (boleh tidak diisi): `SOLANA_NETWORK` (`mainnet`), `TOKEN_DECIMALS` (`6`), `LOTTERY_CRON` (`0 * * * *`), `HOLDER_SYNC_CRON` (`*/5 * * * *`), `MIN_TOKEN_ELIGIBLE`, `PRIZE_RESERVE_LAMPORTS` (default 0.05 SOL), `WINNER_COUNT` (`3`), `PAYOUT_DISTRIBUTION` (`0.5,0.3,0.2`, harus berjumlah 1.0), `LOTTERY_CRON_ENABLED`, `PLATFORM_TREASURY_SECRET` (opsional), `ADMIN_USERNAME` (`admin`), `TOKEN_NAME` (ticker tampilan, default `PAY`, case apa adanya — `DrawFi` tetap `DrawFi`; nilai di database menang atas env), `TELEGRAM_BOT_TOKEN` (opsional — token bot grup; bisa juga diisi dari `/admin` → Telegram Bot, nilai DB menang).

Nilai yang sekarang dipakai: **network mainnet**, `WINNER_COUNT=3`, `PAYOUT_DISTRIBUTION=0.5,0.3,0.2`, `LOTTERY_CRON_ENABLED=false`.

---

## 4. Peringatan: jangan "kebetulan" menjalankan draw asli

Ini **mainnet** dan `.env` berisi key wallet yang bisa mengirim SOL.

- `LOTTERY_CRON_ENABLED=false` → scheduler **tidak** mendaftarkan cron draw (hanya aktif kalau `true` atau `NODE_ENV=production`). Aman.
- Tapi **holder sync tetap jalan tiap 5 menit** (`HOLDER_SYNC_CRON`) selama dev server hidup: memanggil Helius + menulis snapshot ke Neon. Kalau tidak mau, sementara ubah ke `0 0 1 1 *` (sekali setahun) atau matikan dev server kalau tidak dipakai.
- **Jangan** jalankan `npm run lottery:run`, `npm run airdrop`, `npm run holders:sync` tanpa sadar — yang pertama benar-benar membuat round baru + mengirim SOL ke pemenang.
- Untuk eksperimen aman: buat `.env.local` terpisah dengan `SOLANA_NETWORK=devnet` + `TOKEN_MINT` devnet hasil `npm run setup:devnet`.

---

## 5. Cek cepat "setup-nya benar" (±5 menit)

Dengan `npm run dev` hidup, jalankan:

```powershell
foreach ($r in @('/','/draws','/eligibility','/stats','/verify','/how-it-works','/rounds/21','/admin')) {
  try { $x = Invoke-WebRequest -UseBasicParsing "http://localhost:3000$r" -TimeoutSec 60; "$r -> $($x.StatusCode)" }
  catch { "$r -> $($_.Exception.Response.StatusCode.value__)" }
}
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/status | Select-Object -ExpandProperty Content
```

Harapan: semua **200**, `/api/status` mengembalikan JSON (pool saat ini **0 SOL**, semua draw lama berstatus `skipped` — itu normal, bukan bug). Di terminal dev server tidak ada `Missing required env var` atau `@prisma/client did not initialize yet`. Opsional: `npm run build` harus sukses (butuh 1–2 menit).

Angka acuan saat handoff (23 Okt 2026, dibaca langsung dari Neon): `lastRound.roundNumber = 46` (status `skipped`, `eligibleCount = 2`), `holders = 509`, snapshot terakhir `2026-10-23T09:35Z`. Kalau di laptop angkanya sama → DB Neon + RPC sudah nyambung. Pool saat ini **0 SOL** dan draw terakhir `skipped` — itu normal, bukan bug (prize wallet belum diisi).

Kalau `/api/status` 500 → biasanya `DATABASE_URL` salah/Neon suspended, atau Prisma client belum di-generate.

---

## 6. Prompt pembuka untuk sesi Cline di laptop

Buka folder `D:\Projects\Pay` di Cline, model GLM, lalu tempel:

```
Baca PROJECT_CONTEXT.md, .clinerules, dan HANDOFF.md dulu, jangan edit apa pun sebelum itu.

State terakhir (25 Okt 2026): tile strip di landing page `/` sudah selesai dirapikan —
urutan sekarang **Prize pool → Prize split → Next draw**, caption payout tiap rank naik ke
`text-xs` tanpa mono (Geist Sans, `tabular-nums`), bar memakai `ProgressBar size="lg"` (12px)
dalam row `h-10` (40px), dan chip header `≈ X SOL` kini pakai body font + **Tooltip HeroUI**
("net of the platform fee") menggantikan `title` native. Lolos `npx tsc --noEmit` 0 error,
`GET /` 200, audit CDP 1440/390: tile **253px** desktop / **236px** mobile, tanpa overflow.
Catatan: `npm run lint` rusak repo-wide (Next 16 menghapus `next lint`) — bukan dari perubahan ini.
Detail lengkap + angka ukur ada di `PROJECT_CONTEXT.md` → `### ✅ Done` (entri paling atas) dan
`## Notes for the AI resuming this` (dua catatan baru soal `Tooltip.Trigger` + focus emulation).

Sebelumnya (24 Okt 2026): kartu **Creator Fees** di `/admin` → App Info dirombak —
strip 4 biaya (claim fee / min wallet balance / net if claimed / signing wallet), baris payout +
signer, dan `Claim history` sekarang **tabel** (When · Amount · Source · Status · Note · Tx,
8 baris terakhir, pesan error di-clamp 2 baris, tabel scroll sendiri di layar sempit).
Lolos `npx tsc --noEmit` 0 error, `npx eslint` 0 masalah, `npm run build` ✓ 12.7s (12/12 halaman),
dan sudah diaudit di headless Chrome terhadap build produksi: 6 baris, `/admin` bersih di 1280px
maupun 420px. Tidak ada pekerjaan yang menggantung.

Urutan kerja:
1. `npm ci` → `npm run db:generate` → `npx tsc --noEmit` (harus 0) → `npm run dev` → login `/admin`
   dan pastikan kartu Creator Fees tampil sebagai tabel, bukan blok flex lama.
2. Kalau dev kelihatan aneh (halaman reload sendiri, `Manifest file is empty`), itu cache `.next`:
   stop `npm run dev`, hapus `.next`, nyalakan lagi. Jangan jalankan `npm run build` saat dev hidup.
3. Backlog berikutnya, minta datanya dulu ke saya: URL asli X + grup Telegram untuk
   `src/components/nav.ts` (sekarang placeholder), lalu isi `data/buyback.json` (sumber kebenaran
   /treasury, bukan tabel DB).

Alur tiap edit: tunjukkan tabel location | current | problem | proposal → saya setuju →
edit → `npx tsc --noEmit` (harus 0) → probe route → bullet changelog di PROJECT_CONTEXT.md.
Jangan pernah menjalankan `npm run lottery:run` / `airdrop` / `holders:sync` tanpa saya minta.
```


Kalau mau langsung lanjut tanpa review, hilangkan baris "tunggu saya setuju".

---

## 7. Jebakan yang sudah ketemu di proyek ini (biar tidak diulang)

1. **`Set-Content` merusak file ber-BOM.** `SeedToWinner.tsx` pernah jadi double-encoded. Pakai editor tool, atau:
   `[System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($false))`.
2. **Copy yang dirender client tidak terlihat di HTML SSR.** `Invoke-WebRequest` tidak akan menemukan string dari `SeedToWinner`, chart `/stats`, atau `DrawsList`. Cek di `.next/dev/static/chunks/*.js` (grep nama string).
3. **Token Tailwind yang mati**: `text-default-400`, `border-default-200`, `bg-default-100`, `bg-default-50/60`, `text-primary` compile ke **nol** (tidak ada `--color-default-*` / `--color-primary` di tema). Pakai `text-muted`, `text-foreground`, `border-(--border)`, `bg-default`, `bg-default/40`, `text-accent`, `bg-danger/10`, `border-danger/30`.
4. **Next 16 harus `--webpack`, jangan Turbopack.** Script sudah `next dev --webpack`; `@solana/web3.js` butuh Buffer polyfill + fallback `fs/net/tls` di `next.config.mjs`.
5. **Prisma wajib ada di `serverExternalPackages`** (sudah). Kalau muncul error "did not initialize yet" → `npm run db:generate`.
6. **Jangan cetak enum DB mentah ke UI** (`completed`/`skipped`/`failed`, `pending`/`sent`) — selalu lewat map label.
7. **PowerShell memperlakukan `[roundNumber]` sebagai wildcard** di `Select-String -Path` / `Get-Content`. Pakai `-LiteralPath`.
8. **drand butuh internet** dan memakai cross-relay; tes dengan `npm run drand:test`.
9. **Jangan ubah teks yang sudah disetujui** di halaman 1–6 tanpa alasan kuat; changelog-nya ada di `PROJECT_CONTEXT.md`.

---

## 8. Keamanan `.env`

Isinya: `PLATFORM_WALLET_SECRET` + `PLATFORM_TREASURY_SECRET` (key wallet yang bisa memindahkan SOL), `DATABASE_URL` Neon, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`.

- Jangan simpan salinan di folder yang tersinkron cloud (OneDrive/Google Drive) atau repo publik. Kalau lewat USB, hapus setelah selesai.
- `.gitignore` sudah mengecualikan `.env` — tapi kalau `git init`, cek ulang sebelum `git add .`.
- Kalau ragu jalur transfernya: pindahkan file lain dulu, lalu **ketik ulang** `.env` di laptop, dan ganti `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` baru.
- Jangan pernah paste isi `.env` ke chat/AI (termasuk saya). Cukup sebut nama key-nya.

---

## 9. Sisa pekerjaan setelah pindah

Urutan yang saya sarankan (paling murah dulu):

1. ~~**`npm run build` sekali**~~ ✅ **sudah jalan 23 Okt 2026**: `next build --webpack` → ✓ compiled dalam **5.7s**, **12/12** halaman statis, tanpa error. Sebelum deploy, jalankan ulang dengan `npm run dev` **dimatikan** (dua-duanya menulis `.next/`). Satu-satunya warning yang tersisa: Next mengira workspace root = `C:\Users\gosdo\Desktop\AI` karena ada `package-lock.json` nyasar di folder induk — di laptop warning ini hilang sendiri selama folder induk bersih. **Update 24 Okt 2026:** build dijalankan lagi setelah kartu Creator Fees dirombak → ✓ **12.7s**, tanpa error, 12/12 halaman. Jangan pernah jalankan build (atau hapus `.next`) bersamaan `npm run dev` — cache dev jadi rusak (`Manifest file is empty`, halaman reload sendiri tiap beberapa detik); obatnya cuma restart dev.
2. **`git init` + commit awal** — di mesin lama `git` tidak terinstall, jadi proyek ini belum punya riwayat sama sekali. `.gitignore` sudah siap (`.env`, `node_modules`, `.next`, `*.tsbuildinfo` aman).
3. **URL asli** X handle + grup Telegram di `src/components/nav.ts` (sekarang placeholder) — butuh datanya dari kamu.
4. **`data/buyback.json`** — isi `txs`, `supply`, `nextRunAt` lewat Admin → Buyback, atau edit file langsung lalu commit.
5. **Prize wallet belum diisi** → semua draw terakhir `skipped` (pool 0 SOL, jadi tidak ada pemenang). Kalau mau cron draw benar-benar jalan: kirim SOL ke prize wallet, lalu set `LOTTERY_CRON_ENABLED=true` (sekarang `false` — sengaja, biar dev server tidak pernah kirim SOL sungguhan).
6. ~~`/rounds/[n]` halaman 7 dari 8~~ ✅ · ~~`/admin` halaman 8~~ ✅ (versi ringkas: token, label status, `round` → `draw`).
7. Opsional/deferred: fee platform di card publik `/draws` (`DrawsList.tsx`) — datanya sudah ada di DB + `/api/rounds`, kamu putuskan tetap admin-only sampai sekarang.


