# MIGRATION — Solana → Robinhood

> Spesifikasi kerja migrasi chain. **Baca bareng `PROJECT_CONTEXT.md`** (state kode) dan
> `HANDOFF.md` (setup mesin). Dibuat **2026-10-29** saat Step 1 dikerjakan.
>
> Aturan main: setiap fase punya *deliverable* dan *cara verifikasi* sendiri, dan
> **tidak ada build produksi** sebelum Fase 6. Selama Fase 1–3 aplikasi tetap jalan
> di Solana (`NEXT_PUBLIC_CHAIN` default = `solana`).

---

## 1. Prinsip yang tidak boleh dilanggar

1. **Solana harus tetap utuh sampai adapter baru lulus uji.** Semua perubahan lewat
   lapisan adapter (`src/lib/chain/`), bukan `if (chain === …)` yang tersebar.
2. **Yang membuktikan keadilan tidak berubah.** drand = HTTP publik, shuffle =
   Fisher–Yates di JS/Web Crypto, checksum = SHA-256. Jadi `/verify`,
   `reproduceWinners()`, dan label "provably fair" tetap sah di chain mana pun.
   Migrasi ini **tidak boleh** menyentuh `src/lib/lottery/verify.ts` dan
   `src/lib/solana/randomness.ts` (nama foldernya salah — isinya drand).
3. **Jangan menebak API chain.** Kalau bentuk request/response launchpad belum ada
   contohnya, fase itu ditunda, bukan dikira-kira.
4. **Kejujuran copy ikut dijaga.** Kalau payout jadi N transaksi (ERC-20), klaim
   "one atomic payout tx" di `/treasury` dan `/how-it-works` wajib diubah.

---

## 2. Fakta yang harus diisi dulu (blocking untuk Fase 2+)

Tanpa ini Fase 2 tidak bisa mulai. Isi kolom kanan.

| # | Fakta | Kenapa penting | Nilai |
|---|---|---|---|
| F1 | Tipe chain: EVM-compatible atau SVM? | Menentukan seluruh SDK (viem vs web3.js) | ✅ **EVM** (dokumen resmi pons memakai `viem` + ABI, Uniswap v4, `1e18`, `zeroAddress`) |
| F2 | `chainId` + RPC URL (HTTP), ada WS? | Provider server + wallet client | ✅ **mainnet `4663`** · **Alchemy `https://robinhood-mainnet.g.alchemy.com/v2/<KEY>`** (slug `robinhood-mainnet` terkonfirmasi 29 Okt) · fallback publik `https://rpc.mainnet.chain.robinhood.com` · sequencer `https://sequencer.mainnet.chain.robinhood.com` · feed WS `wss://feed.mainnet.chain.robinhood.com` · **testnet `46630`** `https://rpc.testnet.chain.robinhood.com` |
| F3 | Nama simbol + desimal token gas (mis. `ETH`/18) | Semua label "SOL", `NATIVE_DECIMALS` | ✅ **ETH / 18** — "uses ETH as its native gas token" (sumber resmi dikutip Robinscanner) |
| F4 | URL explorer + skema path (`/tx/…`, `/address/…`) | `explorerLink()` — satu-satunya tempat yang berubah | ✅ **`https://robinhoodchain.blockscout.com`** (Blockscout → `/tx/{h}`, `/address/{a}`, `/token/{a}`) · alternatif `https://robinscanner.com` · testnet `explorer.testnet.chain.robinhood.com` |
| F5 | Alamat kontrak token (`0x…`) + desimalnya | pengganti `TOKEN_MINT`/`TOKEN_DECIMALS` | ❌ token belum dideploy → **pakai reference token PONS `0x39dB…4571` untuk membangun & menguji dulu** |
| F6 | **Cara ambil daftar holder**: `eth_getLogs` (range berapa blok?) atau endpoint indexer/launchpad | **risiko #1** — pengganti `getProgramAccounts` | ✅ **Blockscout API terverifikasi live** (no key, free): `/api/v2/tokens/{t}/holders` → 50/pages, cursor `next_page_params`, **terurut saldo menurun** → bisa early-exit di bawah `MIN_TOKEN_ELIGIBLE`; `/api/v2/tokens/{t}` → `decimals`, `total_supply`, `holders_count` |
| F7 | Hadiah dibayar pakai koin native atau ERC-20? | Bentuk `sendPayouts()` + copy "atomic tx" | ✅ **ETH native** (keputusan pemilik 29 Okt: wallet platform diisi manual, jadi hadiah dibayar native dari platform wallet). v1/v2 bisa saja menerima fee dalam WETH/token/quote asset — **unwrap WETH → ETH adalah pekerjaan Fase 4**. ⚠️ konsekuensi: payout jadi **1 tx per pemenang** (bukan 1 tx atomik) → copy "one atomic payout tx" di `/treasury` + `/how-it-works` **wajib diubah** |
| F8 | Launchpad (pons): endpoint holder / creator-fee snapshot / claim + contoh response | pengganti `pumpfun/creator-fees.ts` | ✅ **claim = `collectFees(address token)` (`0xa480ca79`) pada `PonsLaunchLocker` `0x736D7669…7F35`** — terverifikasi dari ABI + riwayat tx; fee = liquidity fee **dua sisi (token + WETH)** lewat `FeesClaimed(token, caller, token0, token1, recipientAmount0/1, protocolAmount0/1)`; pons menjalankan **collector bot** sendiri (`feeCollectors`), dan jumlah creator ditentukan `feeRedirects[token]` + `tokenProtocolFeeShares[token]` (70/30 sekarang, 90/10 legacy) |
| F9 | Wallet yang didukung (Robinhood Wallet, MetaMask, WalletConnect?) | `WalletProvider.tsx` | _belum_ |
| F10 | Ada testnet? nama + RPC + faucet? | dry-run Fase 6 | _belum_ |
| F11 | Private key platform wallet: `0x…` (32 byte) atau mnemonic? | `PLATFORM_WALLET_PRIVATE_KEY` | _belum_ |
| F12 | Alamat venue yang harus dikecualikan (vault launchpad / pair LP) | pengganti PDA bonding-curve/pool | _belum_ |

### 2b. Hasil pengecekan 2026-10-29 (tool fetch sesi ini)

Sumber: `docs.ponsfamily.com`, `docs.ponsfamily.com/v2`, `docs.ponsfamily.com/llms.txt`, `ponsfamily.com`.
**`robinhood.com` dan `docs.robinhood.com` tidak bisa diakses** dari mesin ini (tool: "Unable to connect"),
jadi semua fakta di bawah berasal dari dokumentasi **pons**, bukan dari Robinhood.

**Chain.** Nama **Robinhood Chain**, **chainId 4663**. Bukti EVM: seluruh contoh kode resmi memakai
**viem** (`parseAbi`, `client.readContract`), `zeroAddress`, `1e18`, pool **Uniswap v4**. Gas: **ETH**
(launch fee ditulis "0.0005 ETH"). **RPC URL dan explorer belum ketemu** di dokumen yang bisa dibaca.

