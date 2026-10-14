import crypto from 'node:crypto';
import type { IStateStore } from '../store/state-store';
import { env } from '../../config/env';
import type { RoomStatus } from '@nexashare/shared';
import { SessionService } from '../auth/session.service';

export interface RoomRecord {
  roomId: string;
  codeHmac: string;
  status: RoomStatus;
  hostSessionId: string;
  hostDeviceLabel: string;
  guestSessionId: string | null;
  guestDeviceLabel: string | null;
  expiresAt: string;
}

export interface PendingJoinRequest {
  requestId: string;
  roomId: string;
  guestSessionId: string;
  deviceLabel: string;
  createdAt: string;
}

export class RoomService {
  constructor(
    private readonly store: IStateStore,
    private readonly sessionService: SessionService
  ) {}

  private hmacCode(formattedCode: string): string {
    return crypto
      .createHmac('sha256', env.ROOM_CODE_HMAC_SECRET)
      .update(formattedCode)
      .digest('hex');
  }

  private hashRateKey(value: string): string {
    return crypto
      .createHmac('sha256', env.ROOM_CODE_HMAC_SECRET)
      .update(value)
      .digest('hex');
  }

  private generateSixDigitCode(): string {
    const n = crypto.randomInt(0, 1_000_000);
    const padded = n.toString().padStart(6, '0');
    return `${padded.slice(0, 3)}-${padded.slice(3, 6)}`;
  }

  async enforceJoinRateLimit(clientIp: string, sessionId: string): Promise<boolean> {
    const ipKey = `rate:join:ip:${this.hashRateKey(clientIp)}`;
    const sessionKey = `rate:join:session:${this.hashRateKey(sessionId)}`;

    const [ipCount, sessionCount] = await Promise.all([
      this.store.incr(ipKey),
      this.store.incr(sessionKey),
    ]);

    if (ipCount === 1) await this.store.expire(ipKey, env.RATE_JOIN_WINDOW_SECONDS);
    if (sessionCount === 1) await this.store.expire(sessionKey, env.RATE_JOIN_WINDOW_SECONDS);

    return ipCount <= env.RATE_JOIN_LIMIT && sessionCount <= env.RATE_JOIN_LIMIT;
  }

  async createRoom(hostSessionId: string, deviceLabel: string) {
    let code = '';
    let codeHmac = '';

    for (let attempt = 0; attempt < 5; attempt++) {
      code = this.generateSixDigitCode();
      codeHmac = this.hmacCode(code);
      const exists = await this.store.exists(`room:code:${codeHmac}`);
      if (!exists) break;
    }

    const roomId = crypto.randomUUID();
    const ttl = env.ROOM_JOIN_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const record: RoomRecord = {
      roomId,
      codeHmac,
      status: 'WAITING',
      hostSessionId,
      hostDeviceLabel: deviceLabel,
      guestSessionId: null,
      guestDeviceLabel: null,
      expiresAt,
    };

    await Promise.all([
      this.store.set(`room:code:${codeHmac}`, roomId, ttl),
      this.store.set(`room:${roomId}`, JSON.stringify(record), ttl),
    ]);

    await this.sessionService.updateSessionById(
      hostSessionId,
      { roomId, role: 'HOST', canSignal: false },
      ttl
    );

    return {
      roomId,
      code,
      expiresAt,
      status: record.status,
      inviteUrl: `${env.APP_ORIGIN}/room/${code}`,
    };
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const raw = await this.store.get(`room:${roomId}`);
    if (!raw) return null;
    return JSON.parse(raw) as RoomRecord;
  }

  async requestJoin(code: string, guestSessionId: string, deviceLabel: string) {
    const codeHmac = this.hmacCode(code);
    const roomId = await this.store.get(`room:code:${codeHmac}`);
    if (!roomId) return null;

    const room = await this.getRoom(roomId);
    if (!room || room.status !== 'WAITING' || room.guestSessionId) {
      return null;
    }

    const existingPending = await this.store.get(`room:${roomId}:pending`);
    if (existingPending) {
      return null;
    }

    const requestId = crypto.randomUUID();
    const pending: PendingJoinRequest = {
      requestId,
      roomId,
      guestSessionId,
      deviceLabel,
      createdAt: new Date().toISOString(),
    };

    await this.store.set(
      `room:${roomId}:pending`,
      JSON.stringify(pending),
      env.ROOM_PENDING_TTL_SECONDS
    );

    await this.sessionService.updateSessionById(
      guestSessionId,
      { roomId, role: 'GUEST', canSignal: false },
      env.ROOM_JOIN_TTL_SECONDS
    );

    return {
      roomId,
      requestId,
      hostSessionId: room.hostSessionId,
      expiresInSeconds: env.ROOM_PENDING_TTL_SECONDS,
    };
  }

  async approveJoin(roomId: string, requestId: string, hostSessionId: string) {
    const room = await this.getRoom(roomId);
    if (!room || room.hostSessionId !== hostSessionId || room.status !== 'WAITING') {
      return null;
    }

    const pendingRaw = await this.store.get(`room:${roomId}:pending`);
    if (!pendingRaw) return null;

    const pending = JSON.parse(pendingRaw) as PendingJoinRequest;
    if (pending.requestId !== requestId) return null;

    const connectedTtl = env.ROOM_CONNECTED_TTL_SECONDS;
    room.status = 'PAIRED';
    room.guestSessionId = pending.guestSessionId;
    room.guestDeviceLabel = pending.deviceLabel;
    room.expiresAt = new Date(Date.now() + connectedTtl * 1000).toISOString();

    await Promise.all([
      this.store.del(`room:${roomId}:pending`),
      this.store.del(`room:code:${room.codeHmac}`),
      this.store.set(`room:${roomId}`, JSON.stringify(room), connectedTtl),
    ]);

    await Promise.all([
      this.sessionService.updateSessionById(
        room.hostSessionId,
        { roomId, role: 'HOST', canSignal: true },
        connectedTtl
      ),
      this.sessionService.updateSessionById(
        pending.guestSessionId,
        { roomId, role: 'GUEST', canSignal: true },
        connectedTtl
      ),
    ]);

    return { room, guestSessionId: pending.guestSessionId };
  }

  async rejectJoin(roomId: string, requestId: string, hostSessionId: string) {
    const room = await this.getRoom(roomId);
    if (!room || room.hostSessionId !== hostSessionId) return null;

    const pendingRaw = await this.store.get(`room:${roomId}:pending`);
    if (!pendingRaw) return null;
    const pending = JSON.parse(pendingRaw) as PendingJoinRequest;
    if (pending.requestId !== requestId) return null;

    await this.store.del(`room:${roomId}:pending`);
    await this.sessionService.updateSessionById(pending.guestSessionId, {
      roomId: null,
      role: 'NONE',
      canSignal: false,
    });

    return { guestSessionId: pending.guestSessionId, requestId };
  }

  async closeRoom(roomId: string): Promise<RoomRecord | null> {
    const room = await this.getRoom(roomId);
    if (!room) return null;

    await Promise.all([
      this.store.del(`room:${roomId}`),
      this.store.del(`room:${roomId}:pending`),
      this.store.del(`room:code:${room.codeHmac}`),
    ]);

    if (room.hostSessionId) {
      await this.sessionService.updateSessionById(room.hostSessionId, {
        roomId: null,
        role: 'NONE',
        canSignal: false,
      });
    }
    if (room.guestSessionId) {
      await this.sessionService.updateSessionById(room.guestSessionId, {
        roomId: null,
        role: 'NONE',
        canSignal: false,
      });
    }

    return room;
  }
}

