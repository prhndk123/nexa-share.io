# NexaShare — Secure Browser-to-Browser P2P File Transfer (Vercel Serverless Edition)

Aplikasi transfer berkas P2P lintas jaringan berbasis WebRTC `RTCDataChannel` **100% tanpa database (Zero-Database)** dan siap di-deploy langsung ke **Vercel**.

---

## 🚀 Fitur Utama
- **Zero Cloud Storage & Zero Database**: Berkas ditransfer langsung browser-ke-browser melalui WebRTC `RTCDataChannel`. Tidak ada berkas atau riwayat yang tersimpan di server atau database.
- **Enkripsi DTLS**: Seluruh transfer data terenkripsi otomatis secara end-to-end melalui Datagram Transport Layer Security (DTLS).
- **Integritas SHA-256**: Pemeriksaan integritas hash SHA-256 secara streaming saat pengiriman dan penerimaan.
- **Pairing Aman**: Kode ruangan 6 digit CSPRNG sekali pakai (kedaluwarsa 5 menit) dengan persetujuan host (*explicit host approval*).
- **QR Code & Deep Link**: Masuk instan dengan memindai QR code atau membuka tautan `/room/:code`.
- **Serverless Signaling**: Berjalan di atas Vercel Serverless Functions dengan dukungan Upstash Redis (Vercel KV) atau In-Memory, serta kompatibel dengan Pusher Channels untuk notifikasi instan.

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
3. **Environment Variables (Opsional)**:
   - Jika ingin menggunakan Upstash Redis untuk state multi-region, pasang integrasi **Upstash Redis** dari Vercel Marketplace (otomatis mengisi `KV_REST_API_URL` dan `KV_REST_API_TOKEN`). Jika tidak diisi, NexaShare otomatis berjalan dengan state in-memory.
   - STUN Google (`stun:stun.l.google.com:19302`) sudah aktif secara default.
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
