# DEPLOY — install proyek Pay Lottery ke VPS Ubuntu

> Panduan lengkap dari VPS kosong sampai situs jalan di domain dengan HTTPS.
> Baca juga **`HANDOFF.md`** (pindah antar-laptop) dan **`PROJECT_CONTEXT.md`** (state pekerjaan).
> Semua perintah di bawah untuk **bash di Ubuntu 22.04 / 24.04**, dijalankan sebagai user
> dengan `sudo` (bukan langsung root), kecuali ditandai lain.

---

## 0. Gambaran singkat

| Bagian | Keputusan di panduan ini | Kenapa |
|---|---|---|
| Runtime | Node.js **22 LTS** | Next 16 menolak Node < 20.9; 22 LTS paling stabil untuk server |
| Proses | **systemd** `pay.service` (default) — atau **PM2** dengan `ecosystem.config.js` (§8b); pilih salah satu | restart otomatis saat boot/crash, log terpusat, tanpa dependency global (PM2 perlu install global) |
| Web server | **nginx** reverse proxy + **certbot** | TLS gratis; app tetap listen di `127.0.0.1:3000` (tidak terbuka ke internet) |
| Database | **Neon** (cloud) — pakai proyek yang sudah ada, atau bikin baru (§6.1 jalur B) | proyek ini tidak butuh PostgreSQL lokal |
| File state | `data/buyback.json` di dalam folder app | ditulis runtime oleh Admin → Buyback |
| Scheduler | **di dalam proses Next** (`src/instrumentation.ts`) | **wajib satu instance saja** |
| Zona waktu server | **UTC** | `node-cron` memakai TZ server, sedangkan UI menjanjikan jadwal UTC |

**Yang TIDAK dipakai di panduan ini:** Vercel (cron in-process tidak jalan di sana seperti ini),
Docker (tidak ada Dockerfile di repo), dan **dua supervisor sekaligus** (systemd **atau** PM2 §8b —
keduanya berebut port 3000 dan menggandakan cron).

---

## 1. Spesifikasi VPS

| | Minimum | Nyaman |
|---|---|---|
| RAM | **2 GB** (+ swap 2 GB kalau hanya 1 GB) | 4 GB |
| vCPU | 2 | 2–4 |
| Disk | 20 GB | 40 GB |
| OS | Ubuntu 22.04 / 24.04 LTS | sama |

`npm run build` (webpack, Solana SDK + Prisma) adalah bagian paling berat: butuh ±1.5–2 GB RAM
sesaat. Di VPS 1 GB, build akan dibunuh kernel (`Killed`) kalau tidak ada swap — lihat §2.4.

Bandwidth keluar masuk kecil (halaman SSR), tapi app butuh akses internet keluar ke:
Neon (Postgres), RPC Solana/Helius, drand, dan pump.fun API. Jangan pasang firewall keluar
yang memblokir HTTPS.

---

## 2. Persiapan server (sekali saja)

### 2.1 Update + paket dasar

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ca-certificates git nginx openssl build-essential ufw fail2ban
```

`openssl` **wajib** untuk Prisma query engine di Linux. `build-essential` mencegah `npm ci`
gagal saat modul opsional (`bufferutil`, `utf-8-validate`) mencoba compile.

### 2.2 User non-root untuk aplikasi

```bash
sudo adduser --disabled-password --gecos "" pay
```

Semua perintah app sesudah ini dijalankan sebagai `pay` (`sudo -u pay …`), **bukan** root —
kalau tidak, `node_modules` dan `data/` jadi milik root dan service gagal menulis.

### 2.3 Zona waktu **UTC** (jangan dilewati)

```bash
sudo timedatectl set-timezone UTC
timedatectl            # harus: Time zone: UTC (UTC, +0000)
```

Alasannya konkret: `LOTTERY_CRON=0 * * * *` dijalankan `node-cron` memakai **TZ server**, dan
halaman `/` menampilkan hitungan mundur ke jam **UTC**. Kalau VPS di `Asia/Jakarta`, draw
"tiap jam" tetap tiap jam, tapi draw harian (`0 3 * * *`) akan meleset 7 jam dari yang
ditampilkan ke pengunjung.

### 2.4 Swap (hanya kalau RAM ≤ 2 GB)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

### 2.5 Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw --force enable
sudo ufw status
```

Port **3000 tidak dibuka** — app hanya listen di `127.0.0.1`, diakses nginx. Kalau domain tidak
bisa diakses, ikuti urutan diagnosa **§13.1**; membuka 3000 tidak akan menolong.

---

## 3. Install Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # harus v22.x (minimal v20.9)
npm -v       # 10 atau 11
```

Alternatif setara: `nvm` (kalau nanti butuh beberapa versi Node). Kalau pakai `nvm`, ingat
systemd **tidak** membaca `~/.bashrc` — tulis path absolut node/npm di unit file (§8).

---

## 4. Ambil kode proyek

Folder tujuan: **`/var/www/pay`**.

```bash
sudo mkdir -p /var/www/pay
sudo chown -R pay:pay /var/www/pay
```

Pilih **salah satu** cara:

### 4a. Lewat git (disarankan kalau repo sudah ada)

```bash
sudo -u pay git clone <URL_REPO> /var/www/pay
```

Proyek ini di mesin dev **belum** punya repo git. Kalau mau mulai sekarang:

```bash
# di mesin dev
git init && git add . && git commit -m "initial"
# lalu push ke GitHub/GitLab private, baru clone di VPS
```

`.gitignore` sudah mengecualikan `.env`, `node_modules`, `.next`, `*.tsbuildinfo` — aman.

### 4b. Upload langsung (rsync / zip)

Dari mesin dev (PowerShell, butuh `ssh`/`scp` bawaan Windows 10+):

```powershell
# buat arsip tanpa node_modules, .next, .env, build cache
tar -czf pay-src.tgz --exclude=node_modules --exclude=.next --exclude=.env --exclude=*.tsbuildinfo .
scp pay-src.tgz pay@IP_VPS:/tmp/
```

Di VPS:

```bash
sudo -u pay tar -xzf /tmp/pay-src.tgz -C /var/www/pay
sudo -u pay mkdir -p /var/www/pay/data
```

Yang **wajib** ikut: `src/`, `prisma/`, `public/`, `package.json`, `package-lock.json`,
`next.config.mjs`, `tsconfig.json`, `postcss.config.mjs`, `data/buyback.json`, `.env`.
Yang **jangan** di-upload: `node_modules/`, `.next/`, `*.tsbuildinfo`, `*.log`.

### 4c. Pastikan permission benar

```bash
sudo chown -R pay:pay /var/www/pay
sudo chmod 750 /var/www/pay
```

---

## 5. `.env` produksi

Buat file `.env` di `/var/www/pay` (kalau mengikuti §4b, file ini sengaja tidak di-upload —
ketik ulang di VPS supaya kredensial tidak pernah lewat arsip/chat).

```bash
sudo -u pay nano /var/www/pay/.env
sudo chmod 600 /var/www/pay/.env
sudo chown pay:pay /var/www/pay/.env
```

### 5.1 Variabel wajib

| Key | Contoh / catatan |
|---|---|
| `DATABASE_URL` | connection string Neon **pooled** (host mengandung `-pooler`), sertakan `?sslmode=require` (opsional `&connect_timeout=15`). Untuk `prisma db push` pakai string **direct** — §6.1 jalur B |
| `SOLANA_RPC_URL` | RPC server-side (Helius mainnet, `https://mainnet.helius-rpc.com/?api-key=…`) |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | RPC untuk browser/wallet — **di-inline saat build**, lihat §5.3 |
| `TOKEN_MINT` | mint PAY |
| `PLATFORM_WALLET_SECRET` | secret key wallet platform (JSON array **atau** base58) |
| `ADMIN_PASSWORD` | password login `/admin` — pakai yang kuat (≥ 16 karakter acak) |
| `ADMIN_SESSION_SECRET` | string acak panjang, mis. `openssl rand -hex 32` |

### 5.2 Variabel operasional (punya default, tapi sengaja diisi)

| Key | Nilai yang dipakai sekarang | Catatan |
|---|---|---|
| `SOLANA_NETWORK` | `mainnet` | `devnet` hanya untuk eksperimen |
| `TOKEN_DECIMALS` | `6` | |
| `HOLDER_SYNC_CRON` | `*/5 * * * *` | snapshot holder tiap 5 menit |
| `LOTTERY_CRON` | `0 * * * *` | jadwal draw — lihat peringatan §5.4 |
| `LOTTERY_CRON_ENABLED` | `false` | **diabaikan di production** (§5.4) |
| `MIN_TOKEN_ELIGIBLE` | `100000000000` | ambang saldo dalam raw units |
| `PRIZE_RESERVE_LAMPORTS` | `1300000` | SOL yang disisakan di wallet (fee/rent) |
| `PLATFORM_FEE_BPS` | `500` | 5% |
| `MAX_PRIZE_SOL` / `MIN_PRIZE_SOL` | `1` / `0` | batas prize per draw |
| `WINNER_COUNT` | `3` | |
| `PAYOUT_DISTRIBUTION` | `0.5,0.3,0.2` | **harus berjumlah 1.0** |
| `PLATFORM_TREASURY_SECRET` | opsional | kalau kosong, fee tetap di wallet platform |
| `ADMIN_USERNAME` | `admin` | |
| `TOKEN_NAME` | `PAY` | ticker yang tampil di UI (hero, eligibility, holders, treasury); bisa diubah dari `/admin` → SEO & Analytics → **Token name** — nilai DB menang atas env |
| `HELIUS_API_KEY` | opsional | dipakai beberapa endpoint |
| `CLAIM_CRON` | `*/10 * * * *` | jadwal cek creator fee |
| `CLAIM_AUTO_ENABLED` | `false` | auto-claim; biarkan `false` sampai yakin |
| `CLAIM_MIN_SOL` | `0.0005` | ambang minimum pot yang layak diklaim |
| `CLAIM_MIN_WALLET_SOL` | `0.001` | saldo minimum wallet untuk biaya klaim |
| `CLAIM_PRIORITY_FEE_SOL` | `0.0009` | priority fee klaim |
| `NET_PREFER_IPV4` | tidak diisi | default aktif: `ipv4first` + auto-select dimatikan (§13.3); `0` = perilaku bawaan Node |
| `TELEGRAM_BOT_TOKEN` | kosong | **opsional** — token bot grup dari @BotFather. Boleh juga diisi dari `/admin` → Telegram Bot; nilai di database menang atas env. Bukan `NEXT_PUBLIC_*`, jadi cukup restart (tanpa rebuild) |

