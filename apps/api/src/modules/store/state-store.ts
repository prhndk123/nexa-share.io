import { env } from '../../config/env';
import type { SignalMessage } from '@nexashare/shared';

export interface IStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  exists(key: string): Promise<boolean>;
  pushSignal(roomId: string, recipientRole: string, signal: SignalMessage): Promise<void>;
  pollSignals(roomId: string, recipientRole: string, afterTimestamp: number): Promise<SignalMessage[]>;
}

// 1. In-Memory Store with TTL (Zero-dependency fallback)
interface MemoryEntry {
  value: string;
  expiresAt: number;
}

class MemoryStateStore implements IStateStore {
  private store = new Map<string, MemoryEntry>();
  private signals = new Map<string, SignalMessage[]>();

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt <= now) {
        this.store.delete(k);
      }
    }
    for (const [k, list] of this.signals.entries()) {
      const filtered = list.filter((s) => now - (s.timestamp || now) < 60_000);
      if (filtered.length === 0) {
        this.signals.delete(k);
      } else {
        this.signals.set(k, filtered);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    this.cleanup();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds = 300): Promise<void> {
    this.cleanup();
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string): Promise<number> {
    this.cleanup();
    const current = await this.get(key);
    const nextVal = (current ? parseInt(current, 10) : 0) + 1;
    await this.set(key, nextVal.toString(), 300);
    return nextVal;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
  }

  async exists(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  async pushSignal(roomId: string, recipientRole: string, signal: SignalMessage): Promise<void> {
    const key = `signals:${roomId}:${recipientRole}`;
    const list = this.signals.get(key) || [];
    list.push(signal);
    this.signals.set(key, list);
  }

  async pollSignals(roomId: string, recipientRole: string, afterTimestamp: number): Promise<SignalMessage[]> {
    const key = `signals:${roomId}:${recipientRole}`;
    const list = this.signals.get(key) || [];
    return list.filter((s) => s.timestamp > afterTimestamp);
  }
}

// 2. Upstash REST API Store (Native for Vercel Serverless)
class UpstashStateStore implements IStateStore {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T = any>(command: string, ...args: (string | number)[]): Promise<T> {
    const res = await fetch(`${this.url}/${command}/${args.map(encodeURIComponent).join('/')}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    const data = await res.json();
    return data.result;
  }

  async get(key: string): Promise<string | null> {
    return this.request('get', key);
  }

  async set(key: string, value: string, ttlSeconds = 300): Promise<void> {
    await this.request('set', key, value, 'ex', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.request('del', key);
  }

  async incr(key: string): Promise<number> {
    return this.request('incr', key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.request('expire', key, seconds);
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.request<number>('exists', key);
    return count > 0;
  }

  async pushSignal(roomId: string, recipientRole: string, signal: SignalMessage): Promise<void> {
    const key = `signals:${roomId}:${recipientRole}`;
    await this.request('rpush', key, JSON.stringify(signal));
    await this.request('expire', key, 60);
  }

  async pollSignals(roomId: string, recipientRole: string, afterTimestamp: number): Promise<SignalMessage[]> {
    const key = `signals:${roomId}:${recipientRole}`;
    const rawList = (await this.request<string[]>('lrange', key, 0, -1)) || [];
    const signals: SignalMessage[] = [];
    for (const item of rawList) {
      try {
        const parsed = typeof item === 'string' ? JSON.parse(item) : item;
        if (parsed.timestamp > afterTimestamp) {
          signals.push(parsed);
        }
      } catch {}
    }
    return signals;
  }
}

// Factory function to return optimal store
export function createStateStore(): IStateStore {
  const upstashUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;

  if (upstashUrl && upstashToken) {
    return new UpstashStateStore(upstashUrl, upstashToken);
  }

  return new MemoryStateStore();
}

export const globalStateStore = createStateStore();
