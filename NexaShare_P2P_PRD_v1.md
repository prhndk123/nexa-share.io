# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# NexaShare — Secure Browser-to-Browser P2P File Transfer

**Version:** 1.0  
**Date:** 14 October 2026  
**Status:** Implementation-ready MVP specification  
**Product type:** Responsive web application / optional PWA  
**Primary language:** Indonesian UI; English technical contracts

---

## 1. Executive Summary

NexaShare adalah aplikasi web yang memungkinkan dua perangkat mentransfer file dua arah melalui internet meskipun menggunakan jaringan berbeda. Pengguna membuat ruang sementara (room), berbagi kode atau QR, menyetujui permintaan bergabung, lalu mentransfer file menggunakan WebRTC RTCDataChannel. File tidak diunggah atau disimpan di application server/database. Server menyediakan signaling, room state, pembatasan akses, dan credential TURN sementara. Saat direct ICE connection tidak memungkinkan, TURN boleh meneruskan paket secara terenkripsi; **P2P Only berarti tidak ada penyimpanan cloud, bukan jaminan tidak ada relay**.

### 1.1 Goals
1. Transfer file lintas jaringan dari browser ke browser tanpa membuat akun.
2. Pengalaman pairing sederhana menggunakan kode 6 digit/QR dengan persetujuan host.
3. File tetap privat: konten hanya diproses pada perangkat pengirim dan penerima (TURN bisa melewatkan ciphertext).
4. UI responsive mobile-first termasuk Android/iOS dan desktop.
5. Multiple files, status progress, transfer completion, cancel, integrity verification.
6. Backend siap deployment self-hosted via Docker dan domain HTTPS.

### 1.2 Non-goals
- Cloud storage, offline inbox, tautan download ketika pengirim offline.
- Bluetooth direct transfer dari browser.
- Background transfer yang dijamin berjalan ketika layar ponsel terkunci atau browser ditutup.
- Persistensi konten file di backend.
- Anonymous public directory/listing room.
- Unlimited file size guarantee atau resume across browser restarts pada MVP.

### 1.3 Fundamental constraints
- Kedua perangkat harus online selama transfer dan membuka aplikasi; background throttling/power-saving bisa mengganggu.
- Signaling dan STUN/TURN memerlukan jaringan internet publik yang dapat dicapai.
- WebRTC data streams menggunakan DTLS encryption; signaling juga wajib HTTPS/WSS.
- TURN mengonsumsi bandwidth server ketika direct P2P gagal; estimasi biaya berdasarkan traffic, bukan hanya jumlah room.
- Browser Safari/iOS, Android Chrome, dan desktop perlu compatibility testing, terutama file save dan mode background.
- Tidak ada transfer offline tanpa jalur lokal/direct radio yang didukung browser.

---

## 2. Target Users and Jobs-to-be-Done

| Persona | Use case | Expected outcome |
|---|---|---|
| Personal mobile user | Transfer foto/video dari HP ke laptop | Tanpa kabel, cepat dan mudah |
| Cross-network user | Kirim dokumen ke rekan di lokasi berbeda | Tidak perlu jaringan Wi-Fi sama |
| Privacy-conscious user | Kirim berkas tanpa menyimpan pada cloud | File hanya disimpan oleh kedua endpoint |
| Technical user | Kirim file besar dan melihat status | Progress, integrity, retry jika gagal |

**Primary job story:** Saat dua perangkat terhubung internet, saya ingin membuka NexaShare, membagikan kode sekali pakai, mengizinkan lawan transfer, dan mengirim/menerima file tanpa registrasi atau cloud.

---

## 3. Product Scope & Feature Priority

| ID | Requirement | Priority | Release |
|---|---|---|---|
| F01 | Create room with short code | P0 | MVP |
| F02 | Join room via code or QR deep link | P0 | MVP |
| F03 | Host explicitly approves joining device | P0 | MVP |
| F04 | WebRTC signaling (offer, answer, ICE candidates) | P0 | MVP |
| F05 | STUN and TURN fallback | P0 | MVP |
| F06 | Send and receive single file | P0 | MVP |
| F07 | Chunked binary transfer and backpressure | P0 | MVP |
| F08 | Transfer progress, bytes, speed, ETA | P0 | MVP |
| F09 | Cancel, timeout, disconnect/error handling | P0 | MVP |
| F10 | End-to-end integrity SHA-256 validation | P0 | MVP |
| F11 | Multiple file transfer queue | P0 | MVP |
| F12 | Room expiration and rate limiting | P0 | MVP |
| F13 | Mobile responsive UX and file download | P0 | MVP |
| F14 | Bidirectional transfer after joining | P1 | MVP if feasible |
| F15 | Drag & drop (desktop) | P1 | MVP |
| F16 | Connection route label: Direct/Relay/Unknown | P1 | V1.1 |
| F17 | Pause/resume within existing healthy session | P1 | V1.1 |
| F18 | Persist resumable transfer across reconnects | P2 | V2 |
| F19 | Installable PWA | P2 | V1.1 |
| F20 | Optional E2EE identity confirmation / safety phrase | P2 | V2 |
| F21 | Optional sender-created long password in addition to room code | P2 | V1.1 |

