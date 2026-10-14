import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 16 * 1024; // 16 KiB
export const MAX_CHUNK_SIZE = 64 * 1024; // 64 KiB cap
export const BUFFER_HIGH_WATERMARK = 1024 * 1024; // 1 MiB
export const BUFFER_LOW_WATERMARK = 256 * 1024; // 256 KiB
export const MOBILE_FALLBACK_MAX_BYTES = 200 * 1024 * 1024; // 200 MB
export const MAX_SDP_BYTES = 64 * 1024; // 64 KiB
export const BINARY_HEADER_BYTES = 25;

export const RoomStatusEnum = z.enum([
  'CREATED',
  'WAITING',
  'PAIRED',
  'ACTIVE',
  'CLOSED',
  'EXPIRED',
]);
export type RoomStatus = z.infer<typeof RoomStatusEnum>;

export const ScreenStateEnum = z.enum([
  'idle',
  'creating',
  'waiting_for_peer',
  'join_pending',
  'connected',
  'negotiating',
  'ready',
  'transferring',
  'verifying',
  'completed',
  'expired',
  'room_full',
  'rejected',
  'incorrect_code',
  'rate_limited',
  'signaling_lost',
  'ice_failed',
  'peer_disconnected',
  'transfer_failed',
  'cancelled',
]);
export type ScreenState = z.infer<typeof ScreenStateEnum>;

export const TransferStateEnum = z.enum([
  'QUEUED',
  'OFFERED',
  'ACCEPTED',
  'SENDING',
  'RECEIVING',
  'VERIFYING',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
  'INTERRUPTED',
]);
export type TransferState = z.infer<typeof TransferStateEnum>;

export const DeviceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w\s\-().]+$/, 'Karakter label perangkat tidak valid');

export const RoomCodeSchema = z
  .string()
  .trim()
  .transform((val) => {
    const digits = val.replace(/\D/g, '');
    return digits.length === 6 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}` : val;
  })
  .refine((val) => /^\d{3}-\d{3}$/.test(val), 'Format kode harus 6 digit (XXX-XXX)');

export const CreateRoomRequestSchema = z.object({
  deviceLabel: DeviceLabelSchema,
});

export const JoinRoomRequestSchema = z.object({
  code: RoomCodeSchema,
  deviceLabel: DeviceLabelSchema,
});

export const RoomSubscribeSchema = z.object({
  roomId: z.string().uuid(),
});

export const WebRtcSdpSchema = z.object({
  roomId: z.string().uuid(),
  sdp: z.object({
    type: z.enum(['offer', 'answer']),
    sdp: z.string().min(10).max(MAX_SDP_BYTES),
  }),
});

export const WebRtcIceCandidateSchema = z.object({
  roomId: z.string().uuid(),
  candidate: z
    .object({
      candidate: z.string().max(2048),
      sdpMid: z.string().max(128).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(32).nullable().optional(),
      usernameFragment: z.string().max(128).nullable().optional(),
    })
    .nullable(),
});

export const SignalTypeEnum = z.enum([
  'join:requested',
  'join:approved',
  'join:rejected',
  'webrtc:offer',
  'webrtc:answer',
  'webrtc:ice-candidate',
  'webrtc:restart',
  'peer:presence',
  'room:closed',
]);
export type SignalType = z.infer<typeof SignalTypeEnum>;

export const SignalMessageSchema = z.object({
  id: z.string(),
  type: SignalTypeEnum,
  roomId: z.string().uuid(),
  senderRole: z.enum(['HOST', 'GUEST', 'SERVER']),
  recipientRole: z.enum(['HOST', 'GUEST', 'ALL']),
  payload: z.any(),
  timestamp: z.number().int(),
});
export type SignalMessage = z.infer<typeof SignalMessageSchema>;

export const SendSignalRequestSchema = z.object({
  roomId: z.string().uuid(),
  type: SignalTypeEnum,
  recipientRole: z.enum(['HOST', 'GUEST', 'ALL']).default('ALL'),
  payload: z.any(),
});
export type SendSignalRequest = z.infer<typeof SendSignalRequestSchema>;


export const TransferControlMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file:offer'),
    transferId: z.string().uuid(),
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    mimeType: z.string().max(128),
    chunkSize: z.number().int().min(1024).max(MAX_CHUNK_SIZE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }),
  z.object({
    type: z.literal('file:accept'),
    transferId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('file:reject'),
    transferId: z.string().uuid(),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('file:cancel'),
    transferId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('file:complete'),
    transferId: z.string().uuid(),
    byteCount: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  z.object({
    type: z.literal('file:verified'),
    transferId: z.string().uuid(),
    receivedBytes: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('file:error'),
    transferId: z.string().uuid(),
    code: z.string().max(64),
  }),
]);

export type TransferControlMessage = z.infer<typeof TransferControlMessageSchema>;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error('Invalid UUID length for binary frame');
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface DecodedChunkFrame {
  version: number;
  transferId: string;
  chunkIndex: number;
  payload: Uint8Array;
}

export function encodeChunkFrame(
  transferId: string,
  chunkIndex: number,
  payload: Uint8Array
): ArrayBuffer {
  if (payload.byteLength > MAX_CHUNK_SIZE) {
    throw new Error(`Chunk payload exceeds MAX_CHUNK_SIZE (${MAX_CHUNK_SIZE})`);
  }
  const buffer = new ArrayBuffer(BINARY_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  view.setUint8(0, PROTOCOL_VERSION);
  uint8.set(uuidToBytes(transferId), 1);
  view.setUint32(17, chunkIndex, false);
  view.setUint32(21, payload.byteLength, false);
  uint8.set(payload, BINARY_HEADER_BYTES);

  return buffer;
}

export function decodeChunkFrame(frame: ArrayBuffer): DecodedChunkFrame {
  if (frame.byteLength < BINARY_HEADER_BYTES) {
    throw new Error('Malformed binary frame: shorter than header size');
  }
  const view = new DataView(frame);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const transferId = bytesToUuid(new Uint8Array(frame, 1, 16));
  const chunkIndex = view.getUint32(17, false);
  const payloadLength = view.getUint32(21, false);

  if (
    payloadLength > MAX_CHUNK_SIZE ||
    BINARY_HEADER_BYTES + payloadLength !== frame.byteLength
  ) {
    throw new Error('Malformed binary frame: length mismatch or oversized payload');
  }

  const payload = new Uint8Array(frame, BINARY_HEADER_BYTES, payloadLength);
  return { version, transferId, chunkIndex, payload };
}
