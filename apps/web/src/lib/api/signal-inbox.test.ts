import { describe, expect, it, vi } from 'vitest';
import type { SignalMessage } from '@nexashare/shared';
import { SignalInbox } from './signal-inbox';

const signal = (id: string, timestamp: number, type: SignalMessage['type'] = 'webrtc:ice-candidate'): SignalMessage => ({
  id, timestamp, type, roomId: 'room', senderRole: 'HOST', recipientRole: 'GUEST', payload: {},
});

describe('REST signaling inbox', () => {
  it('receives delayed and equal-timestamp messages without replaying processed signals', async () => {
    const inbox = new SignalInbox();
    const handle = vi.fn(async (_message: SignalMessage) => {});
    const candidate = signal('candidate', 200);
    const offer = signal('offer', 100, 'webrtc:offer');
    const secondCandidate = signal('candidate-2', 200);
    await inbox.consume([candidate], handle);
    await inbox.consume([candidate, offer, secondCandidate], handle);
    await inbox.consume([candidate, offer, secondCandidate], handle);
    expect(handle.mock.calls.map(([message]) => message.id)).toEqual(['candidate', 'offer', 'candidate-2']);
  });

  it('defers an offer received before approval until the transfer engine is ready', async () => {
    const inbox = new SignalInbox();
    let ready = false;
    const applied: string[] = [];
    const handle = async (message: SignalMessage) => {
      if (message.type === 'join:approved') ready = true;
      if (!ready) return false;
      applied.push(message.id);
    };
    const messages = [signal('offer', 100, 'webrtc:offer'), signal('approved', 90, 'join:approved')];
    await inbox.consume(messages, handle);
    expect(applied).toEqual(['approved']);
    await inbox.consume(messages, handle);
    expect(applied).toEqual(['approved', 'offer']);
  });

  it('retries a handler that failed instead of acknowledging the lost message', async () => {
    const inbox = new SignalInbox();
    const message = signal('offer', 100, 'webrtc:offer');
    await expect(inbox.consume([message], async () => { throw new Error('Temporary failure'); })).rejects.toThrow();
    const handle = vi.fn(async () => {});
    await inbox.consume([message], handle);
    await inbox.consume([message], handle);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
