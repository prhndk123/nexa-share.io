import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  BUFFER_HIGH_WATERMARK,
  BUFFER_LOW_WATERMARK,
  DEFAULT_CHUNK_SIZE,
  MOBILE_FALLBACK_MAX_BYTES,
  TransferControlMessageSchema,
  decodeChunkFrame,
  encodeChunkFrame,
  type TransferControlMessage,
  type TransferState,
} from '@nexashare/shared';

export interface TransferProgressSnapshot {
  transferId: string;
  fileName: string;
  totalBytes: number;
  processedBytes: number;
  percentage: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  state: TransferState;
  sha256?: string;
  error?: string;
}

interface IncomingTransferContext {
  transferId: string;
  name: string;
  size: number;
  mimeType: string;
  receivedBytes: number;
  expectedChunkIndex: number;
  hasher: ReturnType<typeof sha256.create>;
  writableStream?: any;
  memoryChunks: Uint8Array[];
}

export class NexaShareTransferEngine {
  private pc: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannel: RTCDataChannel | null = null;

  private incoming = new Map<string, IncomingTransferContext>();
  private pendingAcceptResolvers = new Map<string, (accepted: boolean) => void>();
  private pendingVerifyResolvers = new Map<string, () => void>();
  private cancelledTransfers = new Set<string>();
  private speedSamples: Array<{ timestamp: number; bytes: number }> = [];

  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    private readonly callbacks: {
      onSignalOffer: (sdp: RTCSessionDescriptionInit) => void;
      onSignalAnswer: (sdp: RTCSessionDescriptionInit) => void;
      onSignalIceCandidate: (candidate: RTCIceCandidateInit | null) => void;
      onConnectionStateChange: (
        state: RTCPeerConnectionState,
        route: 'DIRECT' | 'RELAY' | 'UNKNOWN'
      ) => void;
      onIncomingFileOffer: (
        offer: Extract<TransferControlMessage, { type: 'file:offer' }>
      ) => Promise<{
        accept: boolean;
        writableStream?: any;
      }>;
      onProgress: (snapshot: TransferProgressSnapshot) => void;
    }
  ) {}

  async initialize(iceServers: RTCIceServer[], isInitiator: boolean): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onicecandidate = (event) => {
      this.callbacks.onSignalIceCandidate(event.candidate ? event.candidate.toJSON() : null);
    };

    this.pc.onconnectionstatechange = async () => {
      if (!this.pc) return;
      const route = await this.detectCandidateRoute();
      this.callbacks.onConnectionStateChange(this.pc.connectionState, route);
    };

    if (isInitiator) {
      this.controlChannel = this.pc.createDataChannel('nexashare-control', { ordered: true });
      this.dataChannel = this.pc.createDataChannel('nexashare-data', { ordered: true });
      this.setupControlChannel(this.controlChannel);
      this.setupDataChannel(this.dataChannel);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.callbacks.onSignalOffer(offer);
    } else {
      this.pc.ondatachannel = (event) => {
        if (event.channel.label === 'nexashare-control') {
          this.controlChannel = event.channel;
          this.setupControlChannel(event.channel);
        } else if (event.channel.label === 'nexashare-data') {
          this.dataChannel = event.channel;
          this.setupDataChannel(event.channel);
        }
      };
    }
  }

  async handleRemoteOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      await this.flushPendingCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.callbacks.onSignalAnswer(answer);
    } catch (err) {
      console.error('handleRemoteOffer error:', err);
    }
  }

  async handleRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.flushPendingCandidates();
    } catch (err) {
      console.error('handleRemoteAnswer error:', err);
    }
  }

  async handleRemoteIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!this.pc || !candidate) return;
    if (!this.pc.remoteDescription || !this.pc.remoteDescription.type) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('addIceCandidate error:', err);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc || this.pendingCandidates.length === 0) return;
    const queued = [...this.pendingCandidates];
    this.pendingCandidates = [];
    for (const cand of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('Flushing queued candidate error:', err);
      }
    }
  }

  private setupControlChannel(channel: RTCDataChannel): void {
    channel.onmessage = async (event) => {
      if (typeof event.data !== 'string') return;
      const parsed = TransferControlMessageSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;

      const msg = parsed.data;
      switch (msg.type) {
        case 'file:offer': {
          const hasStreamingSupport = 'showSaveFilePicker' in window;
          if (!hasStreamingSupport && msg.size > MOBILE_FALLBACK_MAX_BYTES) {
            this.sendControl({
              type: 'file:reject',
              transferId: msg.transferId,
              reason: 'Ukuran berkas melebihi batas memori aman browser perangkat ini (200 MB).',
            });
            return;
          }

          const decision = await this.callbacks.onIncomingFileOffer(msg);
          if (!decision.accept) {
            this.sendControl({ type: 'file:reject', transferId: msg.transferId });
            return;
          }

          this.incoming.set(msg.transferId, {
            transferId: msg.transferId,
            name: msg.name,
            size: msg.size,
            mimeType: msg.mimeType,
            receivedBytes: 0,
            expectedChunkIndex: 0,
            hasher: sha256.create(),
            writableStream: decision.writableStream,
            memoryChunks: [],
          });

          this.sendControl({ type: 'file:accept', transferId: msg.transferId });
          break;
        }

        case 'file:accept':
          this.pendingAcceptResolvers.get(msg.transferId)?.(true);
          this.pendingAcceptResolvers.delete(msg.transferId);
          break;

        case 'file:reject':
          this.pendingAcceptResolvers.get(msg.transferId)?.(false);
          this.pendingAcceptResolvers.delete(msg.transferId);
          break;

        case 'file:cancel':
          this.cancelledTransfers.add(msg.transferId);
          await this.abortIncoming(msg.transferId, 'CANCELLED');
          break;

        case 'file:complete':
          await this.finalizeIncomingTransfer(msg.transferId, msg.byteCount, msg.sha256);
          break;

        case 'file:verified':
          this.pendingVerifyResolvers.get(msg.transferId)?.();
          this.pendingVerifyResolvers.delete(msg.transferId);
          break;
      }
    };
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

    channel.onmessage = async (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const frame = decodeChunkFrame(event.data);
      const ctx = this.incoming.get(frame.transferId);
      if (!ctx) return;

      if (frame.chunkIndex !== ctx.expectedChunkIndex) {
        this.sendControl({
          type: 'file:error',
          transferId: ctx.transferId,
          code: 'CHUNK_OUT_OF_ORDER',
        });
        await this.abortIncoming(ctx.transferId, 'FAILED');
        return;
      }

      ctx.expectedChunkIndex += 1;
      ctx.receivedBytes += frame.payload.byteLength;
      ctx.hasher.update(frame.payload);

      if (ctx.writableStream) {
        await ctx.writableStream.write(frame.payload);
      } else {
        ctx.memoryChunks.push(new Uint8Array(frame.payload));
      }

      const { speed, eta } = this.recordThroughput(
        frame.payload.byteLength,
        ctx.size - ctx.receivedBytes
      );

      this.callbacks.onProgress({
        transferId: ctx.transferId,
        fileName: ctx.name,
        totalBytes: ctx.size,
        processedBytes: ctx.receivedBytes,
        percentage: ctx.size > 0 ? Math.min(100, (ctx.receivedBytes / ctx.size) * 100) : 100,
        speedBytesPerSec: speed,
        etaSeconds: eta,
        state: 'RECEIVING',
      });
    };
  }

  async sendFile(file: File, transferId = crypto.randomUUID()): Promise<void> {
    if (!this.controlChannel || !this.dataChannel) {
      throw new Error('DataChannel belum siap.');
    }

    const negotiatedMax = this.pc?.sctp?.maxMessageSize ?? DEFAULT_CHUNK_SIZE;
    const chunkSize = Math.min(DEFAULT_CHUNK_SIZE, Math.max(4096, negotiatedMax - 64));

    const acceptedPromise = new Promise<boolean>((resolve) => {
      this.pendingAcceptResolvers.set(transferId, resolve);
    });

    this.sendControl({
      type: 'file:offer',
      transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      chunkSize,
    });

    const accepted = await acceptedPromise;
    if (!accepted) return;

    const hasher = sha256.create();
    let offset = 0;
    let chunkIndex = 0;

    while (offset < file.size) {
      if (this.cancelledTransfers.has(transferId)) {
        throw new Error('Transfer dibatalkan.');
      }

      if (this.dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
        await new Promise<void>((resolve) => {
          const onLow = () => {
            this.dataChannel?.removeEventListener('bufferedamountlow', onLow);
            resolve();
          };
          this.dataChannel?.addEventListener('bufferedamountlow', onLow);
        });
      }

      const slice = file.slice(offset, offset + chunkSize);
      const chunkBytes = new Uint8Array(await slice.arrayBuffer());
      hasher.update(chunkBytes);

      const frame = encodeChunkFrame(transferId, chunkIndex, chunkBytes);
      this.dataChannel.send(frame);

      offset += chunkBytes.byteLength;
      chunkIndex += 1;

      const { speed, eta } = this.recordThroughput(
        chunkBytes.byteLength,
        file.size - offset
      );

      this.callbacks.onProgress({
        transferId,
        fileName: file.name,
        totalBytes: file.size,
        processedBytes: offset,
        percentage: file.size > 0 ? (offset / file.size) * 100 : 100,
        speedBytesPerSec: speed,
        etaSeconds: eta,
        state: 'SENDING',
      });
    }

    const digestHex = bytesToHex(hasher.digest());
    const verifiedPromise = new Promise<void>((resolve) => {
      this.pendingVerifyResolvers.set(transferId, resolve);
    });

    this.sendControl({
      type: 'file:complete',
      transferId,
      byteCount: file.size,
      sha256: digestHex,
    });

    await verifiedPromise;

    this.callbacks.onProgress({
      transferId,
      fileName: file.name,
      totalBytes: file.size,
      processedBytes: file.size,
      percentage: 100,
      speedBytesPerSec: 0,
      etaSeconds: 0,
      state: 'COMPLETED',
      sha256: digestHex,
    });
  }

  private async finalizeIncomingTransfer(
    transferId: string,
    expectedBytes: number,
    expectedSha256: string
  ): Promise<void> {
    const ctx = this.incoming.get(transferId);
    if (!ctx) return;

    const computedSha256 = bytesToHex(ctx.hasher.digest());
    if (
      ctx.receivedBytes !== expectedBytes ||
      computedSha256.toLowerCase() !== expectedSha256.toLowerCase()
    ) {
      this.sendControl({
        type: 'file:error',
        transferId,
        code: 'HASH_MISMATCH',
      });
      await this.abortIncoming(transferId, 'FAILED');
      return;
    }

    if (ctx.writableStream) {
      await ctx.writableStream.close();
    } else {
      const blob = new Blob(ctx.memoryChunks as unknown as BlobPart[], { type: ctx.mimeType });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = ctx.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      ctx.memoryChunks = [];
    }

    this.incoming.delete(transferId);
    this.sendControl({
      type: 'file:verified',
      transferId,
      receivedBytes: ctx.receivedBytes,
    });

    this.callbacks.onProgress({
      transferId,
      fileName: ctx.name,
      totalBytes: ctx.size,
      processedBytes: ctx.receivedBytes,
      percentage: 100,
      speedBytesPerSec: 0,
      etaSeconds: 0,
      state: 'COMPLETED',
      sha256: computedSha256,
    });
  }

  private async abortIncoming(transferId: string, reasonState: 'CANCELLED' | 'FAILED'): Promise<void> {
    const ctx = this.incoming.get(transferId);
    if (!ctx) return;
    if (ctx.writableStream) {
      await ctx.writableStream.abort().catch(() => undefined);
    }
    ctx.memoryChunks = [];
    this.incoming.delete(transferId);

    this.callbacks.onProgress({
      transferId,
      fileName: ctx.name,
      totalBytes: ctx.size,
      processedBytes: ctx.receivedBytes,
      percentage: 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
      state: reasonState,
    });
  }

  private sendControl(msg: TransferControlMessage): void {
    if (this.controlChannel?.readyState === 'open') {
      this.controlChannel.send(JSON.stringify(msg));
    }
  }

  private recordThroughput(bytesAdded: number, remainingBytes: number) {
    const now = performance.now();
    this.speedSamples.push({ timestamp: now, bytes: bytesAdded });
    const windowStart = now - 5000;
    this.speedSamples = this.speedSamples.filter((s) => s.timestamp >= windowStart);

    const totalWindowBytes = this.speedSamples.reduce((acc, s) => acc + s.bytes, 0);
    const elapsedSec = Math.max(0.5, (now - (this.speedSamples[0]?.timestamp ?? now)) / 1000);
    const speed = Math.round(totalWindowBytes / elapsedSec);
    const eta = speed > 0 && this.speedSamples.length >= 4 ? Math.ceil(remainingBytes / speed) : null;

    return { speed, eta };
  }

  private async detectCandidateRoute(): Promise<'DIRECT' | 'RELAY' | 'UNKNOWN'> {
    if (!this.pc) return 'UNKNOWN';
    const stats = await this.pc.getStats();
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') {
          return 'RELAY';
        }
        return 'DIRECT';
      }
    }
    return 'UNKNOWN';
  }

  close(): void {
    try {
      this.controlChannel?.close();
      this.dataChannel?.close();
      this.pc?.close();
    } catch {}
    this.controlChannel = null;
    this.dataChannel = null;
    this.pc = null;
    this.incoming.clear();
    this.pendingAcceptResolvers.clear();
    this.pendingVerifyResolvers.clear();
    this.pendingCandidates = [];
  }
}