P0 means mandatory for MVP acceptance; P1 should follow as resources permit; P2 is later scope.

---

## 4. UX and Pages

### 4.1 Pages
- `/` — Home: **Send Files** / **Receive Files**, tagline, simple benefits and privacy notice.
- `/send` — Create room, show room code, QR, expiry countdown, connection state, device join request, select files, queue, progress, completion.
- `/receive` — Input room code, join room, wait for host approval, connected transfer interface with receive/send actions.
- `/room/:roomCode` — Universal invite route; never place access credentials or reusable secrets inside URL; code-only deep link enters verification flow.
- `/privacy` — Explain signaling, TURN relaying, logs, retention and browser limitations.
- `/status` (optional) — Aggregate service health, no room secrets.
- `*` — Not found.

### 4.2 Screen states
`idle -> creating -> waiting_for_peer -> join_pending -> connected -> negotiating -> ready -> transferring -> verifying -> completed`

Error branches: `expired`, `room_full`, `rejected`, `incorrect_code`, `rate_limited`, `signaling_lost`, `ice_failed`, `peer_disconnected`, `transfer_failed`, `cancelled`.

### 4.3 User-facing copy
- Room: **Kode transfer: 482-913**
- Security: **Pastikan kamu mengenali perangkat yang meminta koneksi.**
- Send warning: **Kedua perangkat harus tetap online dan browser tetap terbuka selama transfer.**
- TURN notice: **Jika koneksi langsung gagal, sistem dapat menggunakan server relay terenkripsi. File tidak disimpan di server.**
- Successful transfer: **File selesai diterima dan lolos pemeriksaan integritas.**

### 4.4 Responsive accessibility
- Mobile-first with touch targets >=44 px, 320 px minimum layout support.
- Desktop drag-and-drop; mobile native file picker.
- All status messages readable by assistive technology (`aria-live`), color not the sole status indicator.
- Keyboard focus order and visible loading/error state.
- Must test file save via iOS Safari/Chrome iOS (both WebKit constraints) and Android Chrome.

---

## 5. User Flows

### 5.1 Host: Create, pair, transfer
1. Open HTTPS NexaShare > **Send Files**.
2. Browser obtains ephemeral anonymous session token from API.
3. `POST /v1/rooms` creates one room. Server responds with code and expiry (default 5 minutes for first join).
4. Host sees code, QR and pending timer; can copy/share.
5. Guest submits code, rate-limited server validates room and creates pending join request.
6. Host sees guest device label (self-reported and untrusted) and taps **Approve** or **Reject**.
7. Server binds exactly two authorized session identities to room and grants scoped signaling capability.
8. Peers negotiate WebRTC through Socket.IO offer/answer/ICE.
9. Peer ICE connection reaches connected; `RTCDataChannel` is open.
10. Host selects file(s), app sends metadata offer; guest explicitly accepts file or selected batch.
11. Sender streams small binary chunks with flow control; receiver writes where feasible or assembles with a clear memory limit.
12. Receiver verifies total length and final SHA-256 digest; sends signed-by-session application ACK (not cryptographically identity-signed).
13. Both clients show completed status, server receives minimal non-sensitive event if analytics enabled.
14. Either user can send more files within the same authorized room; room closes on explicit leave, disconnection grace expiry, or max lifetime.

### 5.2 Guest: Join
1. Open `/receive` or deep link.
2. Type 6-digit code and select **Connect**.
3. Server performs code verification with generic failed-response behavior.
4. Wait for host authorization; auto-expire pending request after 60 seconds.
5. Once approved, negotiate WebRTC and receive file offer.
6. User accepts or declines; download target determined by browser supported API.

### 5.3 Recovery
- Host refresh: room-owned ephemeral identity recovery via secure, short-lived server-issued capability if enabled; otherwise create a fresh room (MVP baseline).
- Guest refresh: must rejoin and be approved again unless scoped recovery tokens are built.
- ICE failed: trigger one controlled ICE restart and optionally force TURN as second attempt; show actionable error if still unavailable.
- Transfer interrupted: mark incomplete, delete partial temporary buffers; transfer begins again in MVP.
- Duplicate file name: browser-controlled save handling; never silently overwrite.