Nama lengkap key yang dibaca app (30): `SOLANA_NETWORK`, `HELIUS_API_KEY`, `SOLANA_RPC_URL`,
`NEXT_PUBLIC_SOLANA_RPC_URL`, `DATABASE_URL`, `TOKEN_MINT`, `TOKEN_DECIMALS`,
`PLATFORM_WALLET_SECRET`, `PLATFORM_TREASURY_SECRET`, `LOTTERY_CRON`, `HOLDER_SYNC_CRON`,
`MIN_TOKEN_ELIGIBLE`, `PRIZE_RESERVE_LAMPORTS`, `WINNER_COUNT`, `PAYOUT_DISTRIBUTION`,
`PLATFORM_FEE_BPS`, `MAX_PRIZE_SOL`, `MIN_PRIZE_SOL`, `LOTTERY_CRON_ENABLED`,
`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `PUMPFUN_API_BASE`, `CLAIM_CRON`,
`CLAIM_AUTO_ENABLED`, `CLAIM_MIN_SOL`, `CLAIM_MIN_WALLET_SOL`, `CLAIM_PRIORITY_FEE_SOL`,
`NET_PREFER_IPV4`, `TELEGRAM_BOT_TOKEN`.

`TELEGRAM_BOT_TOKEN` dibaca `src/lib/telegram-bot.ts`, bukan `getConfig()` — jadi bot boleh
tetap mati tanpa mengganggu boot. Konfigurasi bot selebihnya (chat id, interval, toggle)
disimpan di tabel `AdminSetting`, bukan di `.env`.

Ticker tampilan dibaca terpisah oleh `src/lib/seo.ts` (bukan `getConfig()`): `TOKEN_NAME`
opsional, default `PAY`, dan baris `TOKEN_NAME` di tabel `AdminSetting` selalu menang —
jadi mengubahnya lewat `/admin` tidak perlu restart atau rebuild. Case disimpan apa
adanya (tidak dipaksa uppercase): `DrawFi`, `drawfi` dan `DRAWFI` sah semua.

Kalau ada key wajib yang kosong, app **tetap boot** tapi scheduler menulis
`[cron] config not ready — skipping cron registration` dan `/api/status` bisa 500 — tanda
paling cepat bahwa `.env` belum benar (§13).

### 5.3 `NEXT_PUBLIC_*` di-bake saat build

`NEXT_PUBLIC_SOLANA_RPC_URL` masuk ke bundle **waktu `npm run build`**, bukan saat start.
Kalau nilai ini diubah setelah build, wallet connect di browser masih memakai URL lama sampai
build diulang. Variabel lain dibaca runtime (boleh diedit + restart saja).


### 5.4 Peringatan: di production, cron draw **selalu** terdaftar

`src/lib/scheduler.ts`:

```ts
const lotteryEnabled =
  process.env.NODE_ENV === "production" ||
  process.env.LOTTERY_CRON_ENABLED === "true";
```

`next start` selalu `NODE_ENV=production`, jadi `LOTTERY_CRON_ENABLED=false` **tidak**
mematikan draw di VPS — nilai itu hanya berpengaruh di mesin dev. Konsekuensinya:

- Tiap tick `LOTTERY_CRON`, engine mencoba membuat round.
- Prize wallet kosong → round tercatat **`skipped`** (tidak ada SOL terkirim, aman, tapi
  riwayat terisi baris "skipped" tiap jam).
- Prize wallet berisi SOL di atas `PRIZE_RESERVE_LAMPORTS` → **draw benar-benar terjadi dan
  SOL terkirim ke pemenang.**

Kontrol yang tersedia di production:

| Tujuan | Caranya |
|---|---|
| Menghentikan draw sementara | set `LOTTERY_CRON` ke jadwal mati, mis. `0 0 1 1 *` (1 Jan 00:00), lalu restart service |
| Draw tiap jam (default) | `LOTTERY_CRON=0 * * * *` → menit ke-0 tiap jam |
| **Draw tiap 10 menit** | `LOTTERY_CRON=*/10 * * * *` → :00, :10, :20, :30, :40, :50 (UTC) |
| Draw harian jam 03:00 UTC | `LOTTERY_CRON=0 3 * * *` |
| Benar-benar mengaktifkan draw | isi prize wallet, lalu pakai jadwal normal |

Semua nilai 5-field, **UTC**, dan dibaca saat boot — setelah edit `.env` **restart service**
untuk mendaftarkan ulang cron (`systemctl restart pay`). Jangan tertukar: `0 */10 * * *` juga
sintaks sah, tapi artinya **tiap 10 jam** (menit ke-0), bukan tiap 10 menit.

Catatan untuk jadwal rapat (mis. `*/10`): tiap tick memanggil `runLotteryRound()`, dan tick
yang jatuh saat draw sebelumnya masih jalan **dilewati** (guard `drawing` di `scheduler.ts`),
jadi tidak ada dua round bertumpuk. Tapi kalau prize wallet kosong, tiap tick tetap menulis
satu baris **`skipped`** — 144 baris/hari — dan `/draws` hanya menampilkan **50** round
terakhir (`take: 50`), jadi draw asli bisa tergeser keluar dari daftar. Untuk menguji
`*/10` sebaiknya isi prize wallet dulu atau set `MIN_PRIZE_SOL` supaya tick diam.

Jangan mengandalkan `LOTTERY_CRON_ENABLED` di server. Admin UI menampilkan penanda
`production: always on` justru untuk mengingatkan hal ini.

---

## 6. Install dependency & Prisma

```bash
cd /var/www/pay
sudo -u pay npm ci                  # persis package-lock.json, ±1–3 menit
sudo -u pay npx prisma generate     # WAJIB: bikin query engine Linux
```

`npm ci` mengunduh engine Prisma untuk platform Linux — butuh internet keluar. Kalau server di
belakang proxy, set `HTTPS_PROXY` sebelum perintah di atas.

Pastikan `NODE_ENV` **tidak** ter-export di shell saat `npm ci`. Kalau ter-export
(`NODE_ENV=production`), npm melewati devDependencies, padahal build butuh `typescript`,
`tailwindcss`, dan `prisma` CLI. Kalau ragu, pakai:

```bash
sudo -u pay npm ci --include=dev
```

### 6.1 Database

Ada **dua jalur** — pilih satu, jangan campur:

| Situasi | Perintah DB yang dijalankan |
|---|---|
| **A. Pakai DB Neon yang sudah ada** (berisi rounds/holders/claims asli) | **tidak ada**. Cukup cek koneksi (snippet di akhir bagian ini), lalu lanjut §6.2 |
| **B. DB Neon baru / kosong** | `npx prisma db push` **sekali**, lalu `npm run holders:sync` |

Kalau tidak yakin DB-nya kosong atau berisi, cek dulu (read-only, tidak mengubah apa pun):

```bash
cd /var/www/pay
sudo -u pay node -e "require('@next/env').loadEnvConfig(process.cwd());const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{const t=await p.\$queryRawUnsafe('select tablename from pg_tables where schemaname=\$1 order by 1','public');console.log('tabel:',t.map(r=>r.tablename).join(', ')||'(kosong)');try{console.log('rounds:',await p.lotteryRound.count(),'| holders:',await p.holder.count())}catch{console.log('tabel utama belum ada → DB baru')}await p.\$disconnect()})().catch(e=>{console.error('db FAIL',e.message);process.exit(1)})"
```

- `(kosong)` atau `tabel utama belum ada` → **jalur B**.
- 8 tabel + angka rounds/holders → **jalur A**, **jangan** `db push`.

#### A. DB Neon yang sudah ada

Tidak ada perintah skema. Pastikan saja `.env` memakai connection string dari dashboard Neon
(`?sslmode=require`) dan isinya bisa dibaca — jalankan snippet **Cek koneksi DB** di akhir §6.1.
Database ini berisi data produksi; `db push` ke sini tidak diperlukan.

#### B. DB Neon **baru** (proyek kosong) — langkah lengkap

**1. Buat proyek.** Dashboard Neon → **New Project**. Region bebas (mis.
`ap-southeast-1` Singapore untuk latensi terbaik dari Indonesia). Database default `neondb`
boleh dipakai apa adanya.

**2. Salin dua connection string.** Buka **Connect**:

- **Pooled** — host mengandung `-pooler`
  (mis. `ep-cool-name-123456-pooler.ap-southeast-1.aws.neon.tech`). Ini untuk `.env`.
- **Direct** — host **tanpa** `-pooler`
  (mis. `ep-cool-name-123456.ap-southeast-1.aws.neon.tech`). Ini **hanya** untuk `db push`,
  karena DDL lewat pooler PgBouncer bisa menggantung.

**3. Isi `.env`** (§5.1) dengan string **pooled** + `?sslmode=require`.

**4. Dorong skema satu kali**, memakai string **direct** hanya di baris perintah — jangan
ditulis ke `.env`, supaya app tetap memakai pooled:

```bash
cd /var/www/pay
sudo -u pay env DATABASE_URL='postgresql://USER:[redacted]/neondb?sslmode=require' \
  npx prisma db push
