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
  completion?: { byteCount: number; sha256: string };
}

export class NexaShareTransferEngine {
  private pc: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannel: RTCDataChannel | null = null;

  private incoming = new Map<string, IncomingTransferContext>();
  private pendingAcceptResolvers = new Map<string, { resolve: (accepted: boolean) => void; reject: (error: Error) => void }>();
  private pendingVerifyResolvers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private incomingDataQueue: Promise<void> = Promise.resolve();
  private bufferWaitRejectors = new Set<(error: Error) => void>();
  private cancelledTransfers = new Set<string>();
  private speedSamples: Array<{ timestamp: number; bytes: number }> = [];

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private pendingLocalCandidates: Array<RTCIceCandidateInit | null> = [];
  private localDescriptionSignaled = false;
  private outgoingSignals: Promise<void> = Promise.resolve();
  private readyReported = false;
  private isInitiator = false;
  private restartAttempts = 0;
  private recovering = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private configuration: RTCConfiguration = {};

  constructor(
    private readonly callbacks: {
      onSignalOffer: (sdp: RTCSessionDescriptionInit) => void | Promise<void>;
      onSignalAnswer: (sdp: RTCSessionDescriptionInit) => void | Promise<void>;
      onSignalIceCandidate: (candidate: RTCIceCandidateInit | null) => void | Promise<void>;
      onSignalingError?: (error: Error) => void;
      onSignalRestart?: () => void | Promise<void>;
      onRefreshIceServers?: () => Promise<RTCIceServer[]>;
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

  async initialize(iceServers: RTCIceServer[], isInitiator: boolean, iceTransportPolicy: RTCIceTransportPolicy = 'all'): Promise<void> {
    this.isInitiator = isInitiator;
    this.configuration = { iceServers: structuredClone(iceServers), iceTransportPolicy };
    this.pc = new RTCPeerConnection(structuredClone(this.configuration));

    this.pc.onicecandidate = (event) => {
      const candidate = event.candidate ? event.candidate.toJSON() : null;
      if (!this.localDescriptionSignaled) {
        this.pendingLocalCandidates.push(candidate);
      } else {
        void this.queueSignal(() => this.callbacks.onSignalIceCandidate(candidate)).catch(() => undefined);
      }
    };

    this.pc.onconnectionstatechange = () => {
      void this.reportConnectionState();
    };

    if (isInitiator) {
      this.controlChannel = this.pc.createDataChannel('nexashare-control', { ordered: true });
      this.dataChannel = this.pc.createDataChannel('nexashare-data', { ordered: true });
      this.setupControlChannel(this.controlChannel);
      this.setupDataChannel(this.dataChannel);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.sendDescription(() => this.callbacks.onSignalOffer(offer));
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
      this.localDescriptionSignaled = false;
      await this.pc.setLocalDescription(answer);
      await this.sendDescription(() => this.callbacks.onSignalAnswer(answer));
    } catch (err) {
      console.error('handleRemoteOffer error:', err);
      throw err;
    }
  }

  async handleRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.flushPendingCandidates();
    } catch (err) {
      console.error('handleRemoteAnswer error:', err);
      throw err;
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

  private queueSignal(send: () => void | Promise<void>): Promise<void> {
    const pc = this.pc;
    const pending = this.outgoingSignals.then(() => {
      if (pc && pc === this.pc) return send();
    });
    this.outgoingSignals = pending.catch((error) => {
      if (pc === this.pc) this.callbacks.onSignalingError?.(error instanceof Error ? error : new Error(String(error)));
    });
    return pending;
  }

  private async sendDescription(send: () => void | Promise<void>): Promise<void> {
    await this.queueSignal(send);
    this.localDescriptionSignaled = true;
    const candidates = this.pendingLocalCandidates.splice(0);
    for (const candidate of candidates) {
      await this.queueSignal(() => this.callbacks.onSignalIceCandidate(candidate));
    }
  }

  private async reportConnectionState(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const state = pc.connectionState;
    if (state === 'failed' || state === 'disconnected') {
      this.readyReported = false;
      if (this.recovering || this.recoveryTimer) return;
      if (this.restartAttempts < 2 && (this.isInitiator || this.callbacks.onSignalRestart)) {
        this.callbacks.onConnectionStateChange('connecting', 'UNKNOWN');
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (pc === this.pc && pc.connectionState !== 'connected') {
            void this.restartConnection().catch(() => undefined);
          }
        }, state === 'disconnected' ? 3000 : 0);
        return;
      }
    }
    if (state === 'connected') {
      if (this.readyReported || this.controlChannel?.readyState !== 'open' || this.dataChannel?.readyState !== 'open') return;
      this.clearRecoveryTimer();
      this.recovering = false;
      this.restartAttempts = 0;
    }
    const route = await this.detectCandidateRoute().catch(() => 'UNKNOWN' as const);
    if (pc !== this.pc) return;
    if (pc.connectionState !== state) return this.reportConnectionState();
    if (state === 'connected') {
      if (this.readyReported) return;
      this.readyReported = true;
    }
    this.callbacks.onConnectionStateChange(state, route);
    if (state === 'failed' || state === 'closed') this.failPendingTransfers(new Error('Koneksi transfer terputus. Silakan coba lagi.'));
  }

