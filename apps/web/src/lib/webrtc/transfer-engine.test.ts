import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexaShareTransferEngine } from './transfer-engine';
import { encodeChunkFrame } from '@nexashare/shared';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

class FakeChannel {
  readyState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void | Promise<void>) | null = null;
  bufferedAmount = 0;
  send = vi.fn((_data: string | ArrayBuffer) => {});
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor(readonly label: string) {}
  open() { this.readyState = 'open'; this.onopen?.(); }
  close() { this.readyState = 'closed'; }
}

class FakePeer {
  static instances: FakePeer[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channels: FakeChannel[] = [];
  onicecandidate: ((event: { candidate: { toJSON: () => RTCIceCandidateInit } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  constructor(private config: RTCConfiguration = {}) { FakePeer.instances.push(this); }
  getConfiguration = vi.fn(() => this.config);
  setConfiguration = vi.fn((config: RTCConfiguration) => { this.config = config; });
  createDataChannel(label: string) { const channel = new FakeChannel(label); this.channels.push(channel); return channel; }
  createOffer = vi.fn(async (_options?: RTCOfferOptions) => ({ type: 'offer', sdp: 'test-offer-sdp' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'test-answer-sdp' }));
  setLocalDescription = vi.fn(async () => {
    // Simulate candidates becoming available while the SDP POST is in flight.
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local-candidate', sdpMid: '0' }) } });
  });
  setRemoteDescription = vi.fn(async (sdp: RTCSessionDescriptionInit) => { this.remoteDescription = sdp; });
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  getStats = vi.fn(async () => new Map());
  close() { this.connectionState = 'closed'; }
}

function callbacks() {
  return {
    onSignalOffer: vi.fn(async (_sdp: RTCSessionDescriptionInit) => {}),
    onSignalAnswer: vi.fn(async (_sdp: RTCSessionDescriptionInit) => {}),
    onSignalIceCandidate: vi.fn(async (_candidate: RTCIceCandidateInit | null) => {}),
    onSignalingError: vi.fn(),
    onConnectionStateChange: vi.fn(),
    onIncomingFileOffer: vi.fn(async () => ({ accept: false })),
    onProgress: vi.fn(),
  };
}

beforeEach(() => {
  FakePeer.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('RTCSessionDescription', class { constructor(sdp: RTCSessionDescriptionInit) { Object.assign(this, sdp); } });
  vi.stubGlobal('RTCIceCandidate', class { constructor(candidate: RTCIceCandidateInit) { Object.assign(this, candidate); } });
  vi.stubGlobal('window', {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('WebRTC signaling and channel readiness', () => {
  it('waits for the offer POST before sending local ICE candidates', async () => {
    const cb = callbacks();
    let resolveOffer!: () => void;
    cb.onSignalOffer.mockImplementation(() => new Promise<void>((resolve) => { resolveOffer = resolve; }));
    const engine = new NexaShareTransferEngine(cb);
    const initializing = engine.initialize([], true);
    await vi.waitFor(() => expect(cb.onSignalOffer).toHaveBeenCalledTimes(1));
    expect(cb.onSignalIceCandidate).not.toHaveBeenCalled();
    resolveOffer();
    await initializing;
    expect(cb.onSignalIceCandidate).toHaveBeenCalledTimes(1);
    engine.close();
  });

  it('waits for the answer POST before sending responder ICE candidates', async () => {
    const order: string[] = [];
    const cb = callbacks();
    cb.onSignalAnswer.mockImplementation(async () => { order.push('answer'); });
    cb.onSignalIceCandidate.mockImplementation(async () => { order.push('candidate'); });
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], false);
    await engine.handleRemoteOffer({ type: 'offer', sdp: 'remote-offer' });
    expect(order).toEqual(['answer', 'candidate']);
    engine.close();
  });

  it('retains remote ICE candidates that arrive before the remote description', async () => {
    const engine = new NexaShareTransferEngine(callbacks());
    await engine.initialize([], false);
    const peer = FakePeer.instances[0];
    await engine.handleRemoteIceCandidate({ candidate: 'remote-candidate', sdpMid: '0' });
    expect(peer.addIceCandidate).not.toHaveBeenCalled();
    await engine.handleRemoteOffer({ type: 'offer', sdp: 'remote-offer' });
    expect(peer.addIceCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidate: 'remote-candidate' }));
    engine.close();
  });

  it('reports ready only after both control and file channels open', async () => {
    const cb = callbacks();
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], true);
    const peer = FakePeer.instances[0];
    peer.connectionState = 'connected';
    peer.onconnectionstatechange?.();
    peer.channels[0].open();
    expect(cb.onConnectionStateChange).not.toHaveBeenCalled();
    peer.channels[1].open();
    await vi.waitFor(() => expect(cb.onConnectionStateChange).toHaveBeenCalledWith('connected', 'UNKNOWN'));
    peer.onconnectionstatechange?.();
    expect(cb.onConnectionStateChange).toHaveBeenCalledTimes(1);
    engine.close();
  });

  it('reports a failed SDP POST without sending candidates for the missing description', async () => {
    const cb = callbacks();
    const failure = new Error('Signaling unavailable');
    cb.onSignalOffer.mockRejectedValue(failure);
    const engine = new NexaShareTransferEngine(cb);
    await expect(engine.initialize([], true)).rejects.toThrow('Signaling unavailable');
    expect(cb.onSignalingError).toHaveBeenCalledWith(failure);
    expect(cb.onSignalIceCandidate).not.toHaveBeenCalled();
    engine.close();
  });

  it('allows a brief disconnect to recover without replacing channels or restarting ICE', async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], true);
    const peer = FakePeer.instances[0];
    peer.channels.forEach((channel) => channel.open());
    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2000);
    peer.connectionState = 'connected';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(peer.createOffer).toHaveBeenCalledTimes(1);
    expect(engine.isReady).toBe(true);
    expect(cb.onConnectionStateChange).not.toHaveBeenCalledWith('failed', expect.anything());
    engine.close();
  });

  it('restarts failed ICE with fresh TURN credentials and keeps existing data channels', async () => {
    vi.useFakeTimers();
    const cb = { ...callbacks(), onRefreshIceServers: vi.fn(async () => [{ urls: 'turns:relay.example.com:443', username: 'test', credential: 'test' }]) };
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], true);
    const peer = FakePeer.instances[0];
    peer.channels.forEach((channel) => channel.open());
    peer.connectionState = 'failed';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
    expect(peer.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceTransportPolicy: 'all', iceServers: [{ urls: 'turns:relay.example.com:443', username: 'test', credential: 'test' }] }));
    expect(cb.onRefreshIceServers).toHaveBeenCalledTimes(1);
    expect(peer.channels.every((channel) => channel.readyState === 'open')).toBe(true);
    peer.connectionState = 'connected';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(peer.createOffer).toHaveBeenCalledTimes(2);
    expect(engine.isReady).toBe(true);
    engine.close();
  });

  it('limits automatic restart attempts so permanent failures do not retry forever', async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], true);
    const peer = FakePeer.instances[0];
    peer.connectionState = 'failed';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(peer.createOffer).toHaveBeenCalledTimes(3); // initial offer plus two restarts
    expect(cb.onConnectionStateChange).toHaveBeenLastCalledWith('failed', 'UNKNOWN');
    engine.close();
  });

  it('does not reset browser configuration when TURN credentials are unchanged', async () => {
    const servers = [{ urls: ['turns:relay.example.com:443'], username: 'test', credential: 'test' }];
    const cb = { ...callbacks(), onRefreshIceServers: vi.fn(async () => servers) };
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize(servers, true, 'relay');
    const peer = FakePeer.instances[0];
    await engine.restartConnection();
    expect(peer.setConfiguration).not.toHaveBeenCalled();
    expect(peer.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
    engine.close();
  });

  it('lets only the host create restart offers when the guest loses connectivity', async () => {
    vi.useFakeTimers();
    const cb = { ...callbacks(), onSignalRestart: vi.fn(async () => {}) };
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], false);
    const peer = FakePeer.instances[0];
    peer.connectionState = 'failed';
    engine.resumeConnection();
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.onSignalRestart).toHaveBeenCalledTimes(1);
    expect(peer.createOffer).not.toHaveBeenCalled();
    engine.close();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(cb.onSignalRestart).toHaveBeenCalledTimes(1);
  });

  it('rejects sending on unavailable channels instead of silently waiting for file acceptance', async () => {
    const engine = new NexaShareTransferEngine(callbacks());
    await engine.initialize([], true);
    await expect(engine.sendFile({ name: 'test.txt', size: 0, type: 'text/plain' } as File, '6f6af0c4-41d0-4e83-9714-ce565322ab62')).rejects.toThrow('Koneksi sedang tidak siap');
    engine.close();
  });

  it('waits for data frames and sequential stream writes when completion arrives first', async () => {
    let finishFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { finishFirstWrite = resolve; });
    const stream = { write: vi.fn(async () => { await firstWrite; }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const cb = { ...callbacks(), onIncomingFileOffer: vi.fn(async () => ({ accept: true, writableStream: stream })) };
    const engine = new NexaShareTransferEngine(cb);
    await engine.initialize([], false);
    const peer = FakePeer.instances[0];
    const control = new FakeChannel('nexashare-control');
    const data = new FakeChannel('nexashare-data');
    peer.ondatachannel?.({ channel: control }); peer.ondatachannel?.({ channel: data });
    control.open(); data.open();
    const id = '6f6af0c4-41d0-4e83-9714-ce565322ab62';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await control.onmessage?.({ data: JSON.stringify({ type: 'file:offer', transferId: id, name: 'test.bin', size: 4, mimeType: 'application/octet-stream', chunkSize: 1024 }) });
    await control.onmessage?.({ data: JSON.stringify({ type: 'file:complete', transferId: id, byteCount: 4, sha256: bytesToHex(sha256(bytes)) }) });
    expect(stream.abort).not.toHaveBeenCalled();
    expect(stream.close).not.toHaveBeenCalled();
    data.onmessage?.({ data: encodeChunkFrame(id, 0, bytes.slice(0, 2)) });
    data.onmessage?.({ data: encodeChunkFrame(id, 1, bytes.slice(2)) });
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(1));
    finishFirstWrite();
    await vi.waitFor(() => expect(stream.close).toHaveBeenCalledTimes(1));
    expect(stream.write).toHaveBeenCalledTimes(2);
    expect(stream.abort).not.toHaveBeenCalled();
    expect(control.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'file:verified', transferId: id, receivedBytes: 4 }));
    engine.close();
  });

  it('rejects a pending file offer when the session closes', async () => {
    const engine = new NexaShareTransferEngine(callbacks());
    await engine.initialize([], true);
    const peer = FakePeer.instances[0];
    peer.connectionState = 'connected'; peer.channels.forEach((channel) => channel.open());
    const sending = expect(engine.sendFile({ name: 'test.txt', size: 0, type: 'text/plain' } as File, '6f6af0c4-41d0-4e83-9714-ce565322ab62')).rejects.toThrow('Sesi transfer ditutup');
    engine.close();
    await sending;
  });

  it('reports receiver verification errors instead of leaving the sender waiting forever', async () => {
    const engine = new NexaShareTransferEngine(callbacks());
    await engine.initialize([], true);
    const peer = FakePeer.instances[0];
    peer.connectionState = 'connected'; peer.channels.forEach((channel) => channel.open());
    const control = peer.channels[0];
    control.send.mockImplementation((raw) => {
      const message = JSON.parse(raw as string);
      if (message.type === 'file:offer') void control.onmessage?.({ data: JSON.stringify({ type: 'file:accept', transferId: message.transferId }) });
      if (message.type === 'file:complete') void control.onmessage?.({ data: JSON.stringify({ type: 'file:error', transferId: message.transferId, code: 'HASH_MISMATCH' }) });
    });
    await expect(engine.sendFile({ name: 'test.txt', size: 0, type: 'text/plain' } as File, '6f6af0c4-41d0-4e83-9714-ce565322ab62')).rejects.toThrow('HASH_MISMATCH');
    engine.close();
  });
});