### 5.4 Sequence diagram
```mermaid
sequenceDiagram
    participant A as Host A
    participant S as Signaling/API
    participant B as Guest B
    participant T as STUN/TURN
    A->>S: POST /rooms (ephemeral identity)
    S-->>A: Room code + expiresAt
    B->>S: Join request(roomCode)
    S-->>A: join:requested
    A->>S: approve(requestId)
    S-->>B: join:approved + scoped session
    A->>S: SDP offer
    S->>B: SDP offer
    B->>S: SDP answer
    S->>A: SDP answer
    A-->>T: ICE gathering/checks
    B-->>T: ICE gathering/checks
    A->>B: WebRTC DataChannel encrypted (direct or via TURN)
    A->>B: File metadata offer
    B->>A: Accept
    loop Every chunk
        A->>B: Binary chunk
        B->>A: Progress ACK if required
    end
    B->>B: Verify hash
    B->>A: Transfer complete ACK
```

---

## 6. Architecture

### 6.1 Logical components
1. **Web client:** React + TypeScript + Vite, Tailwind, shadcn/ui, Zustand, TanStack Query, Zod.
2. **API server:** Node.js LTS + Express + Zod schema validation; anonymous session token, room lifecycle, rate limits, TURN credential issuance.
3. **Signaling:** Socket.IO over HTTPS/WSS; authenticated room-scoped offer/answer/ICE relay; no binary file events allowed.
4. **State:** Redis for active rooms, user presence, short TTL joining requests, locks, retry counters; can start single-instance without Redis only for local development.
5. **Database:** PostgreSQL + Prisma for sanitized optional session/transfers metadata (no file blob, no room passcode in plaintext).
6. **NAT traversal:** STUN plus self-hosted coturn with temporary TURN REST auth credentials; prefer direct candidate route.
7. **Reverse proxy:** Nginx or Caddy with TLS, WSS upgrade, HSTS after verification.
8. **Observability:** structured minimal logs, error counts, anonymized latency metrics, no secrets/SDP raw dump or filenames by default.

### 6.2 Data plane vs control plane
**Control plane:** browser <-> HTTPS/WSS API/signaling server; exchange authorization, room events, SDP and ICE.  
**Data plane:** browser A <-> browser B directly, or browser A <-> TURN <-> browser B. Do not send file bytes through REST, Socket.IO, databases, object storage, or application server endpoints.

### 6.3 Example deployment diagram
```mermaid
flowchart LR
  A[Browser A] <-->|WebRTC DataChannel / DTLS| B[Browser B]
  A <-->|HTTPS + WSS| P[Reverse Proxy]
  B <-->|HTTPS + WSS| P
  P --> API[Express + Socket.IO]
  API --> R[(Redis TTL State)]
  API --> DB[(PostgreSQL Metadata)]
  API -->|Temporary credentials| C[coturn STUN/TURN]
  A -.->|ICE / relay fallback| C
  B -.->|ICE / relay fallback| C
```
**Note:** dashed TURN connections are optional fallback. Diagram direct arrow is conceptual; actual route depends on ICE candidate selection.

### 6.4 Repo structure
```text
nexashare/
  apps/
    web/
      src/app/
      src/pages/
      src/features/rooms/
      src/features/transfer/
      src/lib/webrtc/
      src/lib/api/
      src/components/
    api/
      src/modules/auth/
      src/modules/rooms/
      src/modules/signaling/
      src/modules/turn/
      src/modules/audit/
      prisma/schema.prisma
  packages/
    shared/  # Zod schemas / protocol types / enums
  infra/
    compose.yaml
    nginx/
    coturn/
  tests/
    e2e/
    integration/
  docs/
    adr/
    protocol.md
    security.md
```

### 6.5 Deployment requirements
- Public domain and valid HTTPS certificate for web/API.
- TURN hostname with public IP, UDP/TCP port 3478 (or configured alternative), TLS 5349 or 443 where supported, and controlled relay UDP port range.
- Set coturn `external-ip` appropriately when behind NAT; enforce firewall allowlist/port exposure carefully.
- Use independent secrets for API auth and TURN REST auth; rotate regularly.
- Redis persistency not required for temporary room state; recover gracefully after restart.
- Graceful deploy causes active sessions to lose signaling; existing established data channels may continue but recovery behavior must be tested.
- Manage bandwidth/concurrency and monitor TURN egress (cost risk).

---

## 7. WebRTC Data Transfer Protocol

### 7.1 Transport decisions
- `RTCPeerConnection` with ICE server configs acquired from short-lived `GET /v1/ice-servers` under authorized ephemeral session.
- One reliable, ordered `RTCDataChannel` for the MVP file stream; control messages multiplexed with typed binary frames or separated control channel (recommended separate reliable control channel).
- Default chunk payload **16 KiB** for broad browser compatibility; tune based on negotiated `RTCSctpTransport.maxMessageSize` and testing.
- Backpressure: stop enqueueing when `bufferedAmount` exceeds high watermark (example 1 MiB), await `bufferedamountlow` threshold (example 256 KiB) before continuing.
- Never read an entire multi-gigabyte file into RAM for sending.
- Max active concurrent file streams: 1 for MVP, multiple files queued sequentially.
- No aggressive compression by default; avoid wasting CPU and compression side-channel surprises.

