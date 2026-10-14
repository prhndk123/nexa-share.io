# NexaShare Security & Privacy Architecture

1. **Zero Cloud Storage**: File chunks are transmitted strictly over WebRTC `RTCDataChannel` (DTLS encrypted).
2. **Signaling Hardening**: Socket.IO namespace `/signal` blocks binary payloads and enforces room-scoped authorization.
3. **Pairing Protection**: 6-digit CSPRNG room codes are stored as keyed HMAC-SHA256 in Redis with 5-minute TTL and mandatory Host approval.
