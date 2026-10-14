import type { SignalMessage, SignalType } from '@nexashare/shared';

const BASE_URL = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const error = data?.error || {
      code: 'UNKNOWN_ERROR',
      message: `Permintaan gagal dengan status ${res.status}`,
    };
    throw new ApiError(error.code, error.message, res.status);
  }

  return data as T;
}

export const api = {
  async createSession(): Promise<{ token: string; sessionId: string; expiresInSeconds: number }> {
    return fetchJson('/sessions', { method: 'POST' });
  },

  async createRoom(
    token: string,
    deviceLabel: string
  ): Promise<{
    roomId: string;
    code: string;
    expiresAt: string;
    status: string;
    inviteUrl: string;
  }> {
    return fetchJson('/rooms', { method: 'POST', body: JSON.stringify({ deviceLabel }) }, token);
  },

  async getRoom(
    token: string,
    roomId: string
  ): Promise<{
    roomId: string;
    status: string;
    expiresAt: string;
    hostDeviceLabel: string;
    guestDeviceLabel: string | null;
  }> {
    return fetchJson(`/rooms/${roomId}`, { method: 'GET' }, token);
  },

  async requestJoin(
    token: string,
    code: string,
    deviceLabel: string
  ): Promise<{
    requestId: string;
    roomId: string;
    status: string;
    expiresInSeconds: number;
  }> {
    return fetchJson('/rooms/join', { method: 'POST', body: JSON.stringify({ code, deviceLabel }) }, token);
  },

  async approveJoin(
    token: string,
    roomId: string,
    requestId: string
  ): Promise<{ status: string; roomId: string }> {
    return fetchJson(`/rooms/${roomId}/requests/${requestId}/approve`, { method: 'POST' }, token);
  },

  async rejectJoin(
    token: string,
    roomId: string,
    requestId: string
  ): Promise<{ status: string }> {
    return fetchJson(`/rooms/${roomId}/requests/${requestId}/reject`, { method: 'POST' }, token);
  },

  async leaveRoom(token: string, roomId: string): Promise<{ status: string }> {
    return fetchJson(`/rooms/${roomId}/leave`, { method: 'POST' }, token);
  },

  async getIceServers(token: string): Promise<{ iceServers: RTCIceServer[]; ttlSeconds: number }> {
    return fetchJson('/ice-servers', { method: 'GET' }, token);
  },

  async sendSignal(
    token: string,
    roomId: string,
    type: SignalType,
    recipientRole: 'HOST' | 'GUEST' | 'ALL',
    payload: any
  ): Promise<void> {
    await fetchJson(
      '/signal/send',
      {
        method: 'POST',
        body: JSON.stringify({ roomId, type, recipientRole, payload }),
      },
      token
    );
  },

  async pollSignals(
    token: string,
    roomId: string,
    afterTimestamp: number
  ): Promise<{ signals: SignalMessage[]; serverTime: number }> {
    return fetchJson(`/signal/poll?roomId=${encodeURIComponent(roomId)}&after=${afterTimestamp}`, { method: 'GET' }, token);
  },
};