### 7.2 Protocol messages
```ts
type TransferControlMessage =
  | { type: 'file:offer'; transferId: string; name: string; size: number; mimeType: string; chunkSize: number; sha256?: string }
  | { type: 'file:accept'; transferId: string }
  | { type: 'file:reject'; transferId: string; reason?: string }
  | { type: 'file:cancel'; transferId: string }
  | { type: 'file:complete'; transferId: string; byteCount: number; sha256: string }
  | { type: 'file:verified'; transferId: string; receivedBytes: number }
  | { type: 'file:error'; transferId: string; code: string };
```
Binary chunk frame header: protocol version, `transferId` (16-byte identifier), `chunkIndex` (uint32/uint64 depending design), payload length, followed by ArrayBuffer payload. Specify byte ordering in `docs/protocol.md` and reject malformed/oversized frames. Correlate verification ACK with session and transferId.

### 7.3 Integrity
- Sender streams file and computes SHA-256 incrementally using an audited incremental hashing implementation; native `crypto.subtle.digest()` alone is not streaming.
- Receiver computes SHA-256 during receipt and compares hash transmitted after sender finalization; total bytes must match expected size.
- WebRTC DTLS already protects transit from network observers. Hash validates accidental corruption/protocol completeness; if stronger sender identity is needed, introduce independently verified key identity in V2.

### 7.4 Receiving large files
- Prefer streamed writing via capability-detected File System Access API on browsers that support it with a user gesture.
- Provide fallback to Blob-based download with explicit warning and conservative tested size cap (e.g., 200 MB mobile until validated), not a false unlimited guarantee.
- Optional browser-supported streaming save library must be evaluated for security, browser support, and UX before adoption.
- Revoke object URLs and release buffers after download; ask user before accepting file larger than supported memory capacity.

### 7.5 Transfer states
`QUEUED -> OFFERED -> ACCEPTED -> SENDING/RECEIVING -> VERIFYING -> COMPLETED`  
Errors: `REJECTED`, `CANCELLED`, `FAILED`, `INTERRUPTED`.

### 7.6 Progress calculations
- `progress = acknowledgedOrReceivedBytes / totalSize * 100`. Clearly distinguish sent-to-buffer vs actually received.
- Show throughput (moving average, e.g. last 5 seconds) and ETA when >= stable sample size.
- Verify step displayed separately: `100% transferred` does not equal `complete` until receiver acknowledgment.

---

## 8. Security and Privacy Requirements

### 8.1 Threat model
| Risk | Mitigation |
|---|---|
| Room code brute force | Cryptographically random code, per-IP/session/room limits, generic failure messages, short TTL, lockouts |
| Unwanted guest | Mandatory host approval with explicit transfer file acceptance |
| Device name spoofing | Mark user-supplied label as unverified; confirm on-screen safety phrase if higher assurance needed |
| Room hijacking | Scoped random session capability tokens, origin checking, authorization for every socket event |
| Signaling tampering | HTTPS/WSS, validate signaling direction/state/shape, restrict sender + receiver IDs |
| Flooding/DoS | payload cap, per-event rate limit, bounded active rooms/connections, TURN quotas |
| SDP/ICE metadata leak | Avoid persistent recording, strict auth, minimal log, disclose peer IP exposure potential |
| Malicious files | Explicit consent, treat received files as untrusted; never execute or auto-preview untrusted active content |
| TURN abuse | Time-limited credentials, service quota, network ACLs, telemetry and abuse revocation |
| Resource exhaustion | Per-room max file queue, chunk buffering cap, sender/receiver file size caps |
| XSS/CSRF | CSP, no untrusted HTML, SameSite cookies if used, strict CORS/origin check |
| Metadata retention | Retention policy, default no file names in logs/database, cleanup jobs |

### 8.2 Pairing model (MVP)
- Generate 6-digit code using CSPRNG; 1,000,000 possible values, so **must** combine with rate limiting and host approval.
- Format `XXX-XXX`; expires after 5 minutes without guest successfully joining.
- Store keyed hash or secure server-side mapping rather than storing room codes in durable logs.
- 1 approved guest per room; room locks after approval.
- Guest sends join request; host explicitly approves. Limit outstanding pending joins to 1–3 and 5 attempts per IP over a sliding interval (initial configurable policy; tune against NAT/shared offices).
- Pairing authorization uses a separate high-entropy bearer capability (e.g., 128+ random bits), NOT the six-digit code itself.
- Guest and host each receive short-lived, separately scoped signaling tokens; never share these via QR.
- Expire waiting rooms quickly; connected room lifetime cap (e.g. 2 hours), configurable extension with mutual consent for large files.
- Connection close should revoke future signaling authority and delete ephemeral room keys.

