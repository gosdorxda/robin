/**
 * PM2 process file — alternatif systemd. Panduan lengkap: DEPLOY-VPS.md §8b.
 *
 *   cd /var/www/pay
 *   sudo -u pay pm2 start ecosystem.config.js
 *   sudo -u pay pm2 save
 *
 * Isinya sama dengan `npm start` di §8a: `next start`, port 3000, bind 127.0.0.1.
 * Rahasia (DATABASE_URL, TELEGRAM_*, ADMIN_*) TIDAK ditulis di sini — `next start`
 * membacanya sendiri dari `.env` di folder `cwd`.
 *
 * PENTING: fork mode + 1 instance. Scheduler hidup DI DALAM proses Next
 * (`src/instrumentation.ts` → `src/lib/scheduler.ts`), jadi cluster mode atau
 * `-i max` akan menjalankan cron lebih dari sekali (round & sync dobel).
 */
module.exports = {
  apps: [
    {
      name: "pay",
      cwd: __dirname, // /var/www/pay — tempat `.next` dan `.env` berada
      script: "npm",
      args: "run start",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      min_uptime: "20s",
      max_restarts: 20,
      restart_delay: 2000,
      // SIGINT dulu, SIGKILL hanya kalau Next belum selesai menutup koneksi.
      kill_timeout: 10000,
      listen_timeout: 15000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        // Hanya nginx di host ini yang bisa menghubungi port 3000.
        HOSTNAME: "127.0.0.1",
        // Hanya untuk build lama (§8a/§13.3). Build terbaru sudah memaksa IPv4
        // lewat `src/lib/net-ipv4.ts`, jadi jangan diaktifkan tanpa alasan.
        // NODE_OPTIONS: "--dns-result-order=ipv4first --no-network-family-autoselection",
      },
    },
  ],
};
