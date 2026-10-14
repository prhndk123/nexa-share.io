import crypto from 'node:crypto';
import type { IStateStore } from '../store/state-store';
import { env } from '../../config/env';

export interface EphemeralSession {
  sessionId: string;
  roomId: string | null;
  role: 'HOST' | 'GUEST' | 'NONE';
  canSignal: boolean;
  createdAt: string;
}

export class SessionService {
  constructor(private readonly store: IStateStore) {}

  private hashToken(rawToken: string): string {
    return crypto
      .createHmac('sha256', env.SESSION_SIGNING_SECRET)
      .update(rawToken)
      .digest('hex');
  }

  async createSession(): Promise<{ token: string; session: EphemeralSession }> {
    const rawRandom = crypto.randomBytes(32).toString('base64url');
    const sessionId = crypto.randomUUID();
    const token = `${sessionId}.${rawRandom}`;
    const tokenHash = this.hashToken(token);

    const session: EphemeralSession = {
      sessionId,
      roomId: null,
      role: 'NONE',
      canSignal: false,
      createdAt: new Date().toISOString(),
    };

    await this.store.set(
      `session:${tokenHash}`,
      JSON.stringify(session),
      env.ROOM_CONNECTED_TTL_SECONDS
    );
    await this.store.set(
      `session:id:${sessionId}`,
      tokenHash,
      env.ROOM_CONNECTED_TTL_SECONDS
    );

    return { token, session };
  }

  async verifyToken(token: string | undefined): Promise<EphemeralSession | null> {
    if (!token) return null;
    const tokenHash = this.hashToken(token);
    const raw = await this.store.get(`session:${tokenHash}`);
    if (!raw) return null;
    return JSON.parse(raw) as EphemeralSession;
  }

  async updateSessionById(
    sessionId: string,
    patch: Partial<EphemeralSession>,
    ttlSeconds = env.ROOM_CONNECTED_TTL_SECONDS
  ): Promise<void> {
    const tokenHash = await this.store.get(`session:id:${sessionId}`);
    if (!tokenHash) return;
    const raw = await this.store.get(`session:${tokenHash}`);
    if (!raw) return;

    const updated: EphemeralSession = { ...JSON.parse(raw), ...patch };
    await this.store.set(
      `session:${tokenHash}`,
      JSON.stringify(updated),
      ttlSeconds
    );
  }
}