### 8.3 Encryption policy
- Transit: HTTPS/TLS, WSS, WebRTC DTLS for RTCDataChannel.
- **Do not falsely promise verified end-to-end identity** with 6-digit code alone. Server-mediated pairing/signaling is a trusted component in the MVP; malicious signaling infrastructure could interfere with identity negotiation.
- V2 may add a human-verifiable key fingerprint/safety phrase and/or end-to-end file-level encryption using ephemeral ECDH-derived keys.
- TURN forwards encrypted WebRTC transport and is not cloud file storage.

### 8.4 Data minimization
- Application database contains no file content or chunks.
- Default: do not persist original filename, MIME type, client IP, SDP, ICE candidates, raw access tokens, or room code.
- Opt-in/necessary telemetry: anonymized transfer size bracket, timestamps, status, and ICE route type without sensitive content.
- Short retention example: operational metadata 7 days, security throttling counters 24h; exact policy configurable and documented.
- Logs scrub Authorization headers, cookies, room codes and TURN credentials.

---

## 9. Data Model and PostgreSQL / Prisma Schema

### 9.1 Storage allocation
**Redis (primary realtime source of truth):** room code mapping, room status, host/guest ephemeral session IDs, pending join, challenge expiry, room TTL, ICE authorization, attempt counters.  
**PostgreSQL (optional durable audit/analytics):** sanitized room lifecycle and transfer outcomes. Store no file bytes and no room secret.

### 9.2 Suggested Prisma schema
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum RoomStatus {
  CREATED
  WAITING
  PAIRED
  ACTIVE
  CLOSED
  EXPIRED
}

enum TransferStatus {
  OFFERED
  ACCEPTED
  TRANSFERRING
  VERIFYING
  COMPLETED
  REJECTED
  CANCELLED
  FAILED
  INTERRUPTED
}

enum ConnectivityMode {
  DIRECT
  RELAY
  UNKNOWN
}

model RoomSession {
  id             String          @id @default(uuid()) @db.Uuid
  status         RoomStatus      @default(CREATED)
  createdAt      DateTime        @default(now())
  pairedAt       DateTime?
  closedAt       DateTime?
  expiresAt      DateTime
  connectivity   ConnectivityMode @default(UNKNOWN)
  transfers      TransferRecord[]

  @@index([createdAt])
  @@index([status, expiresAt])
}

model TransferRecord {
  id          String         @id @default(uuid()) @db.Uuid
  roomId      String         @db.Uuid
  room        RoomSession    @relation(fields: [roomId], references: [id], onDelete: Cascade)
  status      TransferStatus @default(OFFERED)
  fileSize    BigInt
  bytesSent   BigInt         @default(0)
  startedAt   DateTime       @default(now())
  completedAt DateTime?
  errorCode   String?        @db.VarChar(40)

  @@index([roomId, startedAt])
  @@index([status, startedAt])
}
```

**Important:** Prisma SQL datasource configuration may require adjustments for the exact installed Prisma major version (e.g., adapter/config-based connection setup). Pin dependencies and validate schema in the selected version. `TransferRecord` is server-reported telemetry only; actual file integrity is checked endpoint-side. Do not regard client-reported success as audit-grade evidence.

### 9.3 Redis key design
```text
room:code:<HMAC_OF_CODE>   -> roomId                         TTL 5m until paired
room:<roomId>              -> status, hostSessionId, guestSessionId, expiry TTL
room:<roomId>:pending      -> requestId, guestSessionId, expiry TTL 60s
session:<hashedToken>      -> sessionId, roomId, role, scoped permissions TTL
rate:join:ip:<hash>        -> sliding-window counter TTL
rate:join:session:<hash>   -> sliding-window counter TTL
```

Server protects the room-code mapping from enumeration; do not use simple unsalted raw hashes for low-entropy codes in database exports. A server-side HMAC secret is suitable for code lookup.

---

## 10. REST API Contract

**Base URL:** `/api/v1`  
**Content-Type:** `application/json`  
**Auth:** ephemeral device session (secure HttpOnly SameSite cookie when possible or short-lived bearer token with careful XSS defenses). Example uses bearer terminology; exact method must be consistent across Socket.IO and HTTP.

### 10.1 Endpoints
| Method | Route | Role | Description |
|---|---|---|---|
| POST | `/sessions` | Anonymous | Issue short-lived device session |
| POST | `/rooms` | Session holder | Create room/code |
| GET | `/rooms/:roomId` | Authorized member | Return room metadata; no secret code for guest |
| POST | `/rooms/join` | Session holder | Request to join using code |
| POST | `/rooms/:roomId/requests/:requestId/approve` | Host | Approve guest |
| POST | `/rooms/:roomId/requests/:requestId/reject` | Host | Reject guest |
| POST | `/rooms/:roomId/leave` | Member | Leave/close room |
| GET | `/ice-servers` | Approved member | Return STUN and short-lived TURN credentials |
| GET | `/health/live` | Internal/public limited | Liveness |
| GET | `/health/ready` | Internal only | Readiness with dependencies |

### 10.2 Create room request/response
```http
POST /api/v1/rooms
Authorization: Bearer <ephemeral-session-token>
Content-Type: application/json