  get isReady(): boolean {
    return this.pc?.connectionState === 'connected' && this.controlChannel?.readyState === 'open' && this.dataChannel?.readyState === 'open';
  }

  // Keep the existing channels. Only the host creates restart offers, so both
  // peers noticing a network change cannot produce colliding offers.
  async restartConnection(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.recovering) return;
    this.clearRecoveryTimer();
    if (this.restartAttempts >= 2) {
      this.callbacks.onConnectionStateChange('failed', 'UNKNOWN');
      this.failPendingTransfers(new Error('Koneksi transfer tidak berhasil dipulihkan.'));
      return;
    }
    this.restartAttempts += 1;
    this.recovering = true;
    this.readyReported = false;
    this.callbacks.onConnectionStateChange('connecting', 'UNKNOWN');
    try {
      if (this.isInitiator) {
        const iceServers = this.callbacks.onRefreshIceServers
          ? await this.callbacks.onRefreshIceServers() : this.configuration.iceServers ?? [];
        if (pc !== this.pc) return;
        const current = this.configuration;
        const serverIdentity = (servers: RTCIceServer[]) => JSON.stringify(servers.map((server) => ({
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
          username: server.username ?? null, credential: server.credential ?? null,
        })));
        // Avoid resetting a working transport when managed credentials have
        // not changed. Preserve pool/bundle policy when refreshing credentials;
        // certificates cannot be reapplied after the first local description.
        if (serverIdentity(current.iceServers ?? []) !== serverIdentity(iceServers)) {
          const updated = { ...current, iceServers: structuredClone(iceServers) };
          pc.setConfiguration(structuredClone(updated));
          this.configuration = updated;
        }
        this.localDescriptionSignaled = false;
        const offer = await pc.createOffer({ iceRestart: true });
        if (pc !== this.pc) return;
        await pc.setLocalDescription(offer);
        await this.sendDescription(() => this.callbacks.onSignalOffer(offer));
        // Some browsers keep the old working transport during an ICE restart
        // and do not emit a fresh connected event after negotiation completes.
        if (this.isReady) await this.reportConnectionState();
      } else {
        await this.queueSignal(() => this.callbacks.onSignalRestart?.());
      }
    } catch (error) {
      if (pc !== this.pc) return;
      this.recovering = false;
      this.callbacks.onSignalingError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (pc !== this.pc || !this.recovering) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (pc !== this.pc) return;
      this.recovering = false;
      void this.restartConnection().catch(() => undefined);
    }, 20_000);
  }

  resumeConnection(): void {
    if (this.pc && ['failed', 'disconnected'].includes(this.pc.connectionState)) {
      void this.reportConnectionState();
    }
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private setupControlChannel(channel: RTCDataChannel): void {
    channel.onopen = () => { void this.reportConnectionState(); };
    channel.onclose = () => this.failPendingTransfers(new Error('Kanal transfer sudah ditutup.'));
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
          this.pendingAcceptResolvers.get(msg.transferId)?.resolve(true);
          this.pendingAcceptResolvers.delete(msg.transferId);
          break;

        case 'file:reject':
          this.pendingAcceptResolvers.get(msg.transferId)?.resolve(false);
          this.pendingAcceptResolvers.delete(msg.transferId);
          break;

        case 'file:cancel':
          this.cancelledTransfers.add(msg.transferId);
          await this.abortIncoming(msg.transferId, 'CANCELLED');
          break;

        case 'file:complete': {
          const ctx = this.incoming.get(msg.transferId);
          if (!ctx) break;
          ctx.completion = { byteCount: msg.byteCount, sha256: msg.sha256 };
          // Control and data channels have independent ordering. Completion
          // may arrive first; finish only after every data frame/write lands.
          if (msg.byteCount !== ctx.size) {
            this.sendControl({ type: 'file:error', transferId: msg.transferId, code: 'SIZE_MISMATCH' });
            await this.abortIncoming(msg.transferId, 'FAILED');
          } else if (ctx.receivedBytes === msg.byteCount) {
            await this.incomingDataQueue;
            await this.finalizeIncomingTransfer(msg.transferId, msg.byteCount, msg.sha256);
          }
          break;
        }

        case 'file:verified':
          this.pendingVerifyResolvers.get(msg.transferId)?.resolve();
          this.pendingVerifyResolvers.delete(msg.transferId);
          break;

        case 'file:error': {
          const error = new Error(`Penerima gagal memverifikasi berkas (${msg.code}).`);
          this.pendingAcceptResolvers.get(msg.transferId)?.reject(error);
          this.pendingAcceptResolvers.delete(msg.transferId);
          this.pendingVerifyResolvers.get(msg.transferId)?.reject(error);
          this.pendingVerifyResolvers.delete(msg.transferId);
          break;
        }
      }
    };
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    channel.onopen = () => { void this.reportConnectionState(); };
    channel.onclose = () => this.failPendingTransfers(new Error('Kanal data sudah ditutup.'));
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

    channel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      this.incomingDataQueue = this.incomingDataQueue.then(() => this.receiveDataFrame(event.data)).catch((error) => {
        this.failPendingTransfers(error instanceof Error ? error : new Error(String(error)));
      });
    };
  }

  private async receiveDataFrame(data: ArrayBuffer): Promise<void> {
    const frame = decodeChunkFrame(data);
    const ctx = this.incoming.get(frame.transferId);
    if (!ctx) return;

    if (frame.chunkIndex !== ctx.expectedChunkIndex || ctx.receivedBytes + frame.payload.byteLength > ctx.size) {
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

    if (ctx.completion && ctx.receivedBytes === ctx.completion.byteCount) {
      await this.finalizeIncomingTransfer(ctx.transferId, ctx.completion.byteCount, ctx.completion.sha256);
    }
  }

  async sendFile(file: File, transferId = crypto.randomUUID()): Promise<void> {
    if (!this.controlChannel || !this.dataChannel || !this.isReady) {
      throw new Error('Koneksi sedang tidak siap. Tunggu sampai tersambung lalu pilih berkas lagi.');
    }

    const negotiatedMax = this.pc?.sctp?.maxMessageSize ?? DEFAULT_CHUNK_SIZE;
    const chunkSize = Math.min(DEFAULT_CHUNK_SIZE, Math.max(4096, negotiatedMax - 64));

    const acceptedPromise = new Promise<boolean>((resolve, reject) => {
      this.pendingAcceptResolvers.set(transferId, { resolve, reject });
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
        const channel = this.dataChannel;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            this.bufferWaitRejectors.delete(onFailure);
          };
          const onLow = () => {
            cleanup();
            resolve();
          };
          const onFailure = (error: Error) => { cleanup(); reject(error); };
          this.bufferWaitRejectors.add(onFailure);
          channel.addEventListener('bufferedamountlow', onLow);
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
    const verifiedPromise = new Promise<void>((resolve, reject) => {
      this.pendingVerifyResolvers.set(transferId, { resolve, reject });
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

  private failPendingTransfers(error: Error): void {
    for (const pending of this.pendingAcceptResolvers.values()) pending.reject(error);
    for (const pending of this.pendingVerifyResolvers.values()) pending.reject(error);
    for (const reject of [...this.bufferWaitRejectors]) reject(error);
    this.pendingAcceptResolvers.clear();
    this.pendingVerifyResolvers.clear();
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
    this.clearRecoveryTimer();
    this.recovering = false;
    this.restartAttempts = 0;
    this.failPendingTransfers(new Error('Sesi transfer ditutup.'));
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
    this.pendingLocalCandidates = [];
    this.localDescriptionSignaled = false;
    this.readyReported = false;
  }
}
