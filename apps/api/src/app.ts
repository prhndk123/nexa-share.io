import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  SendSignalRequestSchema,
  type SignalMessage,
} from '@nexashare/shared';
import { env } from './config/env';
import { globalStateStore } from './modules/store/state-store';
import { SessionService, type EphemeralSession } from './modules/auth/session.service';
import { RoomService } from './modules/rooms/room.service';
import { TurnService } from './modules/turn/turn.service';

declare global {
  namespace Express {
    interface Request {
      session?: EphemeralSession;
      requestId: string;
    }
  }
}

export const sessionService = new SessionService(globalStateStore);
export const roomService = new RoomService(globalStateStore, sessionService);
export const turnService = new TurnService();

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // In production/Vercel allow same-origin, configured APP_ORIGIN, or any localhost in dev
      if (!origin || origin === env.APP_ORIGIN || origin.includes('localhost') || origin.endsWith('.vercel.app')) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive for P2P web app clients
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '64kb' }));

app.use((req, _res, next) => {
  req.requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
  next();
});

function sendError(res: Response, status: number, code: string, message: string, requestId: string) {
  return res.status(status).json({
    error: { code, message, requestId },
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const session = await sessionService.verifyToken(token);
  if (!session) {
    return sendError(
      res,
      401,
      'UNAUTHORIZED',
      'Sesi perangkat tidak valid atau sudah kedaluwarsa.',
      req.requestId
    );
  }
  req.session = session;
  next();
}

// 1. Ephemeral anonymous device session
app.post('/api/v1/sessions', async (_req, res) => {
  const { token, session } = await sessionService.createSession();
  res.status(201).json({
    token,
    sessionId: session.sessionId,
    expiresInSeconds: env.ROOM_CONNECTED_TTL_SECONDS,
  });
});

// 2. Create room with CSPRNG 6-digit code
app.post('/api/v1/rooms', requireAuth, async (req, res) => {
  const parsed = CreateRoomRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_PAYLOAD', 'Label perangkat tidak valid.', req.requestId);
  }

  const created = await roomService.createRoom(
    req.session!.sessionId,
    parsed.data.deviceLabel
  );
  res.status(201).json(created);
});

// 3. Get room metadata
app.get('/api/v1/rooms/:roomId', requireAuth, async (req, res) => {
  const room = await roomService.getRoom(req.params.roomId);
  if (
    !room ||
    (room.hostSessionId !== req.session!.sessionId &&
      room.guestSessionId !== req.session!.sessionId)
  ) {
    return sendError(
      res,
      404,
      'ROOM_UNAVAILABLE',
      'Ruangan tidak tersedia atau kode sudah kedaluwarsa.',
      req.requestId
    );
  }

  res.json({
    roomId: room.roomId,
    status: room.status,
    expiresAt: room.expiresAt,
    hostDeviceLabel: room.hostDeviceLabel,
    guestDeviceLabel: room.guestDeviceLabel,
  });
});

// 4. Guest requests to join room via 6-digit code
app.post('/api/v1/rooms/join', requireAuth, async (req, res) => {
  const parsed = JoinRoomRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_CODE_FORMAT', 'Format kode harus 6 digit.', req.requestId);
  }

  const allowed = await roomService.enforceJoinRateLimit(
    req.ip || 'unknown',
    req.session!.sessionId
  );
  if (!allowed) {
    return sendError(
      res,
      429,
      'RATE_LIMITED',
      'Terlalu banyak percobaan bergabung. Silakan tunggu beberapa saat.',
      req.requestId
    );
  }

  const joinResult = await roomService.requestJoin(
    parsed.data.code,
    req.session!.sessionId,
    parsed.data.deviceLabel
  );

  if (!joinResult) {
    return sendError(
      res,
      404,
      'ROOM_UNAVAILABLE',
      'Ruangan tidak tersedia atau kode sudah kedaluwarsa.',
      req.requestId
    );
  }

  // Push notification signal for Host
  const signalMsg: SignalMessage = {
    id: crypto.randomUUID(),
    type: 'join:requested',
    roomId: joinResult.roomId,
    senderRole: 'GUEST',
    recipientRole: 'HOST',
    payload: {
      roomId: joinResult.roomId,
      requestId: joinResult.requestId,
      deviceLabel: parsed.data.deviceLabel,
    },
    timestamp: Date.now(),
  };

  await globalStateStore.pushSignal(joinResult.roomId, 'HOST', signalMsg);

  res.status(202).json({
    requestId: joinResult.requestId,
    roomId: joinResult.roomId,
    status: 'PENDING_APPROVAL',
    expiresInSeconds: joinResult.expiresInSeconds,
  });
});

// 5. Host approves join request
app.post(
  '/api/v1/rooms/:roomId/requests/:requestId/approve',
  requireAuth,
  async (req, res) => {
    const approved = await roomService.approveJoin(
      req.params.roomId,
      req.params.requestId,
      req.session!.sessionId
    );
    if (!approved) {
      return sendError(
        res,
        409,
        'APPROVAL_FAILED',
        'Permintaan bergabung sudah kedaluwarsa atau tidak valid.',
        req.requestId
      );
    }

    const signalMsg: SignalMessage = {
      id: crypto.randomUUID(),
      type: 'join:approved',
      roomId: approved.room.roomId,
      senderRole: 'HOST',
      recipientRole: 'GUEST',
      payload: {
        roomId: approved.room.roomId,
        memberRole: 'GUEST',
        signalingReady: true,
      },
      timestamp: Date.now(),
    };

    await globalStateStore.pushSignal(approved.room.roomId, 'GUEST', signalMsg);

    res.json({ status: 'PAIRED', roomId: approved.room.roomId });
  }
);