{"deviceLabel":"Laptop Chrome"}
```
```json
{
  "roomId": "6f6af0c4-41d0-4e83-9714-ce565322ab62",
  "code": "482-913",
  "expiresAt": "2026-10-14T07:00:00.000Z",
  "status": "WAITING",
  "inviteUrl": "https://share.example.com/room/482-913"
}
```
These are illustrative values; runtime must generate randomness and server time, not hard-code examples.

### 10.3 Join request/response
```http
POST /api/v1/rooms/join
Authorization: Bearer <guest-ephemeral-session-token>
Content-Type: application/json

{"code":"482-913","deviceLabel":"iPhone Safari"}
```
```json
{
  "requestId": "90f9835d-4ced-4b0e-af5f-386609809785",
  "status": "PENDING_APPROVAL",
  "expiresInSeconds": 60
}
```
Avoid leaking whether arbitrary codes exist to unauthenticated high-rate callers. A pending response is not itself signaling permission.

### 10.4 ICE server response
```json
{
  "iceServers": [
    {"urls":["stun:turn.example.com:3478"]},
    {
      "urls":["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"],
      "username":"<short-lived-username>",
      "credential":"<short-lived-secret>"
    }
  ],
  "ttlSeconds": 600
}
```
Credentials are placeholders and must be issued only to authorized participants, with host-specific setup and expiration.

### 10.5 Common errors
```json
{
  "error": {
    "code": "ROOM_UNAVAILABLE",
    "message": "Ruangan tidak tersedia atau kode sudah kedaluwarsa.",
    "requestId": "req_01..."
  }
}
```
Status codes: `400` malformed payload, `401` missing/invalid session, `403` unauthorized role, `404` hidden/unavailable resource, `409` invalid state transition, `410` expired (only after authorization), `429` rate limited, `503` dependency down. Use uniform user-visible copy for room guessing.

---

## 11. Socket.IO Event Contract

**Namespace:** `/signal`  
Socket connection must authenticate short-lived session and authorized room membership. Enforce server-side payload schema, sender identity, target membership, allowed room status, event rate and maximum message size.

| Direction | Event | Payload essentials |
|---|---|---|
| Server -> Host | `join:requested` | roomId, requestId, unverified deviceLabel |
| Server -> Guest | `join:approved` | roomId, memberRole, signaling readiness |
| Server -> Guest | `join:rejected` | requestId, generic reason |
| Client -> Server | `room:subscribe` | roomId (authorization checked) |
| A -> B relay | `webrtc:offer` | roomId, sdp (validated RTCSessionDescription) |
| B -> A relay | `webrtc:answer` | roomId, sdp |
| Both ways | `webrtc:ice-candidate` | roomId, candidate |
| Server -> Both | `peer:presence` | connected/disconnected |
| Server -> Both | `room:closed` | reason |
| Both ways | `webrtc:restart-requested` | roomId (rate limited) |

**Never implement `file:chunk` on Socket.IO.** File metadata, file acceptance, file progress and file bytes should travel over the authenticated WebRTC DataChannel after pairing. Reject signaling events with binary attachment payloads.

**Event state constraints:** `webrtc:offer`, `webrtc:answer` and `webrtc:ice-candidate` only permitted after approved pairing. Restrict peer count to two and SDP message size (e.g. 64 KiB; evaluate realistic limits), prevent replay outside same room generation.

---

## 12. Detailed Functional Acceptance Criteria

### AC-01 Create room
- Host can create a code within 2 seconds under healthy staging conditions (target, not guarantee).
- Code generated from CSPRNG, expires, and is absent from logs.
- QR resolves to invitation page but not to privileged room membership.

### AC-02 Join and approval
- Valid code creates pending request; transfer cannot proceed before host approval.
- Unapproved guest cannot obtain TURN credentials or send SDP events into room.
- Max one guest approved per room, and join attempts are rate-limited.

### AC-03 Connectivity
- A and B on separate mobile Wi-Fi/carrier networks can establish transfer with direct or TURN route when network permits.
- ICE failure displays meaningful retry option; no endless loading.
- Transport remains encrypted when using TURN.

### AC-04 Transfer correctness
- Send small text file, image, PDF, ZIP, large video; received bytes equal source and SHA-256 matches.
- Multiple-file queue handles failures without skipping/duplicating files.
- On cancel, both sides agree transfer is cancelled; no false completion.
- File chunks never hit REST APIs, Socket.IO or PostgreSQL.

### AC-05 Mobile compatibility
- Tested with current Android Chrome, iOS Safari and desktop Chrome/Firefox/Edge as defined in release test matrix.
- Download handling on mobile clearly indicates whether browser supports saving target size.
- Locking phone or closing tab warns of possible interruption; do not claim background guarantee.

### AC-06 Reliability and security
- Pairing expires as intended; room closes/revokes after completion/disconnection according to policy.
- Rate limit, unauthorized signaling injection, code enumeration, payload overflow and XSS tests pass.
- Monitoring shows connected success rate and TURN traffic without collecting file content.

---

## 13. Non-functional Requirements and Initial Targets

These are engineering targets to validate through benchmarks, not guaranteed production SLAs.

| Category | Initial target |
|---|---|
| Service availability | 99.5% monthly after production hardening |
| Room creation API p95 | <500 ms on normal load |
| Signaling delivery p95 | <250 ms on stable internet |
| WebRTC connect success | >=95% across supported test network matrix with TURN fallback (measure) |
| Time to connect p95 | <15 seconds when target networks permit (measure) |
| Integrity | 100% SHA-256 match for reported completed files |
| Backend content storage | Zero file bytes persistently or transiently handled by app API |
| Initial maximum file size | 200 MB mobile fallback; higher sizes conditional on streaming support and validated browsers |
| Active rooms | Load test with 100 concurrent rooms, revise with server capacity |
| Room first-join expiry | 5 minutes |
| Pending guest approval expiry | 60 seconds |
| Connected max room lifetime | 2 hours initially; adjustable for long files |

Performance depends on peer upload speeds, radio conditions and TURN route. Avoid marketing claims about unlimited size and guaranteed speed.

---

## 14. Observability, Operations, and Abuse Prevention

### 14.1 Metrics
- `rooms_created_total`, `rooms_paired_total`, `rooms_expired_total`
- `rtc_connection_success_total`, `rtc_connection_failure_total`
- `rtc_ice_connect_seconds` histogram
- `connection_route_direct_total`, `connection_route_relay_total` (client-report estimates)
- `transfer_verified_total`, `transfer_failed_total`
- `turn_egress_bytes`, `turn_active_allocations`
- API p95 latency, socket connections, Redis memory and API error rate.

### 14.2 Alerting
- TURN egress spikes, abnormal allocation ratio, failed joins, connection success drop, API 5xx, disk exhaustion and TLS expiry.

### 14.3 Privacy safeguards
- Redact credentials and room codes before structured logs.
- Do not log SDP or ICE candidates in production.
- Minimize retained IP; keep necessary anti-abuse counters in TTL Redis store only.
- Publish disclosure: peers might learn network addresses depending on ICE route and browser mDNS behavior.

---

## 15. Test Plan

### 15.1 Unit tests
- Room finite state machine, TTL behavior, access permission, rate limiter.
- Code generation uniqueness/distribution sanity, HMAC mapping.
- Transfer protocol serialization, chunk ordering, SHA-256 verification, cancel handling.

### 15.2 Integration tests
- API -> Redis room create/join/approve/expire.
- Socket signaling authorization and state transitions.
- TURN short-lived credentials validation and expiration.
- ICE negotiation on two test browsers in containers where feasible.

### 15.3 E2E matrix
| Scenario | Mandatory |
|---|---|
| Desktop Chrome -> Desktop Chrome on different networks | Yes |
| Android Chrome -> Desktop Chrome | Yes |
| iOS Safari -> Desktop Chrome | Yes |
| Direct ICE success | Yes |
| Forced TURN relay success | Yes |
| Wrong code, expired code, guest rejection | Yes |
| File 1 KB / 10 MB / 100 MB | Yes |
| Large file with streamed disk save | On supported browser |
| 5 files mixed type in queue | Yes |
| Sender abort, receiver abort, network drop | Yes |
| Browser refresh and app background behavior | Yes |
| Malformed SDP/ICE and oversize signaling | Yes |
| Unauthorized socket room subscription | Yes |
| TURN credential abuse test | Yes |

### 15.4 Security checks
- OWASP ASVS-inspired authentication/session checks, CSRF/CORS, CSP, XSS and security headers.
- Fuzz signaling messages, enforce maximum frames and validated field lengths.
- Verify no binary file is transmitted to application backend by checking API/socket network captures.
- Verify TURN only sees encrypted transport and credentials are time-limited.

---

## 16. Implementation Roadmap

### Sprint 0 — Foundations (3–5 working days)
- Monorepo/workspace, lint/format/test, Docker Compose (api, redis, postgres, coturn), environment validation, TLS local staging.
- Define protocol and state machine types in `packages/shared`.
- Deliverable: running shell with healthy API and browser connectivity.

### Sprint 1 — Room and authorization (4–6 days)
- Anonymous ephemeral session, create/join/approve/reject/leave/expire.
- Redis TTL, CSPRNG code, rate limiting, Zod schemas.
- UI homepage/send/receive and QR code.
- Deliverable: secure room pairing from two browsers.

### Sprint 2 — WebRTC connection (5–7 days)
- Socket.IO signaling, offer/answer/ICE.
- coturn STUN/TURN credentials and NAT/firewall testing.
- ICE route diagnosis and controlled retry.
- Deliverable: authenticated RTCDataChannel on dissimilar networks.

### Sprint 3 — File transfer engine (6–9 days)
- Chunking, backpressure, file metadata acceptance, queue, hash validation.
- Receiving streaming path and fallback, cancel/failure states.
- Deliverable: reliable P2P transfers with cross-device verification.

### Sprint 4 — UX, QA and release hardening (5–8 days)
- Mobile and accessibility testing, multiple file UX, error copy, telemetry/privacy.
- Security testing, load tests, TURN cost observability, production deployment.
- Deliverable: deployable MVP with test evidence and runbooks.

**Estimated total:** 23–35 working days for a solo experienced full-stack developer; adjust for skill level, browsers, networking infrastructure, and test device availability. These are engineering planning estimates, not commitments.

### Definition of Done for MVP
- All P0 acceptance criteria verified.
- No persistent file storage on app server; data path audited.
- Two-network actual device demo works; forced TURN test works.
- Common errors produce recoverable UX.
- Secrets are externalized; domains and TLS production-ready.
- Monitoring and incident runbook exist.

---

## 17. Delivery Milestones / Backlog (Suggested)

| Epic | Stories | Dependencies |
|---|---|---|
| Infrastructure | repo, compose, env, CI | none |
| Pairing | sessions, rooms, approval, expiry | Redis, API |
| WebRTC | signaling, ICE, STUN, TURN, retry | pairing |
| File transfer | protocol, chunker, writer, verification | WebRTC |
| Frontend | responsive screens, QR, progress, errors | pairing / transfer |
| Operations | privacy, metrics, security, tests, deployment | all |

### First implementation tasks
1. Initialize Vite + React + TypeScript and Express workspace.
2. Implement Zod DTOs for all room and socket events.
3. Build Redis TTL-backed room FSM with server-side approval.
4. Implement Socket.IO access middleware; never trust roomId/role from client alone.
5. Stand up coturn and issue credentials scoped by TTL.
6. Prove text-only RTCDataChannel between different networks.
7. Implement 16 KiB chunk streaming with buffer backpressure.
8. Add receiver acceptance, writing strategy, SHA-256 and cancel.
9. Build test matrix and publish HTTPS production deployment.

---

## 18. Decisions, Trade-offs, and Open Questions

| Topic | MVP decision | Revisit later |
|---|---|---|
| P2P meaning | No cloud file persistence; TURN relay allowed | Strict direct-only mode for expert use |
| Accounts | Anonymous ephemeral sessions | Accounts and trusted devices |
| Room code | 6-digit + host approval + limits | Passphrase, QR protected confirmation |
| Participant count | Exactly 2 devices | Multi-peer broadcast |
| Transfer concurrency | One file at a time, FIFO queue | Parallel multi-file streams |
| Resume | Restart upon broken connection | Chunk-level resume with IndexedDB checkpoints |
| Encryption | Standard WebRTC DTLS, HTTPS/WSS | Verified cryptographic identity/file-level E2EE |
| Filename retention | None on server | Privacy-preserving optional history |
| Database | Optional sanitized metadata | Remove SQL entirely if logs/analytics not needed |
| Mobile large file | Conservative cap without streaming capability | Capability-specific limits from real device tests |

---

## 19. Suggested Environment Variables

```dotenv
NODE_ENV=production
APP_ORIGIN=https://share.example.com
API_ORIGIN=https://api.share.example.com
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@postgres:5432/nexashare
REDIS_URL=redis://redis:6379
SESSION_SIGNING_SECRET=<long-random-secret>
ROOM_CODE_HMAC_SECRET=<different-long-random-secret>
ROOM_JOIN_TTL_SECONDS=300
ROOM_PENDING_TTL_SECONDS=60
ROOM_CONNECTED_TTL_SECONDS=7200
TURN_HOST=turn.example.com
TURN_SHARED_SECRET=<independent-long-random-secret>
TURN_CREDENTIAL_TTL_SECONDS=600
RATE_JOIN_LIMIT=5
RATE_JOIN_WINDOW_SECONDS=300
LOG_LEVEL=info
```

Never commit real secrets. Use secret manager or environment injection and rotate deployed credentials.

---

## 20. References

- WebRTC official: https://webrtc.org/getting-started/peer-connections
- WebRTC TURN server: https://webrtc.org/getting-started/turn-server
- MDN RTCDataChannel: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
- MDN backpressure: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold
- OWASP File Upload Cheat Sheet (applies chiefly to security of handling untrusted files/related endpoints): https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

**End of PRD.**
