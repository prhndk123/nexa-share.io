import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexaShareTransferEngine } from './transfer-engine';

class FakeChannel {
  readyState = 'connecting';
  onopen: (() => void) | null = null;
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
  ondatachannel: unknown;
  constructor() { FakePeer.instances.push(this); }
  createDataChannel(label: string) { const channel = new FakeChannel(label); this.channels.push(channel); return channel; }
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'test-offer-sdp' }));
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
});
afterEach(() => vi.unstubAllGlobals());

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
});
