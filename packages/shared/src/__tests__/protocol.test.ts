import { describe, expect, it } from 'vitest';
import { RoomCodeSchema, decodeChunkFrame, encodeChunkFrame } from '../index';

describe('NexaShare Shared Protocol & Binary Frame Codec', () => {
  it('normalizes 6 digits into XXX-XXX format and rejects invalid codes', () => {
    expect(RoomCodeSchema.parse('482913')).toBe('482-913');
    expect(RoomCodeSchema.parse('482-913')).toBe('482-913');
    expect(() => RoomCodeSchema.parse('12-34')).toThrow();
  });

  it('encodes and decodes a 16 KiB binary chunk frame accurately', () => {
    const transferId = '6f6af0c4-41d0-4e83-9714-ce565322ab62';
    const payload = new Uint8Array(16 * 1024);
    payload.fill(0xab);

    const encoded = encodeChunkFrame(transferId, 42, payload);
    const decoded = decodeChunkFrame(encoded);

    expect(decoded.version).toBe(1);
    expect(decoded.transferId).toBe(transferId);
    expect(decoded.chunkIndex).toBe(42);
    expect(decoded.payload.byteLength).toBe(16 * 1024);
    expect(decoded.payload[0]).toBe(0xab);
  });

  it('rejects truncated or tampered binary frames', () => {
    const malformed = new ArrayBuffer(12);
    expect(() => decodeChunkFrame(malformed)).toThrow(/shorter than header size/);
  });

  it('validates signaling payloads correctly', async () => {
    const { SendSignalRequestSchema } = await import('../index');

    const valid = SendSignalRequestSchema.parse({
      roomId: '6f6af0c4-41d0-4e83-9714-ce565322ab62',
      type: 'webrtc:offer',
      recipientRole: 'GUEST',
      payload: { sdp: 'v=0...' },
    });
    expect(valid.type).toBe('webrtc:offer');
    expect(valid.recipientRole).toBe('GUEST');
  });
});