**pons v1** (stack yang membuat token + pool WETH dalam satu transaksi):
- Factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` · Locker `0x736D76699C26D0d966744cAe304C000d471f7F35` · WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- Satu tx: token + pool WETH, likuiditas terkunci; **tanpa bonding curve, tanpa migrasi**; supply tetap **1 miliar**; **1% pool fee**; **0.0005 ETH** launch fee; ambang graduasi default **4.2 ETH**; creator menetapkan **fee wallet** saat membuat.
- Split creator/protocol **70/30** sejak block `8991118`; factory legacy **90/10** sejak block `8600612`; split di-snapshot per token.
- Baca: `factory.graduationStatus(token)` → `(pairedPrincipal, threshold, graduated)`; `factory.locker()`;
  `locker.tokenProtocolFeeShares(token)`; `locker.feeRedirects(token)`; `locker.protocolFeeRecipient()`
  (creator payout = `feeRedirects`, `0x0` → deployer). Harga USD di interface pakai oracle **DeFiLlama**.
- **Reference token** (dokumen: "for validating an indexer or integration against known onchain state"):
  token PONS `0x39dBED3a2bd333467115dE45665cC57F813C4571`, pool `0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA`,
  launch tx `0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8` (graduated, factory legacy).

**pons v2** (stack baru; **public launching DITUTUP** — cek `canLaunch(address)` di factory dulu):
- Bonding curve → graduasi ke **Uniswap v4 pool** dengan likuiditas terkunci permanen (liquidity "locked permanently").
- Kutipan penting: *"A launch does not have to be priced in ETH. It can be paired against another token, and when it is, that token becomes the currency of the whole launch. You buy and sell in it, and the creator is paid in it."* → **custom pairs** (situs menampilkan pair USDG, NVDA, TSLA, SPY, GLD, GME, PLTR, …).
- Snipe tax: beli dalam **5 detik** pertama, mulai **99%** lalu turun separuh sampai nol → `currentSnipeTaxBps(recipient)`.
- Curve tanpa quote function: harga dari `getReserves()`, `feeBps()`, `creatorTaxBps()`, `sellableTokens()`
  (buy fee dari input, sell fee dari output). `getLaunchFeePolicy(token)` → `FeePolicy { protocolFeeRecipient, protocolFeeShareBps, … }`.
- Alamat: factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, meme hook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`,
  fee escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`, buyback vault `0x42df2a798f82289E177311362e8f5ccC45c1219c`,
  launch locker `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952`, router `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`,
  deployer `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42`, graduation executor `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046`,
  graduation guard `0xf5695117b99B6f6401e67d4195BD653628176C6C`.
- `llms.txt` memperingatkan: *"resolve a token's stack from the factory that launched it rather than assuming
  this one"* → **wajib tahu token Anda lahir lewat factory yang mana** (v1 atau v2).

**API pons yang didokumentasikan** (di `llms.txt`; **404** saat dicoba dari sesi ini — mungkin butuh header/kunci,
atau sedang "upgrading the backend ahead of a new rollout"): `/api/pons-launches`, `/api/pons-token/{token}`,
`/api/pons-market/{token}` di host `ponsfamily.com`. Kontak integrasi resmi:
**[redacted]** ("We offer hands-on support for teams integrating pons").

**Bagian dokumen yang menjawab sisa F6/F8** (ada di halaman, tapi terpotong oleh batas tool):
`Network`, `Contracts`, `Onchain events`, `Claiming fees` (v2), `Events to index` (v2), `Reading state`.

**Bukti tambahan dari chain (29 Okt, bukan dari dokumen):**
- Source `PonsLaunchLocker.sol` **terverifikasi** di Blockscout: locker **tidak punya** fungsi penarikan
  posisi / arbitrary-call (likuiditas benar-benar terkunci), dan menyimpan `feeRedirects[token]`,
  `tokenProtocolFeeShares[token]`, `feeCollectors[address]`, `deployerTokens[deployer]`.
- **Fungsi claim = `collectFees(address token)`** (`methodId 0xa480ca79`), terlihat di riwayat tx locker:
  dipanggil berulang oleh satu alamat non-kontrak `0xee4EA69dcc75A9d8dd86309A95bDbA4750CED4B6`
  (collector pons sendiri, ~186k–265k gas per token per panggilan, gas 0,02 gwei jadi ≈0,0000037 ETH).
- Event `FeesClaimed(token, caller, token0, token1, recipientAmount0, recipientAmount1, protocolAmount0, protocolAmount1)`
  → **fee creator dibayar di DUA aset**: `token0/token1` = pasangan pool, jadi **memecoin + WETH**,
  bukan WETH saja. Contoh nyata (token "Thinking Cat"/HMM `0x7FE995a8…CD87f`): transfer keluar dari
  `PonsLaunchLocker` ke collector sebesar **109,828… HMM** dan **47,069… HMM** dalam satu tx (sisi token).
- `from` tx di atas = collector pons, dan error `NotDeployer()` ada di kontrak → **yang boleh memicu
  collectFees adalah deployer token atau fee collector yang di-otorisasi**. Rekomendasi: launch token
  memakai **wallet platform** (atau set `feeRedirects`/fee wallet ke wallet platform) supaya bagian
  creator masuk ke wallet yang sama dengan yang membayar hadiah.

### 2c. Network Robinhood Chain (terverifikasi 2026-10-29)
Sumber: `robinscanner.com/network` (mengutip halaman resmi Robinhood "About Robinhood Chain" +
"Connecting to Robinhood Chain"), `chainlist.org/chain/4663`, `robinhoodchain.blockscout.com/api/v2/*`.

> "Robinhood Chain is a permissionless, Ethereum-compatible Layer 2 built with Arbitrum technology.
> It settles to Ethereum, uses Ethereum blobs for data availability, and uses **ETH as its native gas token**."

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | **4663** | **46630** |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Sequencer | `https://sequencer.mainnet.chain.robinhood.com` | — |
| Sequencer feed (WS) | `wss://feed.mainnet.chain.robinhood.com` | — |
| Explorer | `robinhoodchain.blockscout.com` · `robinscanner.com` | `explorer.testnet.chain.robinhood.com` |

Angka live dari Blockscout (29 Okt): block time **~101 ms**, gas ~**19,6 Gwei**, ETH ≈ $2.306,
total blok **100.727.xxx**, transaksi **1,07 miliar**, alamat **30,2 juta**.

**Strategi RPC untuk aplikasi ini (jawaban "kayak Helius tapi free"):**
1. **Tidak perlu akun sama sekali** untuk mulai: RPC publik di atas gratis (chain-nya permissionless).
   Pakai itu sebagai `CHAIN_RPC_URL` server **dan** `NEXT_PUBLIC_CHAIN_RPC_URL` wallet.
2. **Akun free-tier provider EVM (Alchemy / QuickNode / Infura / Ankr / dRPC / thirdweb / Moralis /
   Blockdaemon / Nodies / PublicNode)** berguna kalau kena rate limit. **Wajib cek dulu apakah chain
   4663 ada di daftar chain mereka** — chain ini baru, jadi jangan asumsikan. Daftar RPC yang
   terdaftar ada di `chainlist.org/chain/4663` (tabelnya di-render JS, buka di browser).
3. **Yang harus dipenuhi provider** (checklist sebelum bikin akun): `eth_call`, `eth_getBalance`,
   `eth_getBlockByNumber`, `eth_estimateGas`, `eth_feeHistory`, `eth_sendRawTransaction`,
   `eth_getTransactionReceipt`, `eth_getLogs` **rentang lebar**, dan sebaiknya WS + archive.
4. **Holder TIDAK perlu `eth_getLogs`** (lihat di bawah) → range limit bukan faktor penentu lagi,
   jadi free tier biasa sudah cukup.

**Cara ambil holder di EVM (pengganti `getProgramAccounts`) — sudah diuji live:**
- `GET https://robinhoodchain.blockscout.com/api/v2/tokens/{token}` → `decimals`, `total_supply`,
  `holders_count`, `type: "ERC-20"` (tanpa kunci, gratis).
- `GET …/api/v2/tokens/{token}/holders` → `items[] { address.hash, address.is_contract, value }`,
  **50 per halaman**, lanjut lewat `next_page_params { value, address_hash, items_count }`.
- Bukti pada reference token PONS `0x39dB…4571`: ERC-20, **18 desimal**, supply **1 miliar**,
  **`holders_count` 105.124**.
- **Tiga temuan desain dari data itu:**
  1. Halaman **terurut saldo menurun** → `listHolders()` boleh **early-exit** begitu sebuah halaman
     di bawah `MIN_TOKEN_ELIGIBLE`; untuk token dengan 105 ribu holder ini memangkas ribuan request.
  2. Top holder token nyata = `0x000…dEaD` (burn) dan wallet bursa (Gate.io, Safe, dsb.) → **F12
     nyata**: exclusion list harus menangkap burn address, wallet bursa, pool/LP, dan vault launchpad.
  3. `address.is_contract` memberi deteksi otomatis kandidat venue (pool/vault kontrak) — di Solana
     ini dilakukan dengan heuristik PDA.
- Cadangan kalau API dibatasi: `eth_getLogs` ERC-20 `Transfer` (agregasi per alamat) atau RPC indexer.
- **Catatan jujur:** kita belum tahu rate limit API publiknya. Karena itu `syncHolders` tetap 5 menit
  tapi dengan cache + early-exit, dan harus ada fallback ke `eth_getLogs`.

**Hasil uji akses RPC dari mesin ini (2026-10-29) — penting sebelum Anda bikin akun:**

| Endpoint | Hasil dari mesin kerja ini |
|---|---|
| `rpc.mainnet.chain.robinhood.com` (resmi) | ❌ DNS resolve ke `158.140.186.3`, tapi **TCP :443 TIMEOUT/diblokir** (sementara `blockscout`/`robinscanner` justru nyambung → jaringan ini memang memblokir host itu, bukan internet mati) |
| `robinhoodchain.blockscout.com/api/eth-rpc` | ⚠️ **Ada** (proxy JSON-RPC gratis) tapi **HTTP 429 rate-limited** → cukup untuk baca sesekali, **tidak** untuk polling 15 detik + kirim payout |
| `robinhoodchain-rpc.publicnode.com` | ❌ 404 |
| `robinhood-chain.drpc.org` / `robinhoodchain.drpc.org` | ❌ 404 |
| `rpc.ankr.com/robinhood_chain` | ❌ 403 |
| `robinhoodchain.rpc.thirdweb.com` | ❌ host hidup tapi `-32001 Invalid chain` (belum terdaftar) |
| `robinhood-mainnet.public.blastapi.io` | ❌ DNS tidak ada |

Kesimpulan: **jangan berlangganan apa pun dulu.** Uji RPC publik resmi dari mesin/VPS Anda; kalau
kena blokir atau limit, baru ambil akun free-tier (Alchemy / QuickNode / Infura / dRPC / Ankr /
Moralis / Nodies / Blockdaemon / GetBlock) — **dan pastikan chain 4663 terdaftar di provider itu**
(daftar yang benar-benar terdaftar terlihat di `chainlist.org/chain/4663`, tabelnya JS jadi harus
dibuka di browser).

Perintah uji cepat (ganti `$RPC`):
```powershell
curl.exe -s -X POST $RPC -H "content-type: application/json" `
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# harapan: {"jsonrpc":"2.0","id":1,"result":"0x1237"}   (0x1237 = 4663)
```

**RPC final yang dipilih: Alchemy (29 Okt 2026). Bukti:**
- `https://robinhood-mainnet.g.alchemy.com/v2/<key-salah>` → **HTTP 401**
  `{"error":{"code":-32600,"message":"Must be authenticated!"}}` → host + network slug valid, yang salah hanya kuncinya.
- `robinhood-mainnet.g.alchemy.com` resolve ke IP Alchemy (`63.254.163.69/122/123`).
- Slug lain (`robinhoodchain-mainnet.g.alchemy.com`, `robinhood-chain-mainnet.g.alchemy.com`) **DNS tidak ada** → slug yang benar **`robinhood-mainnet`**.

**Cara mengambil URL:** dashboard Alchemy → *Create app* → pilih network **Robinhood Chain (mainnet)** → copy
HTTPS URL. Bentuknya: `https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>`.

**Env yang diisi (nama baru dari §3, alias lama belum dipakai):**
```
CHAIN_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<KEY_SERVER>
NEXT_PUBLIC_CHAIN_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<KEY_BROWSER>
```
- **Keamanan:** `NEXT_PUBLIC_*` ikut ter-bundle ke browser. Pakai **dua key terpisah** dan batasi key
  browser dengan **origin allowlist** domain produksi di dashboard. (Proyek ini sudah punya pola
  serupa: `NEXT_PUBLIC_SOLANA_RPC_URL` memuat key Helius.)
- **Kuota:** free tier dihitung compute-unit per bulan. Beban kita sengaja kecil — holder sync **tidak**
  lewat RPC (Blockscout), `/api/status` + `/api/wallets` sudah di-cache 15 s, payout ~1 tx/jam. Kalau
  kena limit, fallback ke RPC publik resmi (simpan sebagai komentar di `.env`).
- **Uji dari VPS** sebelum produksi (mesin yang benar-benar menjalankan app).

**Checklist Fase 2a (read-only, tanpa dana) — jalankan begitu 1 RPC hidup:**
1. `eth_chainId` harus `0x1237` (4663) — kalau bukan, kunci/URL salah chain.
2. `eth_blockNumber` + `eth_feeHistory` → tahu biaya gas nyata untuk estimasi payout.
3. `eth_call` pada token: `decimals()` dan `totalSupply()` (uji dengan reference token PONS `0x39dB…4571`).
4. `eth_getBalance` wallet platform → ganti `computePrizePool()` dari `getBalance` Solana ke adapter.
5. `eth_getLogs` rentang kecil → mengukur batas range yang diizinkan Alchemy (bukan jalur utama, hanya cadangan).
6. Bandingkan jumlah holder dari Blockscout (`holders_count`) dengan hasil walk halaman + early-exit.

---

### 2d. Yang WAJIB di-set ulang saat pindah chain (bukan find-replace)

| Item | Nilai Solana (sekarang) | Untuk Robinhood Chain | Kenapa |
|---|---|---|---|
| `MIN_TOKEN_ELIGIBLE` (env **dan** row DB) | `1000000000000` (1e12, token 6dp) | **`1e18`–`1e21`** | di token 18dp, 1e12 = **0,000001 token** → ambang nyaris mati, dust wallet ikut masuk |
| `TOKEN_DECIMALS` | `6` | **`18`** | format manusia di `/api/status` + `/eligibility` |
| `PRIZE_RESERVE_LAMPORTS` → `PRIZE_RESERVE_WEI` | `50000000` (0,05 SOL) | **`5e16`** (0,05 ETH) | ✅ sudah otomatis (config chain-aware) |
| `MAX_PRIZE_SOL` / `MIN_PRIZE_SOL` | `1` / `0` | `MAX_PRIZE_NATIVE` / `MIN_PRIZE_NATIVE` | Fase 5 |
| `TOKEN_MINT` → `TOKEN_ADDRESS` | base58 | `0x…` | ✅ adapter sudah baca `TOKEN_ADDRESS` |

### 2e. Holder di chain ini **wajib** lewat indexer (analisis dari data live)

Block time Robinhood Chain **≈101 ms** → sekitar **855.000 blok/hari**, jadi `eth_getLogs` tidak bisa
jadi sumber holder utama:

| Pendekatan | Rentang log | Request untuk 1 hari blok | Layak? |
|---|---|---|---|
| Alchemy **free** | 10 blok/request (terverifikasi) | ~85.500 | ❌ |
| Alchemy **PAYG** | ~2.000 blok/request (perlu konfirmasi) | ~430 | ✅ realistis |
| Blockscout `/holders` (gratis) | n/a — sudah ter-index | 1 request/halaman × (holder/50) | ✅ tapi instance publik membatasi |

Urutan opsi produksi: (1) indexer gratis (Blockscout) dengan cache + jadwal jarang, (2) provider berbayar
(PAYG log range atau indexer API), (3) **indexer sendiri** yang mengekor blok sejak block launch token
(butuh log range ≥ ~2.000 blok), (4) minta akses API resmi ke tim pons (`[redacted]`).
Catatan penting: VPS produksi adalah **IP datacenter** — besar kemungkinan juga kena throttle Blockscout
seperti mesin dev ini, jadi (2)/(3) sebaiknya disiapkan sebelum promosi.

---

### 2f. Skema DB diperlebar ke `numeric` — WAJIB, sudah dikerjakan 2026-10-29

Kolom amount dulu `bigint` (int8, maks **9,22e18**), sedangkan saldo mentah token 18 desimal
mencapai **1e27** → `npm run holders:sync` **gagal** dengan
`Could not convert argument value Object {"$type":"BigInt", …}`. Dibuktikan dengan probe: insert
`9.223.372.036.854.775.807` **OK**, insert `7,97e26` **GAGAL**.

**9 kolom** diubah ke `Decimal @db.Decimal(78, 0)` (= Postgres `numeric`):

| Tabel | Kolom |
|---|---|
| `HolderSnapshot` | `amount` |
| `LotteryRound` | `prizePoolLamports`, `minTokenEligible`, `payoutFeeLamports`, `platformFeeLamports` |
| `Winner` | `amountLamports` |
| `CreatorFeeClaim` | `amountLamports`, `pumpLamports`, `pumpSwapLamports` |

Cara diterapkan (tanpa prompt interaktif, tanpa data loss): `prisma migrate diff
--from-schema-datasource … --to-schema-datamodel … --script` → SQL `ALTER COLUMN … SET DATA TYPE
DECIMAL(78,0)` → `prisma db execute --file …` → `migrate diff` ulang = **"empty migration"**.

**Jebakan kedua yang ketemu saat verifikasi:** `Prisma.Decimal.toString()` beralih ke **notasi
eksponen** di atas 21 digit (`7.97063843490960830516755487e+26`), sehingga `BigInt(value.toString())`
**melempar error**. Karena itu `src/lib/db-amount.ts` memakai `toFixed(0)`:

- `toBigInt(v)` — baca kolom → bigint (aman untuk Decimal, string, int8 lama).
- `toBaseUnitString(v)` — untuk payload JSON/UI; **jangan** pakai `.toString()` langsung.
- `toDecimalValue(v)` — bigint/number → string untuk ditulis ke kolom Decimal.

Titik kode yang disesuaikan (semua lolos `tsc`): `engine.ts` (pool/min-eligible/winner/fee ditulis
sebagai string, `getEligibleHolders` baca via `toBigInt`), `sync.ts` (tulis string), `format.ts`
(`lamportsToSol`/`formatSol`/`formatTokenAmount`/`fmtTokenHuman` menerima Decimal),
`db-amount.ts` (baru), `chain/robinhood.ts` (tidak berubah), `telegram-bot.ts` (`toBigInt` lokal
diperlebar + normalisasi di `toDrawSnapshot`), `api/{status,rounds,rounds/[n],holders,eligibility,
wallets,treasury/ledger,admin/holders,admin/exclusions,admin/info}`, `pumpfun/creator-fees.ts`
(`serializeClaim` + penulisan claim).

**Hasil uji ulang (stub indexer berisi data asli NIGHT):** `npm run holders:sync` → **exit 0**,
`11 of 19 holders in 1 request(s) (truncated: eligibility floor / page cap reached)`; baca balik dari
Neon: **11 baris**, nilai terbesar **797063843490960830516755487** round-trip persis, `holders total`
**16** (5 Solana + 11 EVM berdampingan). Early-exit terbukti nyata: holder ke-12 (483.813.813 wei <
`MIN_TOKEN_ELIGIBLE` 1e12) menghentikan walk.

---

## 3. Kontrak env baru (nama lama tetap jalan sampai Fase 5)

| Lama (Solana) | Baru (netral) | Default sekarang | Catatan |
|---|---|---|---|
| `SOLANA_RPC_URL` | `CHAIN_RPC_URL` | — | server-side |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `NEXT_PUBLIC_CHAIN_RPC_URL` | — | wallet client |
| `SOLANA_NETWORK` | `CHAIN_NETWORK` | `mainnet` | `mainnet`/`devnet` → nanti `mainnet`/`testnet` |
| `TOKEN_MINT` | `TOKEN_ADDRESS` | — | base58 → `0x…` |
| `TOKEN_DECIMALS` | (tetap) | `6` | token, bukan gas |
| `PLATFORM_WALLET_SECRET` | `PLATFORM_WALLET_PRIVATE_KEY` | — | base58/JSON → `0x…` |
| `PRIZE_RESERVE_LAMPORTS` | `PRIZE_RESERVE_WEI` | `50000000` | **unit gas-nya berubah** (1e9 → 1e18) |
| `MAX_PRIZE_SOL` / `MIN_PRIZE_SOL` | `MAX_PRIZE_NATIVE` / `MIN_PRIZE_NATIVE` | `0` | string angka |
| `HELIUS_API_KEY` | (hapus) | — | khusus Solana |
| `PUMPFUN_API_BASE` | `LAUNCHPAD_API_BASE` | `https://pumpdev.io` | pindah ke chain baru |
| — | `NEXT_PUBLIC_CHAIN` | `solana` | `solana` \| `robinhood` |
| — | `NEXT_PUBLIC_NATIVE_SYMBOL` | `SOL` | label UI |
| — | `NEXT_PUBLIC_NATIVE_DECIMALS` | `9` | `18` untuk EVM |
| — | `NEXT_PUBLIC_EXPLORER_URL` | `""` | host explorer chain baru |
| — | `HOLDER_SOURCE` | `rpc` | `rpc` \| `indexer` |

Aturan transisi: kode membaca **nama baru dulu, lalu lama** (alias), jadi `.env` lama
tidak perlu diubah selama Fase 1–4 dan rollback cukup menghapus nama baru.

**Keadaan `.env` per 29 Okt 2026 (sudah dirapikan):** 32 key aktif + 5 key dikomentari, dibagi 5 section:
**1. Chain** (pilih `NEXT_PUBLIC_CHAIN`, RPC, token, wallet platform EVM), **2. Lottery settings**
(chain-neutral; `MAX_PRIZE_SOL`/`MIN_PRIZE_SOL` sudah **di-rename** jadi `MAX_PRIZE_NATIVE`/
`MIN_PRIZE_NATIVE` — kode masih membaca nama lama sebagai fallback), **3. Database**, **4. Admin**,
**5. SOLANA / PUMP.FUN (LEGACY)** yang **bisa dihapus sebagai satu blok** setelah cutover.
Key yang belum dibaca kode (disiapkan, dikomentari): `NEXT_PUBLIC_CHAIN_RPC_URL` (wallet provider EVM,
Fase 3), `CHAIN_INDEXER_URL` (default Blockscout), `PLATFORM_TREASURY_PRIVATE_KEY`, `PRIZE_RESERVE_WEI`,
`HOLDER_SYNC_MAX_PAGES`.

**Yang membuat blok Solana dulu tidak bisa dibuang — dan sudah diperbaiki:** `getConfig()` **mewajibkan**
`SOLANA_RPC_URL` + `TOKEN_MINT` + `PLATFORM_WALLET_SECRET` di chain apa pun, dan engine mengambil alamat
platform lewat `getPlatformKeypair()` (kunci Solana). Sekarang:
- `getConfig()` memilih key wajib sesuai chain (`CHAIN_RPC_URL`/`TOKEN_ADDRESS`/`PLATFORM_WALLET_PRIVATE_KEY`
  di EVM; `platformWalletSecret` sengaja kosong di EVM agar pemanggil Solana-only gagal keras, bukan
  menandatangani dengan sampah), `TOKEN_DECIMALS` default 6 (Solana) / 18 (EVM).
- **`getChain().platformAddress()`** (`types.ts` + kedua adapter) menggantikan
  `getPlatformKeypair().publicKey.toBase58()` di 6 tempat: `engine.computePrizePool`, daftar exclusion
  engine, `/api/status`, `/api/holders`, `/api/admin/holders`, `/api/rounds/[n]`, `telegram-bot`.
Sisa pemakai Solana-only yang **belum** dipindah (aman karena hanya jalan di chain Solana):
`distributePayouts`/`buildFeeTransfer` di engine, `pumpfun/creator-fees.ts`, saldo di
`api/admin/info` + `telegram-bot`, dan wallet provider client.

---

## 4. Fase

### Fase 0 — fakta (tabel §2) · *blocking*
Deliverable: tabel §2 terisi. Verifikasi: `getChain()` bisa dites dengan adapter dummy.

### Fase 1 — lapisan abstraksi chain · **SELESAI 2026-10-29**
Deliverable (detail di §7): `src/lib/chain/network.ts`, `types.ts`, `solana.ts`, `index.ts`
+ seam di `format.ts`, `api/wallets`, `api/status`, `sync.ts`, `exclusions.ts`.
Verifikasi: `npx tsc --noEmit` **0 error**; semua route **200**; label unit tetap "SOL";
`GET /api/status` + `/api/wallets` sekarang membawa `chain:"solana"` + `nativeSymbol:"SOL"`.

### Fase 2 — adapter Robinhood (server) · butuh F1–F8, F11, F12
1. Pakai **viem** (bukan ethers) — tidak butuh polyfill Buffer.
2. `src/lib/chain/robinhood.ts` implement `ChainAdapter`.
3. **`sendPayouts()` masuk ke kontrak** (sengaja belum ada di Fase 1): bentuknya
   mengikuti F7 — native = 1 tx untuk semua pemenang atau batcher; ERC-20 = `transfer`
   per pemenang + estimasi gas. Fee sweep platform ikut di sana.
4. Holder: sesuai F6 (`eth_getLogs` per-chunk + agregasi per alamat, atau indexer).
5. Daftarkan di `ADAPTERS` (`src/lib/chain/index.ts`) — `getChain()` otomatis memilih.
6. **Payout engine:** bagian Solana dari `distributePayouts` (`lottery/engine.ts`)
   dipindah ke `chain/solana.ts` sebagai `sendPayouts()`, lalu engine memanggil adapter;
   nonce/gas/receipt menggantikan blockhash + `broadcastUntilLanded`.
Verifikasi: dry-run 1 payout kecil di testnet (F10) dengan `LOTTERY_CRON_ENABLED=false`,
cocokkan saldo sebelum/sesudah, dan `payoutTx` bisa dibuka di explorer baru.

### Fase 3 — client: wallet + label
1. `src/components/providers/WalletProvider.tsx`: wagmi/RainbowKit atau injected connector (F9).
2. ~60 tempat yang menulis "SOL" → `NATIVE_SYMBOL` (termasuk label admin, tooltip, `og.png`).
3. `RecentDraws.tsx`, `DrawsList.tsx`, `HoldersBrowser.tsx` membuang salinan lokal
   `explorer()` dan memakai `explorerUrl()` dari `@/lib/format`.
4. Validasi form pakai `looksLikeChainAddress()` (klien); server tetap `normalizeAddress()`.
Verifikasi: `tsc` 0, semua route 200, connect wallet nyata (F9), grep "SOL" di `src/` bersih.

### Fase 4 — creator fees launchpad baru
`pumpfun/creator-fees.ts` → `launchpad/creator-fees.ts`: snapshot, cost math (gas, bukan
lamports/rent), claim; state machine tabel `CreatorFeeClaim` dipertahankan apa adanya.
Verifikasi: claim kecil di testnet + baris DB `pending → confirmed`, kartu Admin → Creator
Fees menampilkan angka benar.

### Fase 5 — skrip, nama, dokumentasi
`airdrop.ts`, `checkPlatformWallet.ts`, `setupDevnetToken.ts` versi chain baru; `netTest.ts`
probe host baru; rename kolom DB (`*Lamports` → `*Wei`) **hanya** kalau mau migration
Prisma; update `HANDOFF.md`, `DEPLOY-VPS.md`, `PROJECT_CONTEXT.md`, dan `og.png` kalau
simbol gasnya berubah.

### Fase 6 — build & deploy
`pm2 stop` → `rm -rf .next/cache` → `npm run build` → `pm2 start`, lalu cek 4 halaman publik
+ `/verify` harus tetap lolos dua ceknya. **Hanya jalan setelah Anda bilang gas.**

---

## 5. Peta file (siapa yang disentuh di fase mana)

| File | Fase | Perubahan |
|---|---|---|
| `src/lib/chain/network.ts` | 1 ✅ / 2 | identitas chain (client-safe); isi cabang `robinhood` dari F3/F4 |
| `src/lib/chain/types.ts` | 1 ✅ / 2 | kontrak; Fase 2 menambah `sendPayouts()` |
| `src/lib/chain/solana.ts` | 1 ✅ / 2 | delegasi Solana; Fase 2 memindahkan `distributePayouts` ke sini |
| `src/lib/chain/index.ts` | 1 ✅ / 2 | `getChain()`; Fase 2 daftarkan adapter baru |
| `src/lib/chain/robinhood.ts` | 2 | **baru** — viem, holder, payout, validasi EIP-55 |
| `src/lib/format.ts` | 1 ✅ / 3 | unit + explorer sudah lewat chain layer (nama fungsi dirapikan Fase 3) |
| `src/lib/sync.ts` | 1 ✅ | pakai `getChain().listHolders()` |
| `src/lib/exclusions.ts` | 1 ✅ / 2 | `normalizeAddress()` lewat adapter; PDA venue → venue baru (F12) |
| `src/app/api/wallets/route.ts` | 1 ✅ | saldo lewat adapter + field `chain`/`nativeSymbol` |
| `src/app/api/status/route.ts` | 1 ✅ | field `chain`/`nativeSymbol` (additive) |
| `src/app/api/admin/info/route.ts` | 2 | `getConnection().getBalance` → adapter |
| `src/lib/lottery/engine.ts` | 2 | `distributePayouts` → `sendPayouts()` adapter |
| `src/lib/pumpfun/creator-fees.ts` | 4 | → `launchpad/creator-fees.ts` (API + gas, bukan rent/lamports) |
| `src/lib/telegram-bot.ts` | 2–3 | saldo platform + copy "SOL" + link explorer |
| `src/components/providers/WalletProvider.tsx` | 3 | wallet EVM |
| `RecentDraws/DrawsList/HoldersBrowser/admin/home/holders page/ExclusionsCard.tsx` | 3 ✅ | ✅ **6 salinan lokal `explorer()` sudah dibuang (29 Okt)** — semuanya delegasi ke `explorerUrl()` |
| `src/scripts/*`, `netTest.ts` | 5 | Keypair/Connection/spl-token → versi chain baru |
| `src/lib/config.ts` | 2 / 5 | baca nama env baru dengan alias lama; parsenya `0x…` |
| `og.png` + `SEO_*` copy | 3 | simbol gas, kalau bukan "SOL" |
| `PROJECT_CONTEXT.md`, `HANDOFF.md`, `DEPLOY-VPS.md`, file ini | tiap fase | state + setup + deploy |

**Tidak disentuh:** `src/lib/lottery/verify.ts`, `src/lib/solana/randomness.ts` (drand),
`src/lib/buyback*.ts` (data JSON), seluruh UI HeroUI, admin panel non-chain, SEO/font/palette,
Prisma schema (kecuali rename opsional di Fase 5).

---

## 6. Register risiko (berurut)

1. **Daftar holder (F6).** Solana: satu `getProgramAccounts`. EVM: `eth_getLogs` dibatasi
   range/limit per provider; kalau RPC tidak bisa seluruh rentang, wajib indexer/launchpad API.
   Salah di sini = draw tanpa daftar pemain.
2. **Jumlah tx payout (F7).** ERC-20 = 1 tx per pemenang (gas × N) → janji "one atomic
   payout tx" di `/treasury` + `/how-it-works` tidak lagi benar; copy wajib diubah.
3. **Claim creator fee (F8).** Beda total: nonce, EIP-1559, receipt; tidak ada
   `rent-exempt`. Semua teks error di `creator-fees.ts` ditulis ulang.
4. **Satuan gas (F3/F11).** `PRIZE_RESERVE_LAMPORTS` bernilai 5e7: di EVM itu 0,00000000005
   wei-equivalent — harus 1e18-an, bukan angka lama. Ini kesalahan yang bisa mengirim dana
   tidak sengaja, jadi dikerjakan di Fase 2 bersama adapter.
5. **Label chain di ~60 file.** Bukan sulit, butuh disiplin (dan sapu akordeon gaya
   `.tmp-*` dihapus setelah dipakai).
6. **Testnet (F10).** Kalau tidak ada, dry-run Fase 6 harus pakai mainnet dengan nominal
   1 unit terkecil dan `LOTTERY_CRON_ENABLED=false`.
7. **v1 vs v2 pons (baru, dari §2b).** Dua stack hidup berdampingan dan dokumennya menyuruh
   *"resolve a token's stack from the factory that launched it"*. Kalau token Anda lewat pons v2,
   cara token itu trade (bonding curve → Uniswap v4) dan cara creator dibayar berbeda dari v1 —
   dan **public launching v2 sedang DITUTUP** (`canLaunch(address)`), jadi alur "Create a token"
   bisa saja tidak tersedia untuk Anda hari ini.
8. **Prize asset ≠ gas asset (baru).** v2 mengizinkan **custom pairs**: launch bisa di-quote USDG
   atau saham tokenized, dan *"the creator is paid in it"*. Adapter sekarang hanya punya
   `NATIVE_SYMBOL`/`NATIVE_DECIMALS` (gas); Fase 2 harus menambah **`prizeAsset`** (alamat ERC-20 +
   desimal) supaya hadiah, tooltip, dan `sendPayouts()` tidak mencampur gas dengan hadiah.
9. **Creator fee bukan "pot" (baru).** Di pons, fee = **liquidity fee** (token + WETH) yang menumpuk
   di posisi terkunci lalu dibagi lewat **locker**, bukan saldo yang bisa ditarik seperti pump.fun.
   Artinya `pumpfun/creator-fees.ts` (759 baris) **ditulis ulang**, bukan diadaptasi — dan tile
   "Unclaimed fees" di homepage bisa sementara tidak bermakna sampai Fase 4 selesai.
10. **API pons publik 404 (baru).** Endpoint di `llms.txt` mengembalikan 404 dari sesi ini; jalur
    resminya adalah menghubungi `[redacted]` (mereka menawarkan bantuan integrasi).
11. **Alchemy free tier: `eth_getLogs` maks 10 blok per request** (terverifikasi: pesan error resmi
    menyuruh upgrade ke PAYG). Artinya indexer (Blockscout) **wajib** untuk holder; log bukan cadangan
    yang praktis di tier gratis. Kalau Blockscout diblokir, opsinya: PAYG Alchemy, RPC provider lain
    (QuickNode/dRPC/dll), atau jalankan indexer sendiri.
12. **Blockscout publik memblokir host yang burst (HTTP 403).** Setelah beberapa panggilan + satu 429
    dari `/api/eth-rpc`, endpoint `/api/v2/*` menolak **semua** User-Agent dari host ini (dites: UA
    `node`, UA bot, UA browser → 403 semua). Kode: retry sekali (delay 4 s) untuk 403/429, lalu
    `syncHolders` gagal-soft (snapshot lama dipertahankan). Untuk produksi jangan bergantung pada
    instance publik — siapkan RPC/indexer berbayar atau sendiri.
13. **F11: platform wallet harus kunci EVM.** Selama `PLATFORM_WALLET_SECRET` masih kunci Solana
    (base58/JSON 64 byte), `getNativeBalance()` pada adapter Robinhood menolak dengan pesan yang
    menyebut F11 — jangan tunggu sampai payout, karena `computePrizePool()` juga memakainya.

---

## 7. Log Step 1 (2026-10-29)

Dibuat: `src/lib/chain/network.ts` (chain kind, `NATIVE_SYMBOL`, `NATIVE_DECIMALS`,
`BASE_UNITS_PER_NATIVE`, `explorerLink()`, `looksLikeChainAddress()`),
`src/lib/chain/types.ts` (kontrak `ChainAdapter`), `src/lib/chain/solana.ts`
(delegasi tipis ke kode yang sudah ada), `src/lib/chain/index.ts` (`getChain()` — melempar
error jelas kalau chain dipilih tapi adapter belum ada, bukan diam-diam pakai Solana).

Disambungkan (perilaku identik): `format.ts` (`lamportsToSol`/`solToLamports` pakai
`BASE_UNITS_PER_NATIVE`, label unit dari `NATIVE_SYMBOL`, `explorerUrl()` delegasi ke
`explorerLink()`, dan **import `@solana/web3.js` dihapus** dari file ini), `sync.ts`
(`listHolders()`), `exclusions.ts` (`normalizeAddress()`), `api/wallets` (saldo + field
`chain`/`nativeSymbol`), `api/status` (field yang sama, additive).

Status: `npx tsc --noEmit` **0 error**; semua route **200**; `GET /api/status` dan
`/api/wallets` mengembalikan `chain:"solana"` + `nativeSymbol:"SOL"`; `npm run dev` log bersih.
Tidak ada perubahan perilaku yang terlihat pengguna: label tetap "SOL", link tetap Solscan.

Blocker berikutnya: **§2 F1–F8, F11, F12** (terutama F1, F6, F7, F8).

---

## 8. Log Fase 2a — adapter Robinhood read-only · **SELESAI 2026-10-29**

Kode: `src/lib/chain/robinhood.ts` (tanpa SDK: `fetch` + JSON-RPC + REST Blockscout),
`network.ts` (`CHAIN_ID`, `CHAIN_LABEL`, explorer default `robinhoodchain.blockscout.com`),
`index.ts` (adapter terdaftar), `types.ts` (`payoutsImplemented`, `listHolders(opts)`,
snapshot `truncated`/`pagesFetched`), `config.ts` (reserve chain-aware: EVM baca
`PRIZE_RESERVE_WEI`, default **0,05 ETH**), `sync.ts` (kirim `minBalance` + `maxPages`, log
`x dari y holder`), `engine.ts` (**pagar**: `payoutsImplemented === false` → tolak **sebelum**
baris round dibuat).

| Uji (RPC Alchemy dari `.env`) | Hasil |
|---|---|
| `eth_chainId` / `net_version` | `0x1237` / **4663** ✅ |
| `web3_clientVersion` | `nitro/v3.12.1+70fa99a-20260929` → konfirmasi Arbitrum Orbit ✅ |
| `eth_blockNumber` | `0x6015967` (≈100,75 juta blok) |
| `eth_gasPrice` / base fee | **0,020092 gwei** → transfer 21k gas ≈ 0,00000042 ETH (≈$0,001) |
| `eth_call` `decimals()` / `totalSupply()` PONS | **18** / **1e27** (1 miliar token) ✅ |
| `eth_getCode` PONS | 5.274 byte (kontrak nyata) ✅ |
| `eth_getTransactionReceipt` (launch tx PONS) | status `0x1`, block 8.963.150, gas 7.026.539 ✅ |
| `eth_getLogs` free tier | ❌ **maksimal 10 blok per request** → tidak bisa jadi jalur holder di tier gratis |
| Adapter via dev server | `kind=robinhood`, `chainId=4663`, `symbol=ETH`, `decimals=18`, `payoutsImplemented=false`, explorer Blockscout, `getNativeBalance`=0 wei ✅ |
| Walk holder (upstream di-stub) | 3 request (info + 2 halaman), **halaman ke-3 tidak diminta** (early-exit), 80 holder, `truncated=true`, cursor diteruskan, alamat lowercase ✅ |
| Pagar engine (`npm run lottery:run`, `NEXT_PUBLIC_CHAIN=robinhood`) | exit 0, pesan jelas, `roundNumber: 0`, **total round tetap 20** (tidak ada baris DB) ✅ |
| Mode default Solana | `/api/status` → chain `solana`, pool 0; `/api/wallets` → 0,001295 SOL; `/draws` + `/verify` 200 ✅ |

**Gotcha yang ditemukan & diperbaiki:** `import "server-only"` di `chain/*` **memecahkan semua
script tsx** (`npm run lottery:run` → `MODULE_NOT_FOUND`; paket `server-only` tidak ada di
`node_modules`, Next meng-alias-kannya). Chain layer sekarang "server-only by contract" lewat
komentar, dan `network.ts` tetap satu-satunya pintu client-safe.

**Blocker berikutnya:** **F11** (platform wallet harus kunci EVM `0x…`; selama masih kunci Solana,
`/api/status` + `/api/wallets` menolak dengan pesan yang menyebut F11), **F7** (mata uang hadiah),
**F8** (claim fee pons), plus **403 sementara** dari Blockscout untuk host mesin ini (cooldown).

---

## 9. Log Fase 2b — payout EVM (`sendPayouts`) · **SELESAI 2026-10-29**

Keputusan pemilik: hadiah dibayar **ETH native dari platform wallet** (diisi manual), dan
**auto-claim creator fee dilewati** untuk sekarang (manual dulu).

Kode: `src/lib/chain/types.ts` (kontrak `sendPayouts?` + `payoutsImplemented`), `chain/robinhood.ts`
implementasi **viem** — `defineChain(4663)`, `privateKeyToAccount`, **satu tx per pemenang**,
`gas`/`gasPrice`/`nonce` **eksplisit** (tidak bergantung `eth_estimateGas`, yang mengembalikan hasil
kosong di Alchemy untuk chain ini), 1,5× headroom harga gas, penerima **berkontrak** dapat 80k gas
(EIP-7702 smart wallet adalah holder nyata di sini), `waitForTransactionReceipt` polling 500 ms,
`payoutsImplemented: true`. `lottery/engine.ts` bercabang: kalau `chain.sendPayouts` ada → jalur EVM,
kalau tidak → jalur Solana lama (`distributePayouts`) **tidak diubah sama sekali**.

Bukti (tanpa verifikasi browser, sesuai permintaan):
- `npx tsc --noEmit` **0 error**; `npm run build` **✓ compiled 10,0s / TS 6,2s / 12/12 statis**, 0 warning, BUILD_ID **`G30xvhiifi-bNru6kdl4G`**.
- Probe payout: `kind=robinhood`, `nativeSymbol=ETH/18`, `payoutsImplemented=true`, `sendPayouts` ada → tx **dibangun, ditandatangani, dikirim**, dan ditolak node dengan *"The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account"* (saldo wallet masih 0 ETH) ⇒ nonce/gas/sign/broadcast terbukti, **tanpa dana terpakai**.
- `npm run lottery:run` (`NEXT_PUBLIC_CHAIN=robinhood`): pagar **terbuka** (round #21 dibuat), engine jalan tanpa error, skip dengan alasan jujur `0 eligible holders` — identik dengan kondisi Solana sekarang. DB rounds 20 → 21.

---

## 10. Log Fase 3 (label) + F12 (exclusion venue EVM) · **SELESAI 2026-10-29**

### F12 — venue exclusion otomatis (fairness)
Masalah: holder #1 token pons (termasuk token uji NIGHT) adalah kontrak **`PonsV2BondingCurve`** dengan
**79,7% supply**. Tanpa exclusion, bonding curve-lah yang menang lotre dan hadiah masuk ke kontrak yang
tak bisa menang. Di Solana ini diselesaikan dengan menderivasi PDA pump.fun; di EVM tidak ada PDA.

Solusi (struktural, bukan tebak-tebakan): **`classifyEvmHolder()`** di `chain/robinhood.ts` menandai
holder sebagai venue bila:
- **kontrak** (`is_contract`) dan **bukan EIP-7702** → bonding curve, pool, vault, exchange contract;
  label diambil dari nama kontrak terverifikasi (mis. `PonsV2BondingCurve`),
- **burn address** (`0x…dEaD`) atau **zero address**.

EIP-7702 sengaja **tetap eligible** — itu wallet user asli (dua holder NIGHT memakainya:
`SemiModularAccount7702`, `MultiSigWalletWithDailyLimit`). Plain EOA (termasuk hot wallet bursa) tetap
eligible, sama seperti perilaku produk di Solana; admin tetap bisa menambah manual.

Alur: `listHolders()` menandai `isVenue`/`venueLabel` → **`syncHolders()` menuliskan mereka ke tabel
`ExcludedWallet`** dengan label `auto · <nama>` (tanpa perubahan skema, tanpa kode per-chain di engine).
Efeknya **semua** permukaan otomatis ikut: hitungan eligible, engine, `/verify`, admin, `/eligibility`.
Selain itu `getVenueAccounts()` (PDA pump.fun) sekarang **return [] di chain non-Solana** supaya tidak
menyuntik alamat base58 tak bermakna ke tiap round.

Bukti:
- Probe klasifikasi dengan payload **asli** NIGHT: bonding curve → **EXCLUDED** (`PonsV2BondingCurve`),
  EIP-7702 → **eligible**, plain EOA → eligible, `0x…dEaD` → **EXCLUDED**, zero → **EXCLUDED**,
  kontrak tanpa nama → **EXCLUDED** (`contract holder`).
- Sync end-to-end (stub data asli + 1 baris burn sintetis): `12 of 19 holders in 1 request(s) · **2 venue(s) auto-excluded**`;
  baca-balik Neon → `0x0000…dead → auto · burn address` dan `0x0e86…86e4 → auto · PonsV2BondingCurve`.

### Fase 3 — label `SOL` → satuan chain (sebagian besar selesai)
Prinsip: label di UI memakai **`NATIVE_SYMBOL`** dari `@/lib/chain/network` (client-safe), jadi satu env
mengubah seluruh tampilan. Yang diubah (`SOL` → `{NATIVE_SYMBOL}`): `/` (5 titik: label unit, 2 kalimat
hero/CTA, tooltip pool, "Last claimed"), `/treasury` (header, `label="… spent"`, helper `fmtSolPrecise`),
`/how-it-works` (chip, judul step 5, paragraf pool/reserve, FAQ), `/stats` + layout metadata,
`DrawsList` (caption `… to winners`, pesan expiry), `HowItWorksFlow` ("paid in …"), `BuybackPanel`
(label/aria/spent), `CreatorFeesCard` (claimable/lose/non-quote), `admin` (`… paid out`).

**Copy yang WAJIB berubah karena EVM = 1 tx per pemenang** (bagian risiko #2 di §6) sudah dikerjakan
**chain-aware** di `/how-it-works`: step 5, paragraf fee ("fee stays on the project wallet" di EVM),
paragraf payout ("Each winner is paid with its own transfer"), dan FAQ — tinggal Solana yang masih
menyebut "one transaction".

**Yang sengaja belum**: identifier internal (`lamportsToSol`, `prizePoolSol`, kolom `*Lamports`),
`hint="MAX_PRIZE_SOL"` (nama env, ikut Fase 5), `components/icons/SolanaLogo.tsx` (**dead code**, tidak
diimpor siapa pun), `WalletProvider.tsx` (wallet Solana, menunggu keputusan F9), dan tile creator-fee
homepage yang masih menyebut pump.fun (Fase 4).

---

## 11. Isolasi chain di DB — bug "sync nangkep yang sol" · **SELESAI 2026-10-29**

**Gejala (dilaporkan pemilik):** `holders:sync` dan UI menampilkan holder **Solana** padahal sedang
menguji Robinhood.

**Sebab:** tabel `Holder` / `HolderSnapshot` **tidak punya dimensi chain**, dan "batch terbaru" dihitung
**global** (`orderBy: { capturedAt: "desc" }` tanpa filter). Dev server yang jalan di mode solana
menulis batch Solana **setiap 5 menit**, jadi setiap batch EVM tertimbun dalam < 5 menit. Bukti mentah
saat itu: 5 batch terakhir semuanya `jenis=sol`, alamat `CxQMJHPJ…`, n=1.

**Perbaikan:**
- `Holder.chain` + `HolderSnapshot.chain` (`String @default("solana")`) + index `(chain)` dan
  `(chain, capturedAt)`; diterapkan lewat `migrate diff --script` → `db execute` (ADD COLUMN dengan
  DEFAULT → **baris lama otomatis `solana`**, tanpa kehilangan data).
- `syncHolders` menstempel `chain: CHAIN_KIND` di kedua tabel.
- **17 titik baca** "batch terbaru" difilter `chain: CHAIN_KIND`: `engine.getEligibleHolders` +
  daftar exclusion engine, `/api/status` (+ `holder.count`), `/api/holders`, `/api/eligibility`
  (3 query), `/api/admin/holders` (+ count), `/api/admin/exclusions`, `/api/rounds/[n]` (2 query:
  `eligibleSnapshotCapturedAt` dan inferred-batch), `lib/telegram-bot.ts`.
- **Dua jebakan codemod yang ketemu dan dibereskan** (pengalaman untuk sesi berikutnya): repo ini
  **CRLF**, jadi regex dengan `\n` **gagal senyap** (pola `findFirst` tidak tersentuh di run pertama);
  dan penyisipan filter ke `where: { capturedAt: { lte: … } }` mendarat **di dalam** objek `capturedAt`
  (harus diperbaiki manual).

**Bukti:** batch Solana (`11:06:21`, n=1) **lebih baru** daripada batch Robinhood (`11:05:48`, n=12),
namun pembacaan per-chain tetap benar —
`solana batch=1 contoh=CxQMJHPJ` · `robinhood batch=12 contoh=0x0e8641, 0x000000, 0x356cc1` ·
dan "global terbaru tanpa filter = chain **solana** n=1" (inilah perilaku lama yang rusak).
Di level app: `/api/status` (mode solana) kini `totalHolders=1`, `knownHolders=1`, `configured=true`.
`tsc` **0 error**; `npm run build` ✓ compile **11,7s** / TS 6,7s / 12/12.

**Yang BELUM diisolasi (catat sebelum menjalankan draw di dua chain sekaligus):** `LotteryRound` dan
`Winner` tetap **tanpa kolom chain**, jadi draw Solana dan EVM akan bercampur di `/draws`, `/stats`, dan
agregat `/api/stats` (satuan SOL vs ETH tercampur). Selama `LOTTERY_CRON_ENABLED=false` di Solana ini
tidak terjadi karena tidak ada draw berjalan.

---

## 12. Bug dari laporan pemilik: 500 trigger-sync + error Alchemy di RPC EVM · 2026-10-29

Dua gejala, dua sebab berbeda:

**(a) `getMinimumBalanceForRentExemption is not available on the ROBINHOOD_MAINNET` (Alchemy).**
Efek samping dari perubahan §3: `getConfig().rpcUrl` saya jadikan chain-aware, tetapi
`lib/solana/connection.ts` juga memakai field itu → **klien Solana menunjuk ke RPC EVM**, lalu mengirim
method Solana (`getMinimumBalanceForRentExemption`, `getBalance`) ke node EVM. Perbaikan:
- `config.solanaRpcUrl` baru (selalu `SOLANA_RPC_URL`, boleh kosong di EVM).
- `getConnection()` memakai `solanaRpcUrl` dan **melempar pesan jelas** kalau kosong
  ("SOLANA_RPC_URL is not set — this code path is Solana-only").
- Script Solana-only (`airdrop`, `checkPlatformWallet`, `setupDevnetToken`) ikut pindah ke `cfg.solanaRpcUrl`.
- **`getCreatorFeeStatus()` + `claimCreatorFees()` sekarang keluar lebih awal di chain non-Solana**
  (fees = fitur pump.fun/Solana) → tidak ada lagi RPC storm; admin card menampilkan pesan jujur
  "Creator fees are pump.fun/Solana only — not available on Robinhood Chain (4663)."

**(b) `POST /api/admin/trigger-sync` → 500 dalam 4,4 s.** **Bukan bug kode**: itu **Blockscout 403**
untuk IP mesin ini (2 percobaan fetch + jeda retry 4 s ≈ 4,4 s; direproduksi via `npm run holders:sync`
→ `indexer HTTP 403 (public instance throttling this host)` dalam 7 s). Kode-nya terbukti benar dengan
stub indexer (`12 of 19 holders`). Solusi ada di jaringan, bukan di kode: jalankan dari VPS/IP lain,
set `CHAIN_INDEXER_URL` ke indexer lain, atau minta akses API ke tim pons.

**Perbaikan tambahan biar konsisten di chain EVM** (uji di dev server mode robinhood):
- `/api/admin/info` — alamat + saldo platform wallet lewat adapter (`getChain().platformAddress()` /
  `getNativeBalance()`); treasury hanya ditampilkan di Solana.
- `/api/wallets` (halaman `/treasury`) — sama; di EVM `fee.configured=false` karena payout EVM belum
  menyapu fee ke treasury. **Bukti:** `chain=robinhood symbol=ETH addr=0x4f52…f3dd balance=0
  feeConfigured=False error=[]` (sebelumnya `Config incomplete: bad secret key size`).
- `/api/creator-fees` (tile homepage) → pesan "not available on Robinhood Chain" alih-alih error RPC.

**Pelanggaran prosedur yang saya lakukan dan perbaiki (catatan untuk sesi berikutnya):** patch 3 script
dengan `Get-Content -Raw | Set-Content -Encoding UTF8` (dilarang `.clinerules`) → menambah **BOM** dan
mengubah `—` jadi `â€”`. Diperbaiki dengan reversal byte (cp1252 → byte → UTF-8) via Node, bukan retype;
verifikasi ulang: **BOM=False, mojibake=0, em dash utuh** di ketiga file.

Verifikasi akhir: `npx tsc --noEmit` **0 error**; `npm run build` hijau; `/api/wallets`,
`/api/creator-fees`, `/api/status` di mode robinhood semua OK.

---

## 13. Holder TANPA indexer: fallback `alchemy_getAssetTransfers` · **SELESAI 2026-10-29**

Masalah yang dilaporkan: tombol **Sync now** di `/admin` → **500** (`indexer HTTP 403`). Instance
Blockscout publik memblokir **seluruh host** IP mesin dev (semua User-Agent, bukan cuma burst), jadi
sync **tidak mungkin** berhasil dari mesin itu.

Kenapa `eth_getLogs` tidak bisa menggantikan: Alchemy free tier membatasi **10 blok per request**
(diverifikasi: span 10/50/100/500/2000 semuanya ditolak), sedangkan chain ini menghasilkan
**≈855.000 blok/hari** → ~85.500 request/hari. Tidak layak.

**Solusinya `alchemy_getAssetTransfers`** (diverifikasi jalan di chain 4663): semua transfer ERC-20 milik
kontrak token di-page **1.000 per request** (`pageKey`), lalu diagregasi menjadi **saldo bersih** per
alamat. Implementasi: `listHoldersFromTransfers()` di `chain/robinhood.ts`.
- Label venue (bonding curve/pool) dideteksi tanpa indexer lewat **`eth_getCode`** per kandidat,
  batch 8 paralel; `0xef0100…` dikenali sebagai **EIP-7702** → tetap eligible (user asli).
- `ChainAdapter.listHolders()` di adapter robinhood kini **dispatcher**: `HOLDER_SOURCE=auto` (default)
  mencoba indexer dulu lalu fallback; `indexer` / `transfers` memaksa salah satu.
- Snapshot membawa `source` (`blockscout` | `alchemy-transfers`) dan `syncHolders` melog-nya.

Bukti tanpa stub, langsung ke Alchemy:
`[sync] holder indexer unavailable (… 403 …) — falling back to alchemy_getAssetTransfers` →
`holder sync done — 16 of 16 holders in 1 request(s) via alchemy-transfers · 1 venue(s) auto-excluded`
(exit 0, **12,1 s**). Publik: `/api/holders` → `total=16 eligible=15`, dan bonding curve
`0x0e8641…86e4` tampil dengan `amount=797063843490960830516755487` **`excluded=True`**.

Beda angka vs indexer: indexer menyebut 19 holder (termasuk alamat bersaldo nol), fallback menghitung
**16** karena hanya menjumlahkan yang masih memegang token — untuk eligibility justru lebih tepat.

**Belum dibuat (biaya):** sampai ada cursor, setiap sync membaca **seluruh** riwayat transfer. Untuk
token dengan ribuan transfer, simpan `lastBlock` di `AdminSetting` dan lanjutkan dari situ.

---

## 14. Bug satuan: cap hadiah ×1e9 hardcoded · **SELESAI 2026-10-29**

**Ditemukan dari log draw pemilik:** `[lottery] effective prize lamports: 0 (cap 1000000000)`.
`MAX_PRIZE_NATIVE=1` dikonversi dengan **×1e9 hardcoded** (`parseSolToLamports`), jadi di chain
18-desimal artinya cap hadiah **1 gwei = 0,000000001 ETH** — setiap pool nyata akan dipotong jadi nol
efektif. Ini bug yang baru kelihatan setelah wallet diisi ETH, dan sengaja/berhasil ketangkap sebelum itu.

Perbaikan: `parseSolToLamports` sekarang memakai **`10n ** BigInt(NATIVE_DECIMALS)`** (1e9 Solana,
1e18 EVM) dan **matematika string → BigInt** (tanpa float) untuk bagian desimal. Jebakan kecil saat
mengerjakan: `BASE_UNITS_PER_NATIVE` adalah `number`, dikalikan `bigint` → `tsc` menolak
("Cannot mix BigInt and other types"), jadi faktornya dihitung sebagai bigint.

Bukti (probe dua mode, `.env` sekarang `MAX_PRIZE_NATIVE=1`):
- Solana: `symbol=SOL decimals=9` → `MAX` = **1000000000** (1 SOL), reserve **1300000** (0.0013 SOL), RPC Helius.
- Robinhood: `symbol=ETH decimals=18` → `MAX` = **1000000000000000000** (1 ETH ✅), reserve
  **50000000000000000** (0.05 ETH default), RPC Alchemy.

Sekaligus **pesan engine yang disimpan ke `LotteryRound.error` dan tampil di UI** tidak lagi menulis
"SOL" keras: `Prize pool 0 ${NATIVE_SYMBOL} (balance at/below reserve)`, `… below minimum …`, dan log
`round #N completed … pool X ${NATIVE_SYMBOL}`. Pemeta `skipReason()` di UI tidak terpengaruh (cocoknya
pada frasa "at/below reserve" / "below minimum", bukan "SOL").

---

## 15. Treasury EVM: `PLATFORM_TREASURY_PRIVATE_KEY` + sweep fee · **SELESAI 2026-10-29**

**Laporan pemilik:** key `PLATFORM_TREASURY_PRIVATE_KEY` sudah diisi tapi alamat fee wallet tidak muncul di
`/treasury` dan `/admin`. **Sebab:** key itu **tidak dibaca kode mana pun** (hanya disebut di komentar) —
hanya `PLATFORM_TREASURY_SECRET` (Solana) yang dibaca, dan kartu fee wallet di EVM sengaja saya sembunyikan
(§12) karena payout EVM waktu itu belum menyapu fee.

**Perbaikan (wire penuh, bukan cuma tampilan):**
- `ChainAdapter.treasuryAddress?()` baru — Solana: `PLATFORM_TREASURY_SECRET` (`getTreasuryPubkey()`);
  EVM: diturunkan dari `PLATFORM_TREASURY_PRIVATE_KEY` via viem (null kalau kosong/invalid).
- `/api/wallets` + `/api/admin/info` sekarang memakai adapter itu → kartu fee wallet muncul di chain mana pun
  (`configured` + alamat + saldo native). Import Solana yang jadi tak terpakai dibuang.
- **`sendPayouts(winners, feeTransfer?)`** — payout EVM kini menyapu **fee platform** ke treasury sebagai
  **transfer PERTAMA**, karena jalur EVM tidak atomik: kalau sweep gagal, tidak ada hadiah yang terlanjur
  keluar. Hash yang dikembalikan tetap hanya hash pemenang (untuk `payoutTx`), fee gas digabung.
- Log draw menyebut sweep: `paid N winner(s) in M tx(s) + fee sweep to 0x1234…` atau
  `(fee stays on the platform wallet)` bila treasury tidak dikonfigurasi.

**Bukti runtime (dev server mode robinhood):** `/api/wallets` →
`platform=0x4f5222d32168eefcbed4a0d8ba4dae31c86cf3dd balance=0.00003802870862226` ·
`fee=0x7d061400ea0c7a510043e71663eab88ee53d75e5 balance=0 configured=true` · `error=[]`.
`/api/status` → `eligible=15 prizePoolSol=0.00003792870862226 playable=true`.

**Catatan reserve:** owner menaruh `PRIZE_RESERVE_WEI=100000000000` (0,1 gwei) agar pool dari deposit kecil
tetap > 0 — aman untuk tes (gas EVM di chain ini ~1e-9 ETH per transfer), tapi **untuk produksi** isi
`50000000000000000` (0,05 ETH) atau hapus barisnya agar default berlaku.

`tsc` **0 error**; build ✓ 8,3s / TS 5,5s / 12/12.

---

## 16. Payout EVM gagal separuh: gas tak dianggarkan + decimals token · **SELESAI 2026-10-29**

**Laporan pemilik:** payout error `insufficient funds for gas * price + value` —
`have 6044984638229 want 7838029638229`, gas 21000, gasPrice 0,030075 gwei, nonce 7.

**Diagnosis (dua masalah):**
1. **Gas tidak dianggarkan** dalam pool. Pool = saldo − reserve, dan reserve owner saat itu
   `PRIZE_RESERVE_WEI=100000000000` (0,1 gwei) — padahal 4 tx (sweep fee + 3 pemenang) butuh
   **~2,5e12 wei** gas @0,03 gwei. Jadi batch membayar fee + pemenang #1 + #2, lalu **habis** di #3.
2. **DB kehilangan jejak**: jalur error lama menghapus semua baris pemenang yang masih `pending`, jadi
   round ditandai `failed` **tanpa satu pun baris** meski uang sudah keluar. Bukti on-chain
   (`alchemy_getAssetTransfers`, fromAddress = platform): **12 transfer keluar** dalam **5 batch berbeda** —
   satu batch lengkap (3 pemenang, sebelum treasury diset) dan **tiga batch terputus** (fee + 1–2 pemenang),
   termasuk batch yang dilaporkan.

**Perbaikan:**
- **Gas dari `.env`** (sebelumnya hardcoded): `PAYOUT_GAS_LIMIT` (21000),
  `PAYOUT_GAS_LIMIT_CONTRACT` (80000), `PAYOUT_GAS_HEADROOM` (1.5), `PAYOUT_GAS_PRICE_GWEI` (opsional;
  kalau diisi, harga tidak dibaca dari RPC).
- **Pre-flight balance check** di `sendPayouts` sebelum kirim pertama:
  `butuh = Σvalue + Σ(gas × gasPrice)`; kalau saldo < butuh → **lempar error berisi angka** dan
  **tidak ada satu tx pun terkirim**. Bukti (probe): pool 13.654.557.500.561 + gas 2.535.876.000.000 =
  **16.190.433.500.561** vs saldo **13.754.557.500.562** → *refused, nonce before = after = 0xc* ✅
- **Payout separuh kini TERCATAT**: `sendPayouts` menempelkan `partialPayouts` (alamat + nilai + hash) pada
  error, dan engine menandai baris pemenang itu `sent` + menyimpan `payoutTx`/`payoutFeeLamports`, hanya
  menghapus baris yang benar-benar belum terbayar. Pesan round menyebut daftar hash yang sudah mendarat.
- **Decimals token diperbaiki**: `TOKEN_DECIMALS` 6 → **18** (diverifikasi `alchemy_getTokenMetadata` = 18;
  sebelumnya tampilan jumlah token dibagi 1e6) dan row DB `MIN_TOKEN_ELIGIBLE` `1e11` → **`1e18`** (1 token)
  supaya "Min hold" tampil `1.0`, bukan `0.000001`.

**Aturan reserve (penting untuk deployment murah):** `PRIZE_RESERVE_WEI` harus **≥ total gas satu batch**
(~2,5e12 wei @0,03 gwei untuk 4 tx) — kalau lebih kecil, pre-flight akan menolak terus. `.env` sekarang
`5000000000000` (0,000005 ETH) untuk tes; produksi kembali ke `50000000000000000` (0,05 ETH).

`tsc` **0 error**; build hijau; probe pre-flight membuktikan nol tx terkirim saat saldo kurang.

---

## 17. Chain ini menolak tx LEGACY: payout harus EIP-1559 · **SELESAI 2026-10-29**

**Laporan pemilik:** sweep fee gagal dengan `Missing or invalid parameters` pada `eth_sendRawTransaction`
(Alchemy), padahal pre-flight lolos dan dananya cukup.

**Investigasi:** raw tx-nya saya decode manual — semua benar: nonce 12, gasPrice 0,031155 gwei, gas 21000,
`to` = treasury, value 6,42e12 wei, `v = 0x2492 = 9362` (= chainId **4663** × 2 + 35 + 1 → tanda tangan
EIP-155 sah), panjang RLP 107 byte. Jadi tx-nya **legacy (type 0)** dan formatnya valid.

**Uji terkendali** (dua tx 1 wei ke treasury sendiri, biaya hanya gas):

| Format | Hasil |
|---|---|
| **legacy / type 0** (`gasPrice`) | ❌ ditolak — *"The fee cap (maxFeePerGas gwei) cannot be lower than the block base fee"* |
| **EIP-1559 / type 2** (`maxFeePerGas` + `maxPriorityFeePerGas`) | ✅ **diterima**, `status 0x1`, `type 0x2` |

Konsisten dengan tx asli di chain ini (bot kolektor pons): `type: 2`, `priority_fee: 0`.

**Perbaikan:** `sendPayouts` mengirim **EIP-1559**:
- `maxFeePerGas = gasPrice × PAYOUT_GAS_HEADROOM` (default dinaikkan ke **2** — `maxFeePerGas` adalah CAP,
  jadi harus jelas di atas base fee blok; legacy hanya memakai `gasPrice` = base fee sehingga rawan ditolak),
- `maxPriorityFeePerGas = PAYOUT_PRIORITY_FEE_GWEI` (default **0**, sama seperti tx nyata di chain ini),
- pre-flight memakai `maxFeePerGas` untuk menghitung kebutuhan gas,
- `PAYOUT_GAS_PRICE_GWEI` sekarang berarti *fee cap* tetap (bukan `gasPrice`).

**Bukti lewat jalur produksi** (`getChain().sendPayouts([1 wei ke treasury])`):
`primaryTxHash 0x14a356a8…56fc` · receipt `status 0x1`, **`type 0x2`**, `gasUsed 0x5208`,
`effectiveGasPrice 0x13ddf00` → fee terhitung **437.472.000.000 wei**.

`tsc` **0 error**; build hijau.

---

## 18. Gas EVM dari `.env` + dua bug ikutan · **SELESAI 2026-10-29**

**Permintaan pemilik:** taruh angka gas/gwei di `.env` supaya bisa diatur.

**Angka nyata yang diukur di Robinhood Chain:** `eth_gasPrice` **0,020686 gwei** · block `baseFeePerGas`
**0,020584 gwei** · `eth_maxPriorityFeePerGas` **0** · dua tx uji menghasilkan `effectiveGasPrice`
**0,020832 / 0,021048 gwei** dengan `gasUsed 21000` → biaya 1 transfer ≈ **0,00000044 ETH**.

**Yang sekarang ada di `.env`** (blok "Payout gas (EVM only)"):
`PAYOUT_GAS_PRICE_GWEI=0.05` (CAP ≈ 2,4× base fee) · `PAYOUT_PRIORITY_FEE_GWEI=0` ·
`PAYOUT_GAS_LIMIT=21000` · `PAYOUT_GAS_LIMIT_CONTRACT=80000` · `PAYOUT_GAS_HEADROOM=2`
(hanya dipakai kalau cap tetap dikosongkan) + aturan reserve. Catatan penting yang ditulis di `.env`:
**`maxFeePerGas` itu CAP, bukan yang dibayar** — dengan tip 0 wallet hanya dibebani base fee, jadi cap
besar itu gratis dan mencegah penolakan "fee cap cannot be lower than the block base fee".

**Bug #1 — komentar inline bikin NaN.** `envNum()` membaca `Number("0.05        # CAP 0,05 gwei …")` =
**NaN** → cap yang diset diabaikan dan jatuh ke default. Next/dotenv membuang komentar inline, tapi
probe/script kita membaca `.env` sendiri. Fix: `envRaw()` menerapkan aturan dotenv (nilai tanpa kutip
berakhir di ` #` pertama). Bukti: probe cap sekarang menunjukkan **`maxFeePerGas terpakai = 50000000 wei
= 0,05 gwei`** (sebelumnya 0,04172 gwei dari jalur headroom).

**Bug #2 — tiga pemenang berbagi satu hash.** Jalur sukses memakai `updateMany({ roundId })` (bentuk
Solana: satu tx bayar semua), jadi ketiga baris pemenang menyimpan hash milik round. Di EVM setiap pemenang
punya tx sendiri → engine kini menyimpan **hash per pemenang** (`winnerTxHashes[i]`, urutan sama dengan
`amounts`, sweep fee tidak ikut), dan hanya jatuh ke `updateMany` untuk jalur Solana.

**Bukti round #5 (payout EVM pertama yang sukses):** DB → `#5 completed pool=127163150043826
fee=6358157502191 payoutTx=0x21e5f111…ae741`, 3 baris pemenang `sent`; on-chain 4 transfer berurutan —
treasury `0.000006358157502191` (blok 0x6066a88) → rank1 `0.000060402496270818` (0x6066a8d) →
rank2 `0.000036241497762490` (0x6066a92) → rank3 `0.000024160998508327` (0x6066a97) — **semuanya cocok
dengan jumlah di DB**, dan hash rank1 = `payoutTx` round.

`tsc` **0 error**; build hijau.

---

## 19. Treasury tak menampilkan tx + label pons + API PONS pumpdev · **SELESAI 2026-10-29**

**Laporan pemilik:** tabel "platform wallet" dan "fee wallet" di `/treasury` kosong padahal ada payout yang
baru sukses. **Diagnosis:** datanya **terbaca** — `/api/treasury/ledger` mengembalikan 1 baris
(`#5 paidSol=0.000120804992541635 feeSol=0.000006358157502191 payoutFeeSol=0.000001743084
tx=0x21e5f111…`), dan memo di halaman menyaring `paidSol > 0` / `feeSol > 0` yang keduanya lolos. Masalahnya
**cara memuat**: tiga `useEffect(..., [])` hanya fetch **sekali saat mount** — tanpa polling — jadi draw yang
selesai ketika tab sudah terbuka tidak akan muncul sampai reload manual.
**Perbaikan:** auto-refresh `tick` tiap **15 s** (sama dengan cache `/api/treasury/ledger` dan `/draws`),
di-pause saat tab tidak terlihat; ketiga effect sekarang bergantung pada `tick`.

**Label tile homepage:** `Unclaimed fees` → **`Unclaimed fees on pons`** di Robinhood Chain (dan
`… on pump.fun` di Solana) lewat `FEE_SOURCE_LABEL` yang mengikuti `CHAIN_KIND` — bukan hardcode satu
launchpad. Tooltip-nya ikut memakai label itu + `NATIVE_SYMBOL` (sebelumnya menulis "pump.fun" dan "SOL"
keras).

**API PONS pumpdev (temuan penting untuk Fase 4 — host BERBEDA dari pump.fun):**
- Base URL **`https://rhc.pumpdev.io`** (Solana tetap `https://pumpdev.io`), **tanpa API key**.
- `GET /api/claim-account?publicKey=0x…&tokens=0x…,0x…` (tokens opsional, maks 10) →
  `{ publicKey, claimable, claimableEth, escrowBalance, pending, tokens[{token,curve,pending,graduated,buybackEnabled,error?}], feeBps, delegated, delegatedTo }`
  · `claimable = escrowBalance + pending` · `feeBps 50` = **0,5 %** komisi pada rute client-signed.
- Claim: **`POST /api/claim-local`** (tanda tangan dari wallet sendiri) atau `POST /api/claim-lightning`.
- Batasan: hanya token **ber-quote ETH** (custom pair → `error: "Custom-pair fees are not supported yet"`);
  token yang sudah graduasi melaporkan `graduated: true` dan hanya saldo escrow yang dihitung; panggilan
  tanpa `tokens` hanya melaporkan isi escrow.
- Artinya pola di `pumpfun/creator-fees.ts` (GET claim-account → POST claim → poll receipt) **bisa dipakai
  ulang** untuk pons: base URL per chain, `publicKey` = `getChain().platformAddress()`, daftar token dari
  env, dan parser respons PONS (`claimableEth`/`escrowBalance`/`pending`). Belum dikerjakan — menunggu
  keputusan pemilik (auto-claim atau manual).

---

## 20. Pons pakai data asli, "Last claimed" dihapus, CA & cek elig chain-aware · **SELESAI 2026-10-29**

Empat permintaan pemilik, semuanya diverifikasi runtime (tanpa browser):

**(1) "Unclaimed fees on pons" pakai DATA ASLI.** Modul baru **`src/lib/pons/creator-fees.ts`** (read-only):
`GET {PONS_API_BASE|https://rhc.pumpdev.io}/api/claim-account?publicKey=<platformAddress>[&tokens=…]` →
`{ claimableSol, escrowSol, pendingSol, feeBps, tokens[], checkedAt, error }`, timeout 15 s, **tidak pernah**
membangun/mengirim tx (keputusan pemilik: claim manual). `/api/creator-fees` bercabang: chain non-Solana →
ringkasan pons (nama field sama supaya tile homepage tidak perlu diubah), Solana → pump.fun seperti
sebelumnya + field additive `source: "pons" | "pumpfun"`, `feeBps`, `tokens[]`.
Bukti: `GET /api/creator-fees` → **`source=pons claimable=0 escrow=0 pending=0 feeBps=50 err=[]`** (0 karena
escrow wallet platform belum berisi fee; `feeBps 50` = komisi pumpdev 0,5 %). Env baru (opsional):
`PONS_API_BASE`, `PONS_TOKENS` (comma-separated, maks 10 — memasukkan fee yang masih di bonding curve).

**(2) `Last claimed` dihapus** dari tile prize-pool (mode manual: pemilik yang claim). Container jadi satu
kolom (`grid gap-3`); HTML `/` tidak lagi memuat teks itu.

**(3) Strip "Contract address" di bawah hero** masih memakai **mint Solana**: `/api/status`, `/api/holders`,
`/api/eligibility`, `/api/admin/info` membaca `process.env.TOKEN_MINT` langsung. Helper baru
**`activeTokenAddress()`** (`chain/index.ts`) memilih `TOKEN_MINT` di Solana dan `TOKEN_ADDRESS` di EVM;
keempat route memakainya. Bukti: `/api/status` → `tokenMint=0x6acdb03e46dae4dc387ab93b78e660c906614b07`
(sebelumnya base58 Solana), jadi baris CA + link Blockscout sudah benar.

**(4) Cek eligibility menolak alamat EVM**: `/api/eligibility` masih memakai regex base58 keras ("Invalid
Solana address format"). Sekarang validasi + kanonikalisasi lewat **`getChain().normalizeAddress()`**
(base58 32 byte di Solana; EIP-55 `0x…` disimpan lowercase di EVM) dan pesan 400 dari adapter ditampilkan
apa adanya di form (client tidak lagi menulis "Solana wallet address" keras).
Bukti: `?address=0x4f5222d32168eefcbed4a0d8ba4dae31c86cf3dd` → **200** (`eligible=false`), sedangkan
`?address=nonsense` maupun alamat base58 Solana → **400**
`{"error":"Not a valid 0x address (42 characters, 20 bytes)"}`.

`tsc` **0 error**; build hijau.

---

## 21. Flow chart "Pons trading" + logo pons, SEO meta masih Solana, & palet warna tombol yang hilang · **SELESAI 2026-10-29**

Permintaan pemilik: (a) flow chart masih "Pump.fun trading" dan logonya bukan pons,
(b) belum ada palet khusus untuk warna teks tombol padahal ada beberapa tombol di
home/draws/eligibility, (c) meta SEO saat link di-paste masih Solana/PAY.

### 21.1 Flow chart + logo pons

- **Logo pons**: `https://ponsfamily.com/pons-logo.png` (256×256) → `public/flow/pons.png`.
  Ditemukan dari HTML launchpad (`<link rel="icon" href="/favicon.png">` + `src="/pons-logo.png"`);
  path umum (`/logo.png`, `/og.png`, `/favicon.ico`) semuanya 404.
- **Satu sumber kebenaran** di `chain/network.ts`:
  `FEE_SOURCE_LABEL` (`pump.fun` / `pons`), `FEE_SOURCE_TITLE` (`Pump.fun trading` /
  `Pons trading`), `FEE_SOURCE_LOGO` (`/flow/pumpfun.png` / `/flow/pons.png`).
- `HowItWorksFlow.tsx`: `ART.pumpfun` dihapus, kartu fee-source memakai
  `FEE_SOURCE_LOGO` + `FEE_SOURCE_TITLE` (desktop + mobile + kedua `aria-label`),
  `ART` tinggal `pay`/`drand`. Semua komentar "Pump.fun" → "fee source/launchpad".
- `page.tsx` memakai konstanta bersama (const lokal `FEE_SOURCE_LABEL` dihapus);
  /how-it-works dan /rounds/[n] juga (dulu menulis "Pump.fun" keras).
- `public/flow/README.md` ditulis ulang (sekalian memperbaiki `â€”` pre-existing)
  dengan tabel 4 file + penjelasan bahwa artwork mengikuti `NEXT_PUBLIC_CHAIN`.

**Bukti:** output build memuat `Pons trading` + `/flow/pons.png` di
`.next/server/app/index.html` dan `how-it-works.html`; HTML live
`aria-label="Pons trading creator fee flows through the DrawFi engine and drand to the winners"`.

### 21.2 SEO meta masih Solana ("PAY"-nya)

Meta live saat diperiksa: `og:description` = "…holder draws **on Solana**…" dan
`keywords` = "…**SOL payouts**" — dua row DB (`SEO_DESCRIPTION`, `SEO_KEYWORDS`)
menang atas default kode, jadi memperbaiki kode saja tidak mengubah share card.

- `SEO_DEFAULTS` (seo.ts) kini **chain-aware** lewat `CHAIN_NAME` + `NATIVE_SYMBOL`
  (konstanta `CHAIN_NAME` baru di `network.ts`: "Robinhood Chain" / "Solana" —
  `CHAIN_LABEL` sengaja tidak dipakai supaya `(4663)` tidak masuk ke share card).
- Row DB diperbarui: deskripsi `Solana` → `Robinhood Chain` (150 → 159 char),
  keywords `Solana holder draws… SOL payouts` → `Robinhood Chain holder draws…
  ETH payouts` (122 → 131). Nilai lama (untuk rollback) ada di §20.
- `telegram-bot.ts` masih punya fallback nama token keras **`|| "PAY"`** → `|| "DrawFi"`.
  Ini sisa terakhir string "PAY" yang tampil (fallback bila `TOKEN_NAME` kosong).

**Bukti:** HTML live sekarang `og:description="…on Robinhood Chain…"` (+ `<meta name="description">` sama) dan
`keywords="DrawFi,Robinhood Chain holder draws,…,ETH payouts"`; `SOL payouts` **0 hit**.

### 21.3 Palet warna tombol — akar masalahnya token HeroUI yang tidak pernah didefinisikan

HeroUI v3 mewarnai lewat **pasangan** variabel, dan separuh pasangannya tidak ada di
tema ini:

| selector | memakai | status sebelum |
|---|---|---|
| `.button` | `--button-bg-hover` → `var(--accent-hover)` | `--accent-hover` **tidak ada** |
| `.button--default` | `--button-fg: var(--accent-soft-foreground)` | **tidak ada** |
| `.chip--default.chip--soft` | `--chip-bg: var(--default-soft)`, `--chip-fg: var(--default-soft-foreground)` | **keduanya tidak ada** |
| `.chip--success/--warning/--danger.chip--soft` | `--*-soft`, `--*-soft-foreground` | **tidak ada** |
| `.badge--soft.*` | `--*-soft`, `--*-soft-foreground` | **tidak ada** |
| `.autocomplete__trigger` | `--autocomplete-trigger-bg-hover: var(--default-hover)` | **tidak ada** |

Konsekuensinya bukan "inherit" seperti dugaan awal: `background-color: var(--chip-bg)`
di mana `--chip-bg` berisi `var(--default-soft)` **invalid at computed-value time**,
jadi deklarasinya **dibuang** → pill tanpa latar, dan `color: var(--chip-fg)` juga
dibuang → label menumpang `--foreground`. Itulah kenapa soft chip & hover tombol
terlihat belum "berwarna", bukan cuma polos.

**Yang ditambahkan** (`globals.css`, blok `── Button & pill palette ──` di **light dan
dark**, dengan komentar alasannya):

- **`--button*`** (palet tingkat aplikasi): `--button`, `--button-hover`,
  `--button-pressed`, **`--button-foreground`** — alias tipis di atas pasangan accent,
  jadi satu edit mewarnai semua tombol HTML biasa:
  `bg-(--button) text-(--button-foreground) hover:bg-(--button-hover)`.
- **Ramp yang HeroUI referensikan**: `--accent-hover`, `--accent-soft`,
  `--accent-soft-hover`, `--accent-soft-foreground`, lalu keluarga yang sama untuk
  `default`/`danger`/`success`/`warning` (masing-masing `-hover`, `-soft`,
  `-soft-hover`, `-soft-foreground`). Soft memakai `color-mix(in oklab, var(--x) N%, transparent)`
  sehingga ikut tema otomatis; `--default-soft` sengaja **alias `--default`** (94 % terang /
  27 % gelap) — itu memang nilai yang dirancang untuk pill netral di atas `--surface`, dan
  bekerja di dua tema tanpa nilai kedua.

**Diterapkan ke tombol nyata:** submit `/eligibility` (`bg-accent text-accent-foreground
hover:opacity-90` → `bg-(--button) text-(--button-foreground) hover:bg-(--button-hover)`),
CTA `/how-it-works`, dan 3 tombol `NotifySubscribe.tsx` (yang memakai **`text-white` keras**).

**Sekalian: 37 pemakaian token mati HeroUI v2** di 3 file (`text-default-400/500`,
`bg-default-50/100/200`, `border-default-200`, `divide-default-200`, `bg-content1`,
`text-success-600`, `text-danger-600`) → `text-muted`, `bg-default`, `bg-default/40`,
`border-(--border)`, `divide-(--border)`, `bg-surface`, `text-success`, `text-danger`.
Total **52 penggantian** di `holders/page.tsx`, `live/page.tsx`, `NotifySubscribe.tsx`
(dinilai dengan Node + UTF-8 eksplisit, jadi tanpa BOM/mojibake — aturan `.clinerules`).
Sekarang **0** pemakaian token mati di seluruh `src`.

**Bukti:** CSS terkompilasi memuat `background-color:var(--button)`,
`color:var(--button-foreground)`, `background-color:var(--button-hover)`,
`--default-soft`, `--default-soft-foreground`, `--accent-hover`,
`--success-soft-foreground`, `--warning-soft-foreground`, `--danger-soft-foreground`;
`.text-default-400` dan `.bg-content1` **tidak ada** lagi.

**Catatan efek samping yang disengaja:** `Chip color="success"|"warning"|"danger"
variant="soft"` kini benar-benar berwarna (label toned, latar tint) — sebelumnya
latar & labelnya dibuang seperti dijelaskan di atas.

### 21.4 Bonus: placeholder eligibility tidak lagi memaksa Solana

`Paste a Solana wallet address` → `` `Paste a ${CHAIN_NAME} wallet address` ``.

### 21.5 Rantai provenance di tiap baris draw (ketemu di audit lanjutan)

Audit "siapa masih menyebut Pump.fun" menemukan **satu tempat yang benar-benar
tampil di layar**, bukan komentar: `RecentDraws.tsx` (baris **Completed rounds** di
homepage) menulis keras `<Step src="/flow/pumpfun.png" label="Creator fee from
Pump.fun" />` plus `label="Shuffled by the Pay engine"`. Jadi even setelah chart
diperbaiki, rantai provenance kecil di tiap baris draw masih menampilkan logo & nama
lama — inilah "logonya belum logo pons" yang terlihat.

- `RecentDraws.tsx` kini memakai **`FEE_SOURCE_LOGO` + `FEE_SOURCE_LABEL`** dan
  `useSite().brandName` untuk kartu engine (`Shuffled by the … engine`, dulu keras "Pay").
- `ExclusionsCard.tsx` (prosa panel admin) "the pump.fun bonding curve, AMM/LP pool
  authorities" → "the {FEE_SOURCE_LABEL} bonding curve, AMM/LP pool venues".
- Komentar header `RecentDraws` (`1.24 SOL  pumpfun → pay → drand → ①②③`) diperbarui.

Sisa penyebutan "Pump.fun"/"Pay engine" di `src/` sekarang **hanya** di jalur kode
Solana-only (`lib/solana/holders.ts`, `lib/pumpfun/creator-fees.ts`, PDA di
`lib/exclusions.ts`, `scheduler.ts`, `scripts/netTest.ts`), di **komentar** internal,
dan di cabang Solana dari ternary `FEE_SOURCE_*` — semuanya benar apa adanya.

**Bukti:** HTML `/` memuat `/flow/pons.png` **3 hit** dan `/flow/pumpfun.png`
**0 hit**; `Pons trading` 4 hit.

### 21.6 Verifikasi

`npx tsc --noEmit` **0 error** · `npm run build` **✓ 8,7 s · TypeScript 13,0 s · 12/12 · 0 warning**,
BUILD_ID `Dl5CTQFYJg-3-eicUCLeq` (sebelum perbaikan rantai provenance: 16,5 s / 8,9 s,
BUILD_ID `QW7QxmHGUsBNiVuG1ocHn`) · 0 mojibake/BOM baru di 12 file yang disentuh
(`HowItWorksFlow.tsx` memang **sudah** ber-BOM sebelum sesi ini — legacy, byte-nya
dipertahankan) · `GET /`, `/how-it-works`, `/eligibility` **200** · tidak ada verifikasi
browser (atas permintaan pemilik).

---

## 22. `npx tsc --noEmit` OOM di VPS: bukan mesinnya, tapi heap default Node · **SELESAI 2026-10-29**

**Gejala yang dilaporkan** (dari VPS):

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
[66519:0x34787000] 35329 ms: Scavenge 473.5 (486.4) -> 472.0 (486.7) MB ... allocation failure;
```

**Diagnosis.** Angka `473 MB` itu **tepat di bawah ~512 MB** — cap heap default V8, bukan
batas RAM mesin. V8 menetapkan `--max-old-space-size` dari RAM yang terlihat; di VPS
1–2 GB cap itu jatuh ke ~512 MB, sementara `tsc` untuk proyek ini butuh lebih.

**Diukur, bukan ditebak** (Windows dev box, cold run tanpa `tsconfig.tsbuildinfo`,
proses `tsc` di-`Start-Process -PassThru` lalu `PeakWorkingSet64` dipantau):

| konfigurasi | hasil |
|---|---|
| `npx tsc --noEmit` | selesai **8,1 s**, puncak **812,7 MB** |
| `node --max-old-space-size=300 …/tsc.js --noEmit` | **OOM** — `Ineffective mark-compacts near heap limit`, persis mengulang error VPS |
| `npm run typecheck` (= `--max-old-space-size=2048`) | **0 error**, tanpa OOM, `tsconfig.tsbuildinfo` terbentuk |

Jadi jawabannya **bukan "VPS kurang kuat"**: dev box pun butuh ~813 MB RSS, dan cap 300 MB
di mesin 24 GB ini tetap OOM. Yang salah cuma batas heap yang diwariskan lingkungan.

**Perbaikan.**

- `package.json`: script baru
  `"typecheck": "node --max-old-space-size=2048 node_modules/typescript/lib/tsc.js --noEmit"`.
  Menunjuk `typescript/lib/tsc.js` (bukan `npx tsc`) supaya flag benar-benar sampai ke proses
  TypeScript, bukan ke pembungkus npx — dan supaya jalan sama di Windows maupun Linux.
- `DEPLOY-VPS.md` §1: paragraf baru yang menjelaskan beda **kernel OOM (`Killed`) vs heap Node
  OOM**, angka 472 MB ↔ cap 512 MB, `npm run typecheck`, `free -h`, dan
  `NODE_OPTIONS=--max-old-space-size=2048 npm run build` untuk type-check di dalam build.
- `.clinerules` §Commands: perintah type-check harian diganti `npm run typecheck` + alasannya
  (aturan lama menulis "no dedicated script").

**Yang perlu dilakukan di VPS:** `npm run typecheck` (bukan `npx tsc --noEmit` polos), dan
pastikan `free -h` menunjukkan ≥ 1 GB tersedia (RAM atau swap — lihat `DEPLOY-VPS.md` §2.4 untuk
membuat swap 2 GB bila RAM hanya 1 GB). Tidak ada perubahan kode aplikasi.

**Catatan:** `tsconfig.json` sudah `"incremental": true` dan `"skipLibCheck": true`, jadi run
berikutnya (dengan `tsconfig.tsbuildinfo` ada) jauh lebih murah; yang berat adalah **cold run**
pertama setelah upload — inilah yang Anda jalankan di VPS. `*.tsbuildinfo` di-`.gitignore`,
jadi VPS selalu mulai dari cold.

---

## 23. `prisma:error` di `/api/rounds`: `$queryRaw` tidak bisa membawa parameter `bigint` · **SELESAI 2026-10-29**

**Gejala** (log VPS, tiap request `/api/rounds` — sebenarnya dipicu `/api/stats`):

```
prisma:error Invalid `prisma.$queryRaw()` invocation:
Invalid value for argument `parameters`: Could not convert from `JSON bigint value`
to `PrismaValue`. Expected Flat JSON array (no nesting).
parameters.values: [{"prisma__type":"date",…},{"prisma__type":"bigint","prisma__value":"1000000000000000000000000"}]
```

**Sebab.** `src/app/api/stats/route.ts` → `loadHolderHistory()` menulis
`COUNT(*) FILTER (WHERE amt >= ${threshold})` dengan `threshold` hasil
`effectiveMinEligibleBigint()` — sebuah **JS `BigInt`**. `$queryRaw` menyerialkan `BigInt`
sebagai objek `{ prisma__type: "bigint", … }`, dan mesin Prisma menolak seluruh panggilan
("Expected Flat JSON array (no nesting)"). Jadi query itu **gagal setiap kali**, dan karena
`loadHolderHistory` punya `catch { return null }` yang sengaja fallback, **tidak ada yang
terlihat rusak** — hanya error di log Prisma. Efeknya: chart holder di `/stats` selalu pakai
seri per-draw (`daily`) alih-alih snapshot holder (`holdersDaily`).

**Diukur** (langsung ke Neon, read-only; `src/lib/settings.ts` → `.env`
`MIN_TOKEN_ELIGIBLE=1000000000000000000000000`):

| bentuk | hasil |
|---|---|
| `$queryRaw` dengan param `BigInt` | **ERROR** — pesan identik dengan VPS |
| param **string** + `${threshold}::numeric` | **OK** — `n=91` |
| query `daycap` penuh dengan param string | **OK** — `2026-10-29 eligible=24 total=24` |

**Perbaikan.** `threshold` dikirim sebagai **string** dan di-cast `::numeric` di SQL (bukan
`bigint`) — `numeric` juga satu-satunya tipe yang bisa memuat saldo raw 18-desimal (int8 mentok
~9.22e18). Ditambah `console.warn` di `catch`, karena kegagalan senyap inilah yang membuat
masalah ini tidak terlihat sampai log Prisma dibaca.

**Bukti end-to-end:** `/api/stats` → HTTP **200** dan `holdersDaily` kini
`2026-10-29 eligible=24 total=24` (sebelumnya selalu `null` → chart pakai `daily`); tidak ada
`prisma:error` baru di `.dev.log`. `npm run typecheck` **0 error**.

**Pelengkap:** sisa pemakaian raw SQL di proyek ini aman —
`engine.ts` `SELECT pg_advisory_xact_lock(4711001)` memakai **number** biasa, dan
`instrumentation.ts` `SELECT 1` tanpa parameter.

**Catatan nilai:** `.env` `MIN_TOKEN_ELIGIBLE=1e24` = **1.000.000 token** (18 desimal);
row DB `MIN_TOKEN_ELIGIBLE` masih `1e18` tapi **tidak dipakai** (engine membaca env — lihat §16).

---

## 24. Admin → Palette tidak punya grup "Buttons": token `--button*` tidak terdaftar · **SELESAI 2026-10-29**

**Laporan pemilik:** *"gaada block button di admin"*. Setelah ditelusuri, panel paletnya
**ada dan lengkap** — `src/lib/palette.ts` (`PALETTE_TOKENS`/`PALETTE_GROUPS`), API
`/api/admin/palette`, komponen `PalettePanel.tsx`, dan injeksi `<style id="theme-palette">`
di `layout.tsx` dengan selector `html[data-theme="…"]` (specificity 0,1,1 > `globals.css`
0,1,0). Yang kurang: **katalognya belum punya grup tombol**, karena `--button*` baru ada
sejak §21 sedangkan katalognya lebih tua.

**Yang ditambahkan ke `PALETTE_TOKENS`:**

- Grup **`Buttons`** (6 token): `button`, `button-hover`, `button-pressed`,
  **`button-foreground`** ← *warna teks tombol yang diminta*, `accent-hover`,
  `default-hover`.
- Grup **`Soft chips & badges`** (5 token): `accent-soft-foreground`,
  `default-soft-foreground`, `success-soft-foreground`, `warning-soft-foreground`,
  `danger-soft-foreground` — label chip soft yang tadinya tak terdefinisi (§21.3).
- `PALETTE_GROUPS` → `Brand & status · **Buttons** · **Soft chips & badges** · Page & surfaces · Lines & chrome`.
  Katalog jadi **42 token / 5 grup** (sebelumnya 31 / 3).

**Hex default dihitung, bukan dikira-kira.** Saya tulis konverter oklch→sRGB dan
memvalidasinya dengan token yang sudah ada: konversinya mereproduksi hex panel **persis**
(`accent` #0485f7, `accent-foreground` #fcfcfc, `default` #eaebec / #272728,
`default-foreground` #17191b / #fcfcfc). Jadi token baru memakai hex yang identik dengan
nilai `globals.css`-nya:

| token | light | dark | dari CSS |
|---|---|---|---|
| `button` | #0485f7 | #0485f7 | `var(--accent)` |
| `button-hover` / `button-pressed` / `accent-hover` | #0072e2 | #2a98ff | `oklch(56% / 68% …)` |
| `button-foreground` | #fcfcfc | #fcfcfc | `var(--accent-foreground)` |
| `default-hover` | #dadbdc | #333435 | `oklch(89% / 32.5% …)` |
| `accent-soft-foreground` | #005abf | #75bbff | |
| `default-soft-foreground` | #17191b | #fcfcfc | `var(--default-foreground)` |
| `success-soft-foreground` | #006e25 | #5dd480 | |
| `warning-soft-foreground` | #804500 | #ffbf4c | |
| `danger-soft-foreground` | #ce0007 | #ff716c | |

**Perilaku alias tetap terjaga.** `globals.css` mendefinisikan `--button: var(--accent)`;
`diffPalette()` menyimpan **hanya nilai yang berbeda dari default**, jadi baris yang tidak
disentuh **tidak menulis CSS apa pun** dan tombol tetap mengikuti Accent. Mengubah Accent
saja tetap menggerakkan warna tombol — override baru muncul kalau tombol memang mau beda.

**Bonus: `--button-pressed` jadi nyata.** Token itu sebelumnya ada tapi tak dipakai siapa pun;
sekarang 5 tombol punya `active:bg-(--button-pressed)` (stopkontak tekan) sehingga tidak ada
knob mati di panel.

**Bukti:**

- Dump katalog via tsx: `grup: Brand & status | Buttons | Soft chips & badges | Page & surfaces | Lines & chrome`, `total token: 42`, `[Buttons] 6 token` dengan `button-foreground #fcfcfc / #fcfcfc`, dan `default-terdaftar=true` untuk semuanya.
- CSS terkompilasi: `.active\:bg-\(--button-pressed\):active{background-color:var(--button-pressed)}` ada; `color:var(--button-foreground)` dan `background-color:var(--button-hover)` juga.
- `npm run typecheck` **0 error** · `npm run build` **✓ 10,8 s · TS 5,1 s · 12/12 · 0 warning** (BUILD_ID `9_FYBAx6xogFBeiXs_zxL`).
- Simpan dari panel langsung tersiar: `POST /api/admin/palette` → `revalidatePath("/", "layout")`
  (dan `DELETE` yang sama untuk reset) — **tanpa** rebuild atau restart.

**Cara pakai:** Admin → tab **Palette** → pilih **Light theme** / **Dark theme** → grup
**Buttons** → baris **"Button text & icon"**.