```

Akhir yang benar: `Your database is now in sync with your Prisma schema.` + `Done in …s`.
Bila menggantung >±30 detik atau muncul `Timed out fetching a new connection`, berarti masih
memakai host `-pooler` → ulangi dengan string direct. Bila Prisma menawarkan **reset**
(`--force-reset`), jawab **No** — artinya `DATABASE_URL` menunjuk DB lain yang sudah berisi.

**5. Verifikasi hasilnya** (8 tabel, semuanya masih 0 baris):

```bash
sudo -u pay node -e "require('@next/env').loadEnvConfig(process.cwd());const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{const t=await p.\$queryRawUnsafe('select tablename from pg_tables where schemaname=\$1 order by 1','public');console.log(t.map(r=>r.tablename).join(', '));console.log('rounds:',await p.lotteryRound.count(),'| holders:',await p.holder.count());await p.\$disconnect()})().catch(e=>{console.error('db FAIL',e.message);process.exit(1)})"
```

Harapan: `AdminSetting, CreatorFeeClaim, ExcludedWallet, Holder, HolderSnapshot,
LotteryRound, NotificationSubscription, Winner` lalu `rounds: 0 | holders: 0`.

**6. Tidak ada seed dan tidak perlu insert manual.** Baris `AdminSetting` (palette, SEO, config
Telegram bot, dll.) dibuat otomatis saat Anda klik **Save** di `/admin`. Round pertama dibuat
cron `LOTTERY_CRON` atau `npm run lottery:run` **setelah** prize wallet berisi SOL.

**7. Isi data holder** supaya angka *eligible* tidak 0. Cron `HOLDER_SYNC_CRON` (`*/5`) akan
mengisinya sendiri setelah service hidup, atau paksa sekali:

```bash
sudo -u pay npm run holders:sync        # menulis HolderSnapshot (pakai kuota Helius)
curl -s http://127.0.0.1:3000/api/status | head -c 300; echo
```

Pool tetap **0 SOL** dan draw berstatus `skipped` sampai wallet diisi — itu normal.

Repo ini **tidak punya folder `prisma/migrations/`** — `db push` adalah cara menyamakan skema
(additive, tidak menghapus baris). Kalau nanti butuh riwayat migrasi, mulai pakai
`prisma migrate dev` di mesin dev dan deploy dengan `prisma migrate deploy` (pakai string
**direct**, alasannya sama dengan `db push`).

**Cek koneksi DB** (dipakai jalur A maupun B) — read-only, tanpa membocorkan isi:

```bash
cd /var/www/pay
sudo -u pay node -e "require('@next/env').loadEnvConfig(process.cwd());const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.\$queryRaw\`select 1\`.then(()=>{console.log('db OK');return p.\$disconnect()}).catch(e=>{console.error('db FAIL',e.message);process.exit(1)})"
```

Harapan `db OK`. `db FAIL` biasanya berarti `DATABASE_URL` salah, DB Neon suspend, atau
`prisma generate` belum jalan (§6, §13.2).

### 6.2 Type-check baseline

```bash
sudo -u pay npx tsc --noEmit       # harus 0 error
```

Kalau di sini sudah error, jangan lanjut build — biasanya `npm ci` belum selesai atau
`prisma generate` terlewat.

---

## 7. Build produksi

```bash
cd /var/www/pay
sudo -u pay npm run build
```

`next build --webpack` (bukan Turbopack — `@solana/web3.js` butuh polyfill Buffer + fallback
`fs/net/tls` dari `next.config.mjs`). Waktu normal **±12–30 detik** di VPS 2 vCPU; kalau lebih
dari 3 menit atau muncul `Killed`, itu OOM → tambah swap (§2.4) atau:

```bash
sudo -u pay NODE_OPTIONS=--max-old-space-size=2048 npm run build
```

Harapan di akhir: daftar route **12/12** halaman, tanpa error. Warning "workspace root" dari
Next aman diabaikan (muncul karena ada `package-lock.json` di folder induk).

**Jangan** menjalankan `npm run build` saat service hidup di folder yang sama — keduanya
menulis `.next/` dan cache jadi rusak (`Manifest file is empty`, halaman reload sendiri).
Urutannya selalu: stop service → build → start service (§11).


---

## 8. Jalankan sebagai service

### 8a. systemd (disarankan)

```bash
sudo nano /etc/systemd/system/pay.service
```

```ini
[Unit]
Description=Pay Lottery (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pay
Group=pay
WorkingDirectory=/var/www/pay
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
EnvironmentFile=-/var/www/pay/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pay-lottery
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pay
sudo systemctl status pay --no-pager
sudo journalctl -u pay -n 50 --no-pager
```

Yang harus terlihat di log: `Ready in …ms` dan (kalau `.env` lengkap) tidak ada
`Missing required env var`. Log `[cron] holders synced: …` muncul tiap 5 menit — bukti
scheduler hidup.

Catatan unit file:

- `HOSTNAME=127.0.0.1` → hanya nginx yang bisa mengakses port 3000. Ganti ke `0.0.0.0`
  hanya kalau sengaja membuka port (tidak disarankan).
- **Satu unit = satu proses = satu scheduler.** Jangan membuat unit/replica kedua atau
  menyalakan PM2 di samping systemd: `node-cron` akan jalan dua kali (round dobel, sync dobel).
  Pengaman lintas-proses memang ada di engine (round-claim lock), tapi tetap tidak perlu.
- Tanda `-` di `EnvironmentFile=-…` membuat systemd tidak menggagalkan service kalau `.env`
  gagal di-parse gaya systemd; `next start` tetap membacanya sendiri lewat `@next/env`.
- Kalau pakai `nvm`, `ExecStart` harus path absolut, mis.
  `/home/pay/.nvm/versions/node/v22.20.0/bin/npm run start`, dan `User=pay` harus punya akses
  ke folder itu.
- `next start` juga memuat `.env` dari folder proyek sendiri (via `@next/env`), jadi nilai
  rahasia tetap terbaca walau `EnvironmentFile` dianggap terlalu ketat oleh systemd. Yang
  **harus** benar dari systemd adalah `NODE_ENV`, `PORT`, dan `HOSTNAME`. Kalau ada nilai
  `.env` yang mengandung karakter aneh (spasi, `#`, kutip), bungkus dengan tanda kutip ganda.
- **Opsional — paksa IPv4.** Hanya perlu untuk **build lama**. Build terbaru sudah mengatur ini
  sendiri saat start (`src/lib/net-ipv4.ts`, dipanggil dari instrumentation hook): hasil lookup
  diurutkan `ipv4first` **dan** family auto-selection dimatikan — kombinasi yang mengatasi
  `fetch failed (ETIMEDOUT)` ke host ber-AAAA walau `curl -4` jalan (§13.3). Untuk build lama,
  tambahkan satu baris di blok `[Service]`, tepat di bawah `Environment=HOSTNAME=…`:

  ```ini
  Environment=NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection
  ```

  `--dns-result-order=ipv4first` **sendirian tidak menolong**: ia hanya mengubah urutan, sementara
  happy-eyeballs tetap memulai attempt IPv6 pada 250 ms dan membatalkan attempt IPv4 yang masih
  berjalan (terbukti: `ETIMEDOUT` 252 ms dengan flag itu saja, 200 dengan dua flag).

  Setelah itu `sudo systemctl daemon-reload && sudo systemctl restart pay`. Verifikasi:

  ```bash
  sudo systemctl show pay -p Environment | tr ' ' '\n' | grep NODE_OPTIONS
  sudo -u pay tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value pay)/environ | grep NODE_OPTIONS
  ```

  Hapus lagi kalau tidak menolong — ini bukan penyebab blokir firewall. Dan kalau build sudah
  baru (`journalctl -u pay -n 40 | grep '\[net\]'` mencetak `[net] ipv4-first aktif, …`), hapus
  baris `Environment=NODE_OPTIONS=…` tadi: hook-nya sudah mengerjakan hal yang sama, flag hanya
  lapisan kedua untuk build lama.

### 8b. Alternatif PM2 (`ecosystem.config.js`)

Pilih **salah satu**: systemd (§8a) atau PM2. Jangan dua-duanya — port 3000 bentrok dan
`node-cron` jalan dua kali.

Repo sudah membawa **`ecosystem.config.js`** di root, jadi yang perlu dilakukan di server cuma
install PM2 lalu menunjuk file itu. Isinya (komentar lengkap ada di file):

```js
module.exports = {
  apps: [
    {
      name: "pay",
      cwd: __dirname, // /var/www/pay — tempat .next dan .env
      script: "npm",
      args: "run start", // sama dengan `npm start` → next start
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      min_uptime: "20s",
      max_restarts: 20,
      restart_delay: 2000,
      kill_timeout: 10000,
      listen_timeout: 15000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOSTNAME: "127.0.0.1",
      },
    },
  ],
};
```

Kenapa begitu:

- `exec_mode: "fork"` + `instances: 1` — scheduler hidup **di dalam** proses Next, jadi cluster
  mode (`-i max`) menggandakan round/sync/payout. Ini bukan preferensi, ini syarat.
- `cwd: __dirname` — PM2 boleh dijalankan dari folder mana pun; `next start` tetap mencari
  `.next` dan `.env` di `/var/www/pay`.
- `env` hanya berisi tiga variabel proses. Rahasia (`DATABASE_URL`, `ADMIN_*`, `TELEGRAM_*`,
  `PLATFORM_*`) **tidak** ditulis di sini — `next start` membacanya sendiri dari `.env`
  (`@next/env`), persis seperti di systemd §8a.
- `kill_timeout: 10000` — PM2 mengirim SIGINT dan menunggu 10 dtk sebelum SIGKILL, cukup untuk
  Next menutup koneksi Prisma. Tanpa ini restart bisa memotong request yang sedang jalan.
- `time: true` + `merge_logs: true` — log gabungan dengan timestamp di
  `~/.pm2/logs/pay-out.log` dan `~/.pm2/logs/pay-error.log`.

#### 8b.1 Install & start (sekali saja)

```bash
cd /var/www/pay
sudo npm i -g pm2
pm2 --version

sudo -u pay pm2 start ecosystem.config.js
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u pay --hp /home/pay
sudo -u pay pm2 save
```

- Semua perintah `pm2` dijalankan sebagai user **`pay`** (`sudo -u pay …`). `sudo pm2 …` membuat
  daemon root terpisah — daftar proses, log, dan file `data/buyback.json` jadi milik root.
- `pm2 startup …` mencetak satu perintah `sudo env PATH=…`; jalankan **persis seperti yang
  dicetak**. Kalau Node dipasang lewat nvm, path-nya menunjuk versi Node tertentu — setelah
  upgrade Node, jalankan ulang `pm2 startup` (atau `pm2 update`).
- `pm2 save` menyimpan daftar proses ke dump. Panggil **setiap** kali daftar berubah
  (start/delete/scale); kalau tidak, saat reboot PM2 memulihkan daftar lama.
- `pm2 startup` membuat unit systemd `pm2-pay` yang menjalankan `pm2 resurrect` saat boot. Unit
  `pay.service` dari §8a **jangan** di-enable bersamaan.

Cek hasilnya:

```bash
sudo -u pay pm2 list
sudo -u pay pm2 show pay
sudo -u pay pm2 logs pay --lines 60 --nostream
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/status
systemctl status pm2-pay --no-pager
```

Yang harus terlihat: status **online**, `restarts` masih **0**, log memuat `Ready in …ms`, tidak
ada `Missing required env var`, dan `[cron] holders synced: …` muncul tiap 5 menit — bukti
scheduler hidup **satu** kali. `curl` harus **200**.

#### 8b.2 Operasi harian

```bash
sudo -u pay pm2 list                 # status, restarts, memory, uptime
sudo -u pay pm2 logs pay             # stream; Ctrl+C keluar tanpa mematikan app
sudo -u pay pm2 logs pay --err --lines 100 --nostream
sudo -u pay pm2 monit                # dashboard CPU/RAM per proses

sudo -u pay pm2 restart pay                              # setelah edit `.env`
sudo -u pay pm2 restart ecosystem.config.js --update-env # setelah edit ecosystem.config.js
sudo -u pay pm2 stop pay
sudo -u pay pm2 flush pay            # kosongkan file log (app tetap jalan)
```

- `restart` **wajib** setelah mengubah `.env`: `next start` membaca env saat boot, bukan tiap
  request. `--update-env` hanya perlu kalau yang berubah adalah `env` di ecosystem (PM2 menyimpan
  env lama di memori).
- Di **fork mode** tidak ada zero-downtime: `pm2 reload pay` sama dengan restart (±1–2 detik 502
  kalau ada request masuk). Jangan tergoda menyalakan cluster mode demi reload mulus — cron akan
  dobel.
- Log ada di `~/.pm2/logs/pay-out.log` dan `pay-error.log` (user `pay`), bukan di journald.

#### 8b.3 Deploy ulang dengan PM2

Sama seperti §11, hanya nama perintah supervisor-nya yang beda:

```bash
cd /var/www/pay

sudo -u pay pm2 stop pay                 # WAJIB: build menimpa `.next` yang sedang dipakai
sudo -u pay git pull                     # atau rsync ulang dari mesin dev
sudo -u pay npm ci --include=dev
sudo -u pay npx prisma generate
sudo -u pay npx tsc --noEmit             # harus 0
sudo -u pay npm run build
sudo -u pay pm2 restart ecosystem.config.js --update-env
sudo -u pay pm2 list
```

- `pm2 stop` dulu, bukan `pm2 restart` sesudah build: kalau app tetap hidup saat `next build`
  menimpa `.next`, request yang masuk bisa kena `Manifest file is empty` (§13.2).
- Rollback: `cp -a .next .next.prev` sebelum build → kalau gagal,
  `pm2 stop pay && rm -rf .next && mv .next.prev .next && pm2 restart ecosystem.config.js --update-env`.
- `pm2 status` harus kembali **online** dengan `restarts` bertambah satu, bukan naik terus.
- Perubahan `prisma/schema.prisma` → tambahkan `npx prisma db push` (string **direct**, §6.1)
  sebelum build.

#### 8b.4 Rotasi log

PM2 menulis log tanpa batas sampai dirotasi:

```bash
sudo -u pay pm2 install pm2-logrotate
sudo -u pay pm2 set pm2-logrotate:max_size 10M
sudo -u pay pm2 set pm2-logrotate:retain 14
sudo -u pay pm2 set pm2-logrotate:compress true
```

`pm2 install` memasang modul ke daemon milik user yang menjalankannya — jalankan sebagai `pay`,
bukan root, supaya rotasi mengenai log yang benar.

#### 8b.5 Jebakan yang mahal

- **Jangan dua supervisor.** Sebelum pindah dari systemd: `sudo systemctl disable --now pay`.
  Cek tidak ada sisa: `systemctl list-units | grep -E 'pay|pm2'`,
  `ss -ltnp | grep ':3000'`, `sudo -u pay pm2 list`.
- **Satu instance.** `pm2 scale pay 2`, `-i max`, atau `exec_mode: "cluster"` = dua scheduler =
  round dan sync dobel (dan payout dobel kalau lock sempat lolos).
- **Jangan `sudo pm2 …`.** Daemon root punya `PM2_HOME=/root/.pm2`: app yang dijalankan di sana
  menulis `data/buyback.json` sebagai root dan `pay` gagal menyimpannya nanti (§8c).
- **`pm2 save` setelah setiap perubahan daftar.** Tanpa itu, reboot memulihkan konfigurasi lama
  (mis. app lama yang sudah di-delete hidup lagi).
- **`max_memory_restart` sengaja tidak diisi.** Restart otomatis di tengah round/payout bisa
  memutus transaksi yang sedang dikirim. Kalau RAM sempit, tambah swap (§2.4), jangan memaksa
  restart berbasis memori.
- **`NODE_OPTIONS` hanya untuk build lama** (§8a/§13.3). Build terbaru sudah memaksa IPv4 dari
  `src/lib/net-ipv4.ts`. Kalau memang perlu, buka komentar baris di `ecosystem.config.js`, lalu
  `pm2 restart ecosystem.config.js --update-env` dan cek
  `sudo -u pay pm2 env 0 | grep NODE_OPTIONS` serta log `[net] ipv4-first aktif, …`.
- **Node via nvm.** Unit `pm2-pay` yang dibuat `pm2 startup` menyimpan path Node versi saat itu.
  Setelah upgrade Node: `pm2 update`, lalu ulangi `pm2 startup` + `pm2 save`.

#### 8b.6 Kembali ke systemd

```bash
sudo -u pay pm2 delete pay
sudo -u pay pm2 save
sudo env PATH=$PATH:/usr/bin pm2 unstartup systemd   # hapus unit pm2-pay
sudo -u pay pm2 kill                                # matikan daemon (opsional)
```

Setelah itu lanjut §8a seperti biasa. Jangan menyalakan keduanya.

### 8c. Menjalankan manual (`npm start` dari SSH)

Cara ini sah untuk uji cepat, tapi env harus ada **di shell** — `NODE_OPTIONS` yang ditulis di
`.env` **tidak berlaku**: Next baru membacanya setelah Node hidup, sedangkan flag DNS dibaca
saat proses lahir.

`NODE_OPTIONS` hanya perlu kalau Anda menjalankan **build lama**; build terbaru sudah memaksa
IPv4 sendiri saat start (`src/lib/net-ipv4.ts` di instrumentation hook), jadi cukup `npm start`.

```bash
cd /var/www/pay
export NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"   # build lama
npm start                                             # atau sekali pakai:
NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" npm start
```

Supaya tidak ikut mati saat SSH ditutup:

```bash
cd /var/www/pay
NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" nohup npm start > /tmp/pay.log 2>&1 &
tail -f /tmp/pay.log
# alternatif: tmux new -s pay   → jalankan npm start di dalamnya (Ctrl+B D untuk lepas)
```

Kalau log start menampilkan `[net] ipv4-first aktif, family auto-selection dimatikan`, build
Anda sudah membawa perbaikan dan flag di atas tidak diperlukan lagi.

Verifikasi env pada proses yang benar-benar jalan:

```bash
ss -ltnp | grep ':3000'
P=$(pgrep -f next-server | head -1); sudo tr '\0' '\n' < /proc/$P/environ | grep NODE_OPTIONS
```

Yang harus diingat saat jalan manual:

- **Tidak ada auto-restart / start saat boot.** Kalau proses mati, situs mati sampai Anda
  menyalakannya lagi. Kalau ini server produksi, pindah ke systemd (§8a).
- **Cron tetap hidup.** Di `NODE_ENV=production` draw selalu aktif, jadi `npm start` yang
  "cuma untuk coba-coba" tetap bisa membuat round dan mengirim SOL.
- **Jangan dobel.** Cek dulu tidak ada instance lain: `sudo systemctl status pay --no-pager`,
  `sudo -u pay pm2 list`, `ss -ltnp | grep ':3000'`. Dua proses = dua scheduler.
- `HOSTNAME` tidak di-set → `next start` bind ke `0.0.0.0`. Aman selama ufw tidak membuka
  3000, tapi lebih rapi `HOSTNAME=127.0.0.1 npm start` di belakang nginx.
- Kalau `npm start` dijalankan sebagai **root**, file `data/buyback.json` bisa jadi milik root
  dan `pay` gagal menulis nanti — jalankan sebagai `pay` (§6).

---

## 9. nginx + HTTPS

### 9.1 DNS dulu

Arahkan `A` record domain (mis. `pay.contoh.com`) ke IP VPS, tunggu propagasi
(`dig +short pay.contoh.com` harus menampilkan IP VPS) **sebelum** meminta sertifikat.

### 9.2 Reverse proxy

```bash
sudo nano /etc/nginx/sites-available/pay
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name pay.contoh.com;

    # favicon/OG upload dari Admin dikirim sebagai data URI base64
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # App tidak memakai WebSocket (polling 5s), jadi header Upgrade tidak perlu.
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pay /etc/nginx/sites-enabled/pay
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Cek http dulu: `curl -I http://pay.contoh.com` → `200`.

### 9.3 Sertifikat TLS

```bash
sudo apt install -y certbot python3-certbot-nginx
EMAIL="ganti-dengan-email-aktif-anda"   # certbot minta email valid untuk notifikasi renew
sudo certbot --nginx -d pay.contoh.com --redirect --agree-tos -m "$EMAIL"
sudo systemctl list-timers | grep certbot     # renew otomatis
```

**HTTPS bukan opsional** untuk admin: cookie sesi dibuat dengan
`secure: process.env.NODE_ENV === "production"` (`src/app/api/admin/login/route.ts`), jadi
login `/admin` di atas `http://` akan "berhasil" tapi cookie-nya dibuang browser → kembali ke
form login terus.


---

## 10. Verifikasi setelah deploy

```bash
for r in / /draws /eligibility /stats /verify /how-it-works /admin; do
  printf '%-16s -> %s\n' "$r" "$(curl -s -o /dev/null -w '%{http_code}' https://pay.contoh.com$r)"
done

curl -s https://pay.contoh.com/api/status | head -c 300; echo
curl -s -o /dev/null -w 'palette API tanpa login: %{http_code}\n' https://pay.contoh.com/api/admin/palette
curl -s -o /dev/null -w 'telegram API tanpa login: %{http_code}\n' https://pay.contoh.com/api/admin/telegram
```

Harapan:

| Cek | Hasil benar |
|---|---|
| 7 route di atas | **200** |
| `/api/status` | JSON berisi pool/round/holders (bukan halaman error) |
| `/api/admin/palette` tanpa cookie | **401** |
| `/api/admin/telegram` tanpa cookie | **401** |
| `/api/admin/cache` tanpa cookie | **401** |
| `http://` (non-TLS) | redirect 301 ke `https://` |
| `sudo journalctl -u pay -n 30` | `Ready in`, tanpa `Missing required env var`, tanpa `did not initialize yet` |

Lalu uji manual di browser:

1. `/` → prize pool, hitungan mundur, jumlah holder terisi (bukan `—` semua).
2. `/draws` → kartu draw terakhir + tombol **Verify** menghasilkan 2 centang (beacon + shuffle).
3. `/admin` → login dengan `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
4. **Tab Palette** → ubah 1 token, preview langsung berubah, **Save**, reload: warna bertahan.
   **Reset** token itu, lalu **Reset all** supaya tidak ada override tertinggal.
5. Admin → Buyback → simpan satu perubahan kecil, pastikan tidak muncul pesan
   "read-only deployment" (artinya `data/` writable).
6. **Opsional — Admin → Telegram Bot** (bot notifikasi grup):
   - Buat bot di **@BotFather** → `/newbot` → salin token.
   - Tambahkan bot ke grup, lalu kirim satu pesan di grup (wajib, supaya bot "melihat" chat).
   - Di panel: paste token → **Find chat id** → klik chat yang benar (mengisi `-100…`
     otomatis; isi **Forum topic id** hanya kalau grup memakai Topics).
   - Set **Round update interval** (default **2** menit), aktifkan **Bot enabled** +
     **Round updates** + **Draw results** → **Save settings**.
   - **Send test** harus muncul di grup. Kalau `Unauthorized` → token salah; `chat not found` →
     bot belum di grup / chat id salah; `not enough rights` → jadikan bot admin grup.
   - Setelah itu: **Post round now** (kirim kondisi round saat ini), lalu **Resend last draw**.
   - Tidak perlu rebuild: cron bot didaftarkan saat service start dan mengecek konfigurasi DB
     tiap menit, jadi perubahan interval berlaku di tick berikutnya tanpa restart.
   - Link di pesan memakai **Site URL** dari Admin → SEO & Analytics; kalau kosong, pesan
     terkirim tanpa link.
   - Token boleh diisi lewat `.env` (`TELEGRAM_BOT_TOKEN`) sebagai ganti panel; nilai di
     database menang atas env.
   - **Teks kedua pesan sekarang bisa diedit** di bagian **Message templates**:
     - **Round update** mendukung `{token} {round} {pool} {eligible} {firstPrizeLine}
       {scheduleLine} {playableNote} {link}`; **Draw result** mendukung `{token} {round}
       {pool} {eligible} {winners} {beacon} {payoutTxLine} {link}`.
     - Baris opsional (`firstPrizeLine`, `playableNote`, `payoutTxLine`, `link`) yang kosong
       otomatis tidak meninggalkan baris kosong.
     - Batas **2000** karakter. **Preview edits** merender draft di server (jalur kode yang
       sama dengan pengiriman asli) sebelum disimpan; **Reset to default** mengembalikan teks
       bawaan. Placeholder yang salah ketik (mis. `{pool}` untuk draw) ditolak saat Save dan
       saat Preview, dengan pesan yang menyebut nama placeholder-nya.
     - Tetap HTML Telegram yang di-escape (`<b>`, `<i>`, `<a href>`, `<code>` boleh); jangan
       menyisipkan alamat/URL tanpa tag, escaping otomatis.
7. **Kartu Cache di `/admin` → Settings** (tekanan debug, bukan wajib): **Refresh** menampilkan
   key yang sedang di-cache beserta umurnya, **Clear cache** mengosongkannya (`{ cleared, remaining }`)
   lalu halaman mengambil ulang data. Aman dipakai kapan saja — cache hanya mempercepat GET,
   sumber datanya tetap DB/RPC. `/api/admin/cache` tanpa cookie menjawab **401**.

Angka acuan saat serah-terima (23–24 Okt 2026): `holders ≈ 509`, `lastRound.roundNumber = 46`
(status `skipped`), pool **0 SOL** → semua draw `skipped` itu **normal**, bukan bug.

---

## 11. Update / deploy ulang

```bash
cd /var/www/pay

sudo systemctl stop pay                 # WAJIB sebelum build
sudo -u pay git pull                    # atau rsync ulang dari mesin dev
sudo -u pay npm ci --include=dev        # build butuh typescript/tailwind/prisma CLI
sudo -u pay npx prisma generate
sudo -u pay npx tsc --noEmit            # harus 0
sudo -u pay npm run build
sudo systemctl start pay
sudo systemctl status pay --no-pager
```

Kalau aplikasi dijalankan lewat **PM2** (§8b), hanya baris supervisor-nya yang berubah —
`git pull`, `npm ci`, `prisma generate`, `tsc`, dan `build` tetap sama:

```bash
sudo -u pay pm2 stop pay                 # WAJIB sebelum build, alasan sama
# … langkah build seperti di atas …
sudo -u pay pm2 restart ecosystem.config.js --update-env
sudo -u pay pm2 list                     # online, restarts bertambah 1
```

`pm2 stop … → build → pm2 restart ecosystem.config.js --update-env` juga memastikan perubahan
`env` di ecosystem ikut terbaca (PM2 menyimpan env lama di memori).

- `npx prisma db push` **hanya** kalau `prisma/schema.prisma` berubah (pakai string **direct**,
  §6.1 jalur B). Fitur yang menyimpan konfigurasi di tabel `AdminSetting` — palette, SEO,
  Buyback, **Telegram bot** — tidak menambah tabel, jadi cukup `git pull` + build + restart.
- Perubahan kode cron/tick (`src/lib/scheduler.ts`, mis. bot Telegram) baru aktif setelah
  **build ulang + restart** (§11). `systemctl restart pay` (atau `pm2 restart ecosystem.config.js
  --update-env`) saja akan menjalankan build lama.
- `.env` berubah → cukup `sudo systemctl restart pay` — atau, di PM2, `sudo -u pay pm2 restart pay`
  — **kecuali** `NEXT_PUBLIC_*` → perlu build ulang (§5.3).
- Rollback cepat: sebelum build, `sudo -u pay cp -a .next .next.prev`; kalau gagal →
  `sudo systemctl stop pay && sudo -u pay rm -rf .next && sudo -u pay mv .next.prev .next && sudo systemctl start pay`.
  Versi PM2: `sudo -u pay pm2 stop pay && sudo -u pay rm -rf .next && sudo -u pay mv .next.prev .next && sudo -u pay pm2 restart ecosystem.config.js --update-env`.
- Jangan menjalankan `npm run dev` di VPS produksi: cache `.next` bertabrakan dengan build
  produksi dan cron bisa membuat round sungguhan.

---

## 12. Backup & restore

| Yang perlu di-backup | Di mana | Frekuensi |
|---|---|---|
| `data/buyback.json` | `/var/www/pay/data/` | tiap admin mengubah buyback |
| Database | Neon (backup/PITR bawaan) | otomatis; cek retensi di dashboard |
| `.env` | **di luar server** (password manager) | setiap perubahan |
| `PROJECT_CONTEXT.md` / `HANDOFF.md` | repo git | setiap perubahan kode |

Backup harian sederhana (cron sistem, sebagai `pay`):

```bash
mkdir -p /home/pay/backups
(crontab -l 2>/dev/null; echo "15 2 * * * cp /var/www/pay/data/buyback.json /home/pay/backups/buyback-\$(date +\%F).json") | crontab -
```

Restore: taruh kembali `data/buyback.json` (kalau hilang, `/treasury` kembali menampilkan `—`),
lalu `sudo systemctl restart pay`. Untuk DB, restore snapshot Neon dari dashboard.

**Jangan** menyimpan `.env` atau `PLATFORM_WALLET_SECRET` di folder yang tersinkron cloud, di
repo, atau di dalam arsip deploy.


---

## 13. Troubleshooting

### 13.1 Domain tidak bisa diakses — cek berurutan

**Port 3000 memang harus tetap tertutup.** Alurnya: browser → `443` (nginx) → `127.0.0.1:3000`.
Membuka 3000 di `ufw` tidak akan memperbaiki domain (app hanya listen di loopback, dan kalau
diubah ke `0.0.0.0` situs jadi terbuka tanpa HTTPS). Jadi jangan mulai dari sana.

Jalankan di server, berurutan, berhenti di langkah pertama yang gagal:

```bash
# 1. App hidup?  → harus "HTTP/1.1 200 OK" atau 307
curl -sI http://127.0.0.1:3000 | head -1
sudo ss -ltnp | grep -E ':3000|:80 '        # next: 127.0.0.1:3000 · nginx: 0.0.0.0:80

# 2. nginx melayani domain ini?  → harus 200, bukan halaman default/404
curl -sI -H 'Host: pay.contoh.com' http://127.0.0.1 | head -1
sudo nginx -T | grep -n 'server_name'       # site "pay" harus muncul
ls -l /etc/nginx/sites-enabled/             # "default" sudah dihapus?

# 3. Firewall di server (dua arah: masuk untuk domain, keluar untuk pumpdev/Neon/RPC)
sudo ufw status verbose                     # 80/tcp + 443/tcp ALLOW; 3000 TIDAK boleh ada
                                            # baris "Default:" harus "allow (outgoing)" (§13.4)

# 4. Dari laptop Anda (bukan dari server)
dig +short pay.contoh.com                   # harus IP VPS
curl -sI http://pay.contoh.com  | head -1   # 200 / 301
curl -sI https://pay.contoh.com | head -1   # 200
```

| Hasil | Artinya | Tindakan |
|---|---|---|
| Langkah 1 gagal (`connection refused`) | app mati atau listen di port lain | `sudo journalctl -u pay -n 50 --no-pager`, cek `PORT` |
| Langkah 2 → `404` / halaman "Welcome to nginx" | site `pay` tidak aktif atau `server_name` beda | §9.2: symlink, hapus `sites-enabled/default`, `nginx -t && reload` |
| Langkah 1–3 OK, langkah 4 **timeout** | **firewall di panel provider** (Security Group / Cloud Firewall / External Firewall) | buka inbound **TCP 80 & 443** di panel VPS — `ufw` saja tidak cukup |
| `dig` kosong atau IP salah | DNS belum mengarah ke VPS | perbaiki A record, tunggu TTL |
| `http` OK tapi `https` gagal | sertifikat belum dipasang | §9.3 `certbot --nginx` |
| `http` OK, `https` **timeout**, tapi `curl -kI https://127.0.0.1` di server jalan | `ufw` belum mengizinkan **443** — sertifikat tetap terbit karena verifikasi certbot lewat port 80 | `sudo ufw allow 'Nginx Full'` (atau `sudo ufw allow 443/tcp`), lalu `sudo ufw status verbose` |
| `curl http://IP_VPS:3000` jalan, domain tidak | app sehat — masalahnya nginx/DNS/80-443, **bukan** 3000 | jangan buka 3000 |

Catatan: kalau domain lewat **Cloudflare** (proxy oranye), `dig` akan menampilkan IP Cloudflare —
itu normal. Pastikan SSL/TLS mode **Full (strict)** dan origin punya sertifikat sendiri (§9.3).

### 13.2 Tabel gejala

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| `@prisma/client did not initialize yet` | `prisma generate` belum jalan / engine hilang | `sudo -u pay npx prisma generate` lalu restart |
| `Missing required env var: X` | `.env` tidak ada, kosong, atau tidak terbaca user `pay` | pastikan `/var/www/pay/.env` ada, `chmod 600`, `chown pay:pay`; cek `sudo -u pay node -e "require('@next/env').loadEnvConfig(process.cwd())"` |
| `502 Bad Gateway` | app mati / port beda | `systemctl status pay`, `sudo -u pay pm2 list` (kalau pakai PM2), `ss -ltnp \| grep 3000`, cek `PORT` |
| `curl http://127.0.0.1:3000` → 200 tapi domain **timeout** | 80/443 diblok di level **provider**, bukan `ufw` | buka inbound TCP 80 & 443 di Security Group / Cloud Firewall provider (§13.1) |
| `nginx: [emerg] bind() to 0.0.0.0:80 failed` | port 80 dipakai service lain (apache2) | `sudo systemctl disable --now apache2`, cek `sudo ss -ltnp \| grep ':80 '` |
| Build mati `Killed` | RAM habis | tambah swap (§2.4) atau `NODE_OPTIONS=--max-old-space-size=2048` |
| `Manifest file is empty`, halaman reload sendiri | `.next` rusak (build saat service hidup) | stop service → `rm -rf .next` → build → start |
| Login admin tidak "nempel" | cookie `secure`, situs diakses via http | pakai domain HTTPS (§9.3); `NODE_ENV` harus `production` |
| Draw terjadi di jam yang salah | TZ server bukan UTC | `sudo timedatectl set-timezone UTC`, restart service |
| Round/sync dobel | dua proses atau dua instance | satu service saja, fork mode, `systemctl list-units \| grep pay`, `sudo -u pay pm2 list` |
| `EADDRINUSE` / app `errored` di `pm2 list` | port 3000 sudah dipakai proses lain (systemd + PM2 dobel, atau instance manual) | matikan salah satu: `sudo systemctl disable --now pay` **atau** `sudo -u pay pm2 delete pay`; cek `ss -ltnp \| grep ':3000'` |
| `restarts` di `pm2 list` naik terus | crash loop: `.next` hilang/rusak, `.env` tidak terbaca, dependency belum terpasang | `sudo -u pay pm2 logs pay --err --lines 80 --nostream`, perbaiki, lalu `pm2 restart ecosystem.config.js --update-env` |
| `pm2: command not found` setelah login ulang | PATH shell tidak memuat prefix npm global (nvm / `/usr/local/bin`) | `sudo -u pay /usr/local/bin/pm2 list` atau `sudo env PATH=$PATH:/usr/bin pm2 list`; pastikan `pm2 startup` dijalankan ulang setelah upgrade Node |
| Pool & winner `—` padahal DB ada isi | `DATABASE_URL` salah / Neon suspend | cek §6.1, buka dashboard Neon |
| Save Buyback: "read-only deployment" | `data/` tidak writable oleh `pay` | `sudo chown -R pay:pay /var/www/pay/data` |
| `insufficient funds for rent` saat payout | wallet platform kurang SOL | isi wallet (sisakan `PRIZE_RESERVE_LAMPORTS` + fee) |
| `pumpdev unreachable: fetch failed` (Admin → Creator Fees) | VPS tidak bisa keluar ke `pumpdev.io` (DNS / egress 443 / jam server) | uji & baca `e.cause.code` di **§13.3** |
| Wallet connect gagal di browser | `NEXT_PUBLIC_SOLANA_RPC_URL` salah | perbaiki `.env` lalu **build ulang** |
| `ERR_TLS_CERT_ALTNAME_INVALID` ke Neon | host pooler di URL salah | pakai connection string persis dari dashboard Neon |
| Lambat sesaat setelah restart | Neon cold start + Prisma warm-up | normal; request kedua sudah cepat |
| `prisma db push` ke DB baru menggantung / `Timed out fetching a new connection` | memakai host **pooler** (`-pooler`) untuk DDL | jalankan ulang dengan connection string **direct** (§6.1 jalur B) |
| `P1001: Can't reach database server` | host salah, DB Neon dihapus/suspend, atau egress 443 tertutup | salin ulang string dari dashboard Neon; cek `sudo ufw status` (§13.4) |
| DB baru: eligible/holders **0** dan draw selalu `skipped` | belum ada `HolderSnapshot` dan prize wallet kosong | `sudo -u pay npm run holders:sync`, isi wallet, tunggu tick berikutnya |
| Telegram: `Telegram: Unauthorized` | token bot salah / sudah di-revoke | `/revoke` + token baru di @BotFather, paste ulang di panel |
| Telegram: `chat not found` | bot belum jadi anggota grup, atau chat id salah format | tambahkan bot ke grup, kirim 1 pesan, lalu **Find chat id** |
| Telegram: `not enough rights…` / `Forbidden` | bot dibatasi di grup (grup memakai izin kirim khusus) | jadikan bot admin grup, atau izinkan member mengirim pesan |
| Round update tidak pernah muncul, panel "Paused" | `enabled` / `notifyRound` mati, atau chat id kosong | aktifkan kedua toggle + simpan chat id |
| Bot tidak posting setelah deploy | service baru start sebelum konfigurasi disimpan | simpan di panel (tick berikutnya mengirim), atau klik **Post round now** |

Log yang berguna:

```bash
sudo journalctl -u pay -f                 # realtime (systemd)
sudo journalctl -u pay --since "1 hour ago" -p warning
sudo -u pay pm2 logs pay --lines 100 --nostream   # (PM2)
sudo tail -f /var/log/nginx/error.log
```

### 13.3 `fetch failed` ke layanan luar (pumpdev, RPC, drand)

`fetch failed` adalah pesan generik undici — penyebab aslinya ada di `cause`. Sejak versi ini
kartu Admin menampilkannya, tapi untuk melokalisasi lapisan yang gagal pakai script bawaan:

```bash
cd /var/www/pay
sudo -u pay npm run net:test        # READ-ONLY: dns → tcp4/tcp6 → TLS (SNI asli + pembanding) → HTTPS
```

Outputnya membandingkan **pumpdev**, **host RPC**, dan **host kontrol** (`github.com`), lalu
mencetak verdict. Contoh sehat: `tcp4 → :443 connected`, `tls sni=pumpdev.io TLSv1.3`, dan
`https request HTTP 400` (400 = API hidup, parameter dummy).

Kalau perlu manual, uji dari **dalam server** (laptop Anda punya jalur keluar berbeda):

```bash
# A. Jaringan keluar sehat?
getent hosts pumpdev.io
curl -sS -m 10 -o /dev/null -w 'pumpdev %{http_code} %{time_total}s\n' \
  'https://pumpdev.io/api/claim-account?publicKey=x&mint=y'    # 400 = API hidup & terjangkau
curl -sS -m 10 -o /dev/null -w 'helius %{http_code}\n' "$SOLANA_RPC_URL"

# B. Jam server (skew > beberapa menit = handshake TLS gagal)
timedatectl | head -4

# C. Persis seperti yang dilihat app: user pay + Node, bukan curl
sudo -u pay node -e "fetch('https://pumpdev.io/api/claim-account?publicKey=x&mint=y',{signal:AbortSignal.timeout(10000)}).then(r=>console.log('status',r.status)).catch(e=>console.log(e.message,'|',e.cause?.code,'|',e.cause?.message))"
```

| `e.cause.code` | Arti | Perbaikan |
|---|---|---|
| `ENOTFOUND` / `EAI_AGAIN` | DNS gagal di server | `cat /etc/resolv.conf`, `resolvectl status`, pasang resolver publik (`1.1.1.1`) |
| `ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` | egress 443 diblok atau host tak terjangkau | buka **outbound TCP 443** di firewall provider |
| `CERT_HAS_EXPIRED` / `CERT_NOT_YET_VALID` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | jam server salah atau CA hilang | `sudo timedatectl set-ntp true`, `sudo apt install --reinstall ca-certificates` |
| `ENETUNREACH` / `EHOSTUNREACH` (IPv6) | rute IPv6 rusak padahal DNS mengembalikan AAAA | uji `curl -4`; pakai `NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection` (§8a/§8c) — build baru sudah otomatis |
| `ETIMEDOUT` untuk alamat **IPv4 yang sehat** | happy-eyeballs Node membatalkan attempt IPv4 pada 250 ms karena attempt IPv6 gagal instan | sama: `ipv4first` **+** `--no-network-family-autoselection` (§13.3 di bawah) |
| tidak ada `cause` | timeout 15 s / respons terlalu lambat | bandingkan `time_total` curl; cek MTU provider |

**Khusus `ETIMEDOUT`:** SYN keluar tapi tidak pernah dijawab (paket di-*drop*, bukan ditolak
dengan RST) — jadi DNS, sertifikat, URL, dan jam server sudah pasti bukan penyebabnya. Yang
tersisa: egress 443 diblok, rute IPv6 *blackhole*, atau MTU. Bedakan begini:

```bash
curl -4 -sS -m 10 -o /dev/null -w 'v4 %{http_code} %{time_total}s\n' https://pumpdev.io
curl -6 -sS -m 10 -o /dev/null -w 'v6 %{http_code} %{time_total}s\n' https://pumpdev.io
sudo traceroute -T -p 443 pumpdev.io        # sudo apt install -y traceroute
```

- `v4` OK tapi app tetap `ETIMEDOUT` → hampir selalu **happy-eyeballs Node**, bukan IPv6-first
  murni: `dns.lookup` mengembalikan A lalu AAAA, `autoSelectFamily` memulai connect IPv4, lalu
  250 ms kemudian (`autoSelectFamilyAttemptTimeout`) memulai connect IPv6; IPv6 langsung
  `ENETUNREACH`, semua attempt dianggap selesai, dan attempt IPv4 yang **masih berjalan**
  dilaporkan sebagai `ETIMEDOUT`. Flag `ipv4first` **sendirian tidak menolong** (terbukti:
  `ETIMEDOUT` 252 ms). Yang menolong adalah mematikan auto-select juga:
  `NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"` (§8a/§8c).
  Build terbaru sudah melakukan ini otomatis lewat `src/lib/net-ipv4.ts`, jadi flag hanya perlu
  untuk build lama. Detail + bukti probe ada di bawah ini.
- `v4` juga timeout sementara host kontrol jalan → tujuan diblok (firewall provider atau
  penyaringan nama domain). Uji cepat MTU: `sudo ip link set dev eth0 mtu 1400` (kembalikan
  setelah tes), atau minta provider membuka/memeriksa rute keluar ke `pumpdev.io:443`.
- `traceroute` berhenti di hop pertama → blokir di jaringan provider; hop terakhir sebelum
  tujuan → blokir di sisi tujuan (IP VPS ditolak).

### 13.4 Aturan firewall yang benar (masuk **dan** keluar)

`fetch failed (ETIMEDOUT)` adalah masalah arah **keluar** — membuka port masuk tidak akan
mengubah apa pun. Aturan minimal:

| Arah | Port | Untuk apa |
|---|---|---|
| in | 22/tcp | SSH |
| in | 80/tcp | HTTP (redirect ke HTTPS + verifikasi & renew certbot) |
| in | 443/tcp | HTTPS |
| out | 443/tcp | pumpdev, Helius, drand, Neon (Prisma) |
| out | 80/tcp | HTTP biasa / redirect |
| out | 53/tcp+udp | DNS |

Port **3000 tidak pernah** dibuka (masuk maupun keluar).

```bash
# 1. Apakah ufw memblokir keluar? Baris pertama harus "allow (outgoing)"
sudo ufw status verbose
# kalau tertulis "deny (outgoing)", buka seperlunya:
sudo ufw default allow outgoing
# atau spesifik:
sudo ufw allow out 443/tcp
sudo ufw allow out 80/tcp
sudo ufw allow out 53

# 2. Firewall provider (Hetzner Cloud Firewall, DO Cloud Firewall, AWS Security Group,
#    Oracle Security List/NSG, panel IDCloudHost/Biznet): buka juga aturan **outbound**
#    TCP 443 ke 0.0.0.0/0 — banyak panel default-nya hanya mengatur inbound.

# 3. Bukti egress 443 hidup (tanpa curl)
timeout 5 bash -c 'exec 3<>/dev/tcp/pumpdev.io/443' && echo "443 keluar OK" || echo "443 keluar GAGAL"
nc -vz -w 5 pumpdev.io 443

# 4. Ulangi diagnosa penuh
sudo -u pay npm run net:test
```

Kalau setelah egress dibuka `timeout 5 bash -c …` tetap gagal sementara `github.com` jalan,
berarti bukan firewall Anda: provider memfilter **nama domain** (umum di ISP ID, Trust+) atau
IP VPS ditolak sisi tujuan. Solusinya jalur keluar lain (proxy/tunnel), bukan aturan `ufw`
tambahan.

#### Kalau curl berhasil tapi app tetap `ETIMEDOUT`

Kasus ini sering terjadi dan penyebabnya bukan firewall. Bandingkan dulu dua versi:

```bash
# IPv4 jalan (200) tapi IPv6 mati total (0 ms = tidak ada rute, bukan di-drop)
curl -4 -sS -m 10 -o /dev/null -w 'v4 %{http_code} %{time_total}s\n' https://pumpdev.io
curl -6 -sS -m 10 -o /dev/null -w 'v6 %{http_code} %{time_total}s\n' https://pumpdev.io

# Node bicara dengan jaringan berbeda dari curl — buktikan
cd /var/www/pay
sudo -u pay node -e "const t=Date.now();fetch('https://pumpdev.io/api/claim-account?publicKey=11111111111111111111111111111111&mint=So11111111111111111111111111111111111111112').then(r=>console.log('HTTP',r.status,Date.now()-t+'ms')).catch(e=>console.log('ERR',e.message,'|',e.cause?.code,'|',JSON.stringify(e.cause?.errors?.map(x=>x.code))))"
```

**Probe empat varian** — satu perintah, hasilnya memisahkan penyebab tanpa menebak. Jalankan di
server (keluaran di bawah adalah hasil nyata DrawFi, 24 Okt 2026):

```bash
sudo node -e '
const dns=require("node:dns"), net=require("node:net");
const probe=async(label)=>{const t=Date.now();try{const r=await fetch("https://pumpdev.io");console.log(label.padEnd(26),"HTTP",r.status,Date.now()-t+"ms")}catch(e){console.log(label.padEnd(26),"ERR ",Date.now()-t+"ms",e.message,"|code=",e.cause?.code,"|errs=",JSON.stringify((e.cause?.errors||[]).map(x=>x.code+"@"+x.address)))}};
(async()=>{
  console.log("lookup :",JSON.stringify(await dns.promises.lookup("pumpdev.io",{all:true})));
  console.log("autoSel:",net.getDefaultAutoSelectFamily(),"attemptTO:",net.getDefaultAutoSelectFamilyAttemptTimeout());
  await probe("A default");
  dns.setDefaultResultOrder("ipv4first");          await probe("B ipv4first");
  net.setDefaultAutoSelectFamily(false);           await probe("C ipv4first+noAutoSel");
  net.setDefaultAutoSelectFamily(true); dns.setDefaultResultOrder("ipv6first"); await probe("D ipv6first");
})()'
```

```text
lookup : [{"address":"80.78.25.150","family":4},{"address":"2a0a:3840:8078:25:0:504e:1996:1337","family":6}]
autoSel: true attemptTO: 250
A default                  ERR  304ms fetch failed |code= ETIMEDOUT |errs= ["ETIMEDOUT@80.78.25.150","ENETUNREACH@2a0a:3840:8078:25:0:504e:1996:1337"]
B ipv4first                ERR  252ms fetch failed |code= ETIMEDOUT |errs= ["ETIMEDOUT@80.78.25.150","ENETUNREACH@2a0a:3840:8078:25:0:504e:1996:1337"]
C ipv4first+noAutoSel      HTTP 200 899ms
D ipv6first                HTTP 200 970ms
```

Cara membacanya:

- **`C` berhasil, `A`/`B` gagal** → TCP IPv4 sehat tapi butuh **> 250 ms**, dan
  `autoSelectFamilyAttemptTimeout` (default 250 ms) sudah memindahkan attempt ke IPv6;
  IPv6 mati `ENETUNREACH`, lalu Node menutup semuanya dan melaporkan attempt IPv4 yang
  sebenarnya masih berjalan sebagai `ETIMEDOUT`. **Inilah akar masalah DrawFi** — bukan
  firewall, bukan MTU, bukan proxy. `curl -4` yang 1,68 s sepenuhnya konsisten: handshake-nya
  memang lambat, bukan putus.
- **`B` gagal padahal `C` berhasil** → flag `--dns-result-order=ipv4first` **tidak cukup**;
  auto-selection wajib dimatikan juga.
- **`D` berhasil** hanya karena IPv6 gagal instan sehingga IPv4 langsung dipakai — jangan
  diandalkan; host lain bisa menggantung di attempt pertama.
- **Keempatnya gagal** → baru kejar penyebab lain di bawah (proxy / MTU / host salah).

**Perbaikan permanen (sudah ada di repo).** `src/lib/net-ipv4.ts` menjalankan
`dns.setDefaultResultOrder("ipv4first")` + `net.setDefaultAutoSelectFamily(false)`, dan dipanggil
dari `src/instrumentation.ts` **sebelum** scheduler start — jadi berlaku untuk semua `fetch`
server (creator fees, drand, Helius, Neon) setelah `npm run build` + restart. Log start mencetak
`[net] ipv4-first aktif, family auto-selection dimatikan` sebagai bukti. `NET_PREFER_IPV4=0` di
`.env` mengembalikan perilaku bawaan Node (host IPv6-first).

Untuk build lama yang belum di-rebuild, setara dengan flag — **dua-duanya**, bukan hanya yang
pertama:

```bash
# manual (§8c)
NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" npm start
# systemd (§8a)
Environment=NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection
```

Kedua flag diterima di `NODE_OPTIONS` (diuji di Node **20.20.2** dan **22.23.4**). Kalau Node Anda
lebih tua dan menolaknya (`is not allowed in NODE_OPTIONS`), jalankan Next langsung dengan flag
sebagai argumen: `node --dns-result-order=ipv4first --no-network-family-autoselection node_modules/next/dist/bin/next start`.

**Status: terbukti di DrawFi (24 Okt 2026).** Setelah langkah di bawah diterapkan, kartu
Admin → Creator Fees kembali normal — diagnosis happy-eyeballs dikonfirmasi, bukan firewall.
Cara memastikan mekanisme mana yang bekerja:

```bash
journalctl -u pay -n 40 --no-pager | grep '\[net\]'   # build baru: "[net] ipv4-first aktif, …"
sudo -u pay tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value pay)/environ | grep NODE_OPTIONS
```

Baris log muncul → hook instrumentation yang bekerja (tidak butuh flag, boleh hapus dari §8a/§8c).
Hanya `NODE_OPTIONS` yang terlihat → masih build lama; rebuild saat ada kesempatan.

Penyebab lain (kalau probe A–D semuanya gagal):

1. **Proxy di environment shell.** `curl` membaca `http_proxy`/`https_proxy`/`all_proxy`,
   sedangkan `fetch` Node **tidak** (undici perlu `ProxyAgent`). Cek `env | grep -i proxy` dan
   `curl -w '%{remote_ip}'` — kalau IP-nya bukan IP pumpdev, curl Anda lewat proxy.
2. **MTU/PMTU.** Bisa juga butuh retransmisi > 250 ms; kalau `C` pun gagal, uji
   `ping -M do -s 1472 pumpdev.io` lalu `-s 1400`; kalau 1400 lolos dan 1472 tidak, kecilkan
   MTU interface atau pakai `--mtu` di provider. (Di DrawFi `C` berhasil, jadi MTU bukan faktor.)
3. **Host berbeda.** `PUMPFUN_API_BASE` di `.env` bisa menunjuk host lain daripada yang Anda
   `curl`. Cek `grep -n '^PUMPFUN_API_BASE' .env` sebelum menyimpulkan apa pun.

Setelah rebuild, kartu **Admin → Creator Fees** menampilkan kode penyebabnya, mis.
`pumpdev unreachable: fetch failed (ENOTFOUND — getaddrinfo ENOTFOUND pumpdev.io)`, bukan lagi
`fetch failed` saja.

### 13.5 Data terasa lambat sekali setelah restart, lalu normal

GET route yang dibaca halaman sekarang punya **cache TTL in-process** (`src/lib/cache.ts`):
`/api/status` 10 s, `/api/rounds` 15 s, `/api/stats` 30 s, `/api/holders?page`, `/api/eligibility?address`,
`/api/rounds/[n]` 30 s, `/api/admin/info` 5 s, `/api/admin/holders` 30 s, `/api/admin/creator-fees` 20 s.
Nilainya disajikan **stale-while-revalidate**: setelah TTL lewat, respons lama tetap dikirim
(instan) sambil versi barunya diambil di background — jadi tidak ada request user yang menunggu
Neon/pumpdev. Aksi admin (draw, sync, claim, auto-claim, tambah/hapus exclusion, reset-data)
memanggil `clearCache()` supaya angka setelah aksi tidak basi.

Konsekuensinya:

- **Request pertama setelah `systemctl restart` / deploy tetap dingin** (1–6 s: handshake Neon +
  query). Request berikutnya 2–10 ms. Ini normal, bukan bug.
- Saat boot, log harus memuat `[db] pool warm (… ms)` dan tiga baris
  `[warm] /api/status 200 in … ms`, `[warm] /api/rounds …`, `[warm] /api/stats …`.
  Artinya cache sudah terisi sebelum user pertama datang. Kalau `[warm]` tidak muncul:
  `NODE_ENV` bukan `production`, atau `PORT` aplikasi bukan `3000` (self-fetch memakai
  `process.env.PORT || "3000"` — set `PORT` yang benar di systemd).
- Cache ini **per proses**. Kalau nanti menjalankan >1 instance (mis. `pm2 -i 2`), tiap instance
  punya cache sendiri — hasilnya tetap benar, hanya hit-rate terbagi.
- Data bisa tertinggal maksimal sebesar TTL-nya (paling lama 30 s; kartu Creator Fees 20 s).
  Kalau butuh lebih segar, turunkan angka TTL di route yang bersangkutan.

Cek cepat di server (perhatikan angka pertama vs berikutnya):

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w '%{time_total}s\n' http://127.0.0.1:3000/api/status
done
```

`0.00x` pada percobaan ke-2/3 = cache bekerja. Kalau semuanya > 1 s, cek `[warm]` di
`journalctl -u pay-lottery -n 50` dan pastikan hanya ada satu proses Node yang melayani port itu.


---

## 14. Checklist akhir

- [ ] `timedatectl` = **UTC**
- [ ] Node **≥ 20.9** (disarankan 22 LTS), `npm ci` sukses
- [ ] `npx prisma generate` dijalankan **di VPS**
- [ ] DB diputuskan: **jalur A** (DB lama, tanpa `db push`) atau **jalur B** (DB baru: `db push` dengan string **direct** + `npm run holders:sync`) — §6.1
- [ ] `.env` lengkap, `chmod 600`, milik `pay`
- [ ] `LOTTERY_CRON` sudah diputuskan (§5.4 — production selalu mengaktifkan draw)
- [ ] `npm run build` sukses, `npx tsc --noEmit` 0 error
- [ ] log start memuat `[net] ipv4-first aktif, family auto-selection dimatikan` (§13.3)
- [ ] `sudo -u pay npm run net:test` sukses (pumpdev + RPC), kartu **Admin → Creator Fees** terisi
- [ ] supervisor jalan dan **hanya satu**: systemd `enabled` + `active`, **atau** PM2 `online` +
      `pm2 save` sudah dijalankan (jangan dua-duanya) — §8a / §8b
- [ ] nginx proxy jalan, **HTTPS** aktif, `http → https` redirect
- [ ] `ufw` hanya 22/80/443; port 3000 tidak terekspos (`sudo ufw status verbose`)
- [ ] diuji **dari luar** (laptop): `curl -I https://DOMAIN` → 200, bukan timeout
- [ ] `/api/status` 200 JSON, `/api/admin/palette` 401 tanpa login
- [ ] login `/admin` berhasil, tab **Palette** save + reset berfungsi
- [ ] `data/` writable (uji simpan Buyback)
- [ ] (opsional) bot Telegram: token + chat id tersimpan, **Send test** masuk ke grup, interval sesuai (default **2** menit) — §10 langkah 6
- [ ] backup `data/buyback.json` + salinan `.env` di luar server
- [ ] `ADMIN_PASSWORD` & `ADMIN_SESSION_SECRET` baru, bukan nilai dev


---

## 15. Lampiran — menjalankan skrip manual di server

Semua skrip membaca `.env` dari `process.cwd()` (via `@next/env`), jadi jalankan **dari
`/var/www/pay` sebagai user `pay`**. Tidak perlu mematikan service, tapi jangan dijalankan
bersamaan dengan tick cron yang sama (engine punya round-claim lock, tetap lebih rapi
menghindarinya).

```bash
cd /var/www/pay

sudo -u pay npm run wallet:check     # READ-ONLY: alamat + saldo wallet platform & treasury
sudo -u pay npm run drand:test       # READ-ONLY: tes koneksi beacon drand
sudo -u pay npm run net:test         # READ-ONLY: dns/tcp/TLS/HTTPS ke pumpdev + RPC + kontrol
sudo -u pay npm run holders:sync     # menulis snapshot holder ke DB (pakai kuota Helius)
```

| Skrip | Efek |
|---|---|
| `wallet:check` | aman, hanya membaca |
| `drand:test` | aman, hanya membaca |
| `net:test` | aman, hanya membaca (tanpa kirim transaksi); pakai kalau ada `fetch failed` (§13.3) |
| `holders:sync` | menulis `HolderSnapshot` di DB, memakai kuota RPC |
| `lottery:run` | **membuat round baru + mengirim SOL sungguhan** ke pemenang |
| `airdrop` | **transfer token sungguhan** |
| `setup:devnet` | hanya untuk devnet, membuat mint + test wallet |

Untuk draw manual di production, pastikan prize wallet sudah diisi dan `LOTTERY_CRON` sudah
diputuskan (§5.4). Untuk melihat status tanpa menjalankan skrip, buka Admin → App Info.

Catatan: `pm2`/systemd tidak tahu tentang skrip ini — kalau butuh berkala, buat systemd timer
terpisah dan panggil `npm run holders:sync` dengan `WorkingDirectory=/var/www/pay`.

