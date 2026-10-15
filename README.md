# NexaShare — Secure Browser-to-Browser P2P File Transfer (Vercel Serverless Edition)

Aplikasi transfer berkas P2P lintas jaringan berbasis WebRTC `RTCDataChannel`, tanpa menyimpan berkas di server. Deployment **Vercel** menggunakan Redis untuk metadata sesi dan signaling sementara dengan TTL.

---

## 🚀 Fitur Utama
- **Zero Cloud File Storage**: Berkas ditransfer langsung browser-ke-browser melalui WebRTC `RTCDataChannel`. Redis hanya menyimpan metadata sesi dan signaling sementara, bukan isi berkas.
- **Enkripsi DTLS**: Seluruh transfer data terenkripsi otomatis secara end-to-end melalui Datagram Transport Layer Security (DTLS).
- **Integritas SHA-256**: Pemeriksaan integritas hash SHA-256 secara streaming saat pengiriman dan penerimaan.
- **Pairing Aman**: Kode ruangan 6 digit CSPRNG sekali pakai (kedaluwarsa 5 menit) dengan persetujuan host (*explicit host approval*).
- **QR Code & Deep Link**: Masuk instan dengan memindai QR code atau membuka tautan `/room/:code`.
- **Serverless Signaling**: Deployment Vercel memakai Upstash Redis/KV bersama agar sesi tetap tersedia di semua instance. In-memory hanya untuk pengembangan lokal atau satu server yang terus berjalan.

---

## 🛠️ Deploy ke Vercel (1-Klik)

1. **Push ke GitHub**:
   Pastikan repositori ini sudah di-push ke akun GitHub Anda.
2. **Import ke Vercel**:
   - Buka [vercel.com](https://vercel.com) > **Add New** > **Project** > Pilih repositori ini.
   - Gunakan **Root Directory** repositori (jangan pilih `apps/web`) agar Vercel membaca konfigurasi multi-services di `vercel.json`:
     - **web**: Vite di `apps/web`, menghasilkan `apps/web/dist`.
     - **api**: Express di `apps/api`, dengan sumber `src/app.ts`.
   - Build API menjalankan pemeriksaan TypeScript lalu membundel aplikasi dan dependensinya ke `apps/api/dist/app.cjs`. Bundle CommonJS ini dapat dijalankan walaupun Vercel memindahkan direktori output ke root function, tanpa mengandalkan import TypeScript atau symlink workspace.
3. **Environment Variables (Wajib untuk Vercel)**:
   - Buat Redis di [Upstash Console](https://console.upstash.com/) atau hubungkan integrasi Upstash dari Vercel Marketplace ke proyek ini.
   - Pasang satu pasangan kredensial REST dari database yang sama: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, atau `KV_REST_API_URL` + `KV_REST_API_TOKEN`. Gunakan token dengan izin menulis, bukan readonly token; `REDIS_URL` saja tidak dipakai oleh adapter REST ini.
   - Terapkan pada environment Production (dan Preview jika digunakan), lalu redeploy.
   - Default `ROOM_JOIN_TTL_SECONDS=300` dan `ROOM_PENDING_TTL_SECONDS=300`. Waktu persetujuan dibatasi sisa masa berlaku ruangan; countdown memakai deadline server.
   - Tanpa kredensial lengkap, API mengembalikan `503 STATE_STORE_NOT_CONFIGURED`. Gangguan Redis mengembalikan `503 STATE_STORE_UNAVAILABLE`, tanpa beralih diam-diam ke memori instance.
   - Periksa `/api/v1/health/ready` setelah deploy: status `200` menandakan adapter state bisa diakses, sedangkan `503` menandakan konfigurasi atau layanan belum siap.
   - STUN Google (`stun:stun.l.google.com:19302`) sudah aktif secara default.
   - Untuk Wi-Fi berbeda atau data seluler, STUN saja belum tentu dapat membuat koneksi langsung. Sediakan [server TURN](https://webrtc.org/getting-started/turn-server) lalu isi `TURN_URLS`, `TURN_USERNAME`, dan `TURN_CREDENTIAL` menggunakan kredensial dari provider yang sama. Sertakan endpoint TCP/TLS dari provider jika tersedia untuk jaringan yang membatasi UDP, lalu redeploy.
   - Redis mengoordinasikan sesi/signaling; TURN meneruskan trafik WebRTC terenkripsi saat koneksi langsung gagal. TURN tidak menyimpan berkas. Tanpa konfigurasi TURN, aplikasi hanya dapat mencoba koneksi langsung.
   - Klik **Deploy**!

---

## 💻 Cara Menjalankan Secara Lokal (Development)

Aplikasi tidak membutuhkan database PostgreSQL apapun.

1. **Instal dependensi**:
   ```bash
   npm install
   ```

2. **Jalankan API serverless backend (Terminal 1)**:
   ```bash
   npm run dev:api
   ```
   *Server API akan berjalan di `http://localhost:3000`.*

3. **Jalankan Frontend Vite (Terminal 2)**:
   ```bash
   npm run dev
   ```
   *Buka `http://localhost:5173` di browser Anda.*

4. **Uji Coba Transfer**:
   - Buka `http://localhost:5173` di browser pertama > Klik **Send Files** (Salin kode 6 digit atau buka link di jendela penyamaran/perangkat lain).
   - Di browser kedua > Klik **Receive Files** > Masukkan kode 6 digit > Klik **Connect**.
   - Di browser pertama > Klik **Izinkan (Approve)**.
   - Pilih berkas untuk dikirim. Berkas akan mengalir langsung via WebRTC DataChannel dan otomatis diunduh saat verifikasi SHA-256 selesai!

---

## 🧪 Menjalankan Pengujian (Testing)

```bash
npm test
```
*Menjalankan pengujian Vitest untuk codec protokol chunking biner 16 KiB dan skema sinyal WebRTC, serta smoke test API terhadap bundle produksi yang disalin ke direktori sementara tanpa source atau node_modules. Smoke test memeriksa health check, pembuatan sesi, autentikasi, dan pembuatan ruangan.*

Pengujian WebRTC mencakup urutan signaling, kesiapan dua kanal data, ICE restart dengan batas dua percobaan, penutupan sesi saat menunggu penerimaan berkas, serta pesan selesai yang tiba sebelum data. Aplikasi tetap melakukan polling signaling setelah tersambung agar koneksi dapat dipulihkan tanpa membuat ruangan baru.

Untuk pengujian browser nyata, jalankan `npm run dev` dan buka `http://localhost:5173/test/webrtc.html`. Halaman khusus development ini membuat dua peer dalam satu halaman. Pilih **Connect locally** atau **Connect through production TURN**, uji **Restart ICE**, lalu kirim berkas sintetis dengan tombol yang tersedia atau pemilih berkas. Gunakan **Close peers** setelah selesai; opsi TURN mengambil konfigurasi dari API produksi hanya saat pengujian berjalan. Halaman ini tidak masuk ke build frontend produksi.
