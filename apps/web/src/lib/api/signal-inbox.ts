import type { SignalMessage } from '@nexashare/shared';

// Poll retained signals and acknowledge by ID: concurrent REST requests can
// reach Redis in a different order from their server timestamps.
export class SignalInbox {
  private handled = new Set<string>();

  async consume(signals: SignalMessage[], handle: (signal: SignalMessage) => Promise<void | boolean>): Promise<void> {
    for (const signal of signals) {
      if (this.handled.has(signal.id)) continue;
      if (await handle(signal) !== false) this.handled.add(signal.id);
    }
  }

  clear(): void {
    this.handled.clear();
  }
}