// 6. Host rejects join request
app.post(
  '/api/v1/rooms/:roomId/requests/:requestId/reject',
  requireAuth,
  async (req, res) => {
    const rejected = await roomService.rejectJoin(
      req.params.roomId,
      req.params.requestId,
      req.session!.sessionId
    );
    if (!rejected) {
      return sendError(
        res,
        409,
        'REJECT_FAILED',
        'Permintaan tidak ditemukan.',
        req.requestId
      );
    }

    const signalMsg: SignalMessage = {
      id: crypto.randomUUID(),
      type: 'join:rejected',
      roomId: req.params.roomId,
      senderRole: 'HOST',
      recipientRole: 'GUEST',
      payload: {
        requestId: rejected.requestId,
        reason: 'Permintaan koneksi ditolak oleh pemilik ruangan.',
      },
      timestamp: Date.now(),
    };

    await globalStateStore.pushSignal(req.params.roomId, 'GUEST', signalMsg);

    res.json({ status: 'REJECTED' });
  }
);

// 7. Leave room
app.post('/api/v1/rooms/:roomId/leave', requireAuth, async (req, res) => {
  const room = await roomService.getRoom(req.params.roomId);
  if (
    !room ||
    (room.hostSessionId !== req.session!.sessionId &&
      room.guestSessionId !== req.session!.sessionId)
  ) {
    return sendError(res, 403, 'FORBIDDEN', 'Akses tidak diizinkan.', req.requestId);
  }

  await roomService.closeRoom(req.params.roomId);

  const signalMsg: SignalMessage = {
    id: crypto.randomUUID(),
    type: 'room:closed',
    roomId: req.params.roomId,
    senderRole: req.session!.role === 'HOST' ? 'HOST' : 'GUEST',
    recipientRole: 'ALL',
    payload: {
      reason: 'Salah satu perangkat telah menutup sesi transfer.',
    },
    timestamp: Date.now(),
  };

  await globalStateStore.pushSignal(req.params.roomId, 'HOST', signalMsg);
  await globalStateStore.pushSignal(req.params.roomId, 'GUEST', signalMsg);

  res.json({ status: 'CLOSED' });
});

// 8. STUN & TURN credentials
app.get('/api/v1/ice-servers', requireAuth, async (req, res) => {
  if (!req.session!.canSignal || !req.session!.roomId) {
    return sendError(
      res,
      403,
      'SIGNALING_NOT_AUTHORIZED',
      'Kredensial TURN hanya diberikan setelah persetujuan host.',
      req.requestId
    );
  }

  const iceConfig = turnService.generateIceServers(req.session!.sessionId);
  res.json(iceConfig);
});

// 9. Send signal message (Serverless REST Signaling)
app.post('/api/v1/signal/send', requireAuth, async (req, res) => {
  const parsed = SendSignalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_SIGNAL_PAYLOAD', 'Payload sinyal tidak valid.', req.requestId);
  }

  const { roomId, type, recipientRole, payload } = parsed.data;

  // Authorization check
  if (req.session!.roomId !== roomId || !req.session!.canSignal) {
    return sendError(res, 403, 'FORBIDDEN', 'Tidak diizinkan mengirim sinyal ke ruangan ini.', req.requestId);
  }

  const signalMsg: SignalMessage = {
    id: crypto.randomUUID(),
    type,
    roomId,
    senderRole: req.session!.role === 'HOST' ? 'HOST' : 'GUEST',
    recipientRole,
    payload,
    timestamp: Date.now(),
  };

  if (recipientRole === 'ALL') {
    await globalStateStore.pushSignal(roomId, 'HOST', signalMsg);
    await globalStateStore.pushSignal(roomId, 'GUEST', signalMsg);
  } else {
    await globalStateStore.pushSignal(roomId, recipientRole, signalMsg);
  }

  res.json({ ok: true, id: signalMsg.id });
});

// 10. Poll signal messages (Serverless REST Signaling)
app.get('/api/v1/signal/poll', requireAuth, async (req, res) => {
  const roomId = req.query.roomId as string;
  const afterTimestamp = parseInt((req.query.after as string) || '0', 10);

  if (!roomId || req.session!.roomId !== roomId) {
    return sendError(res, 403, 'FORBIDDEN', 'Akses sinyal tidak diizinkan.', req.requestId);
  }

  const myRole = req.session!.role === 'HOST' ? 'HOST' : 'GUEST';
  const signals = await globalStateStore.pollSignals(roomId, myRole, afterTimestamp);

  res.json({
    signals,
    serverTime: Date.now(),
  });
});

// 11. Health checks
app.get('/api/v1/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/v1/health/ready', (_req, res) => res.json({ status: 'ready', zeroDb: true }));

export default app;
