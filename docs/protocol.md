# NexaShare Binary DataChannel Protocol (v1)

## Binary Frame Header (25 Bytes, Big-Endian)
- Byte `0`: `uint8` Protocol Version (`1`)
- Bytes `1..16`: `16-byte` UUID `transferId`
- Bytes `17..20`: `uint32` `chunkIndex` (Big-Endian)
- Bytes `21..24`: `uint32` `payloadLength` (Big-Endian, max 65536 bytes)
- Bytes `25..N`: Raw `ArrayBuffer` chunk bytes (default 16 KiB)
