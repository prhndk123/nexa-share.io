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
    origin: (origin, callback) => callback(null, true),
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
  try {
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
  } catch (err) {
    next(err);
  }
}

// Router to support both /api/v1 and /v1 (regardless of Vercel rewrite prefix stripping)
const router = express.Router();

// 1. Ephemeral anonymous device session
router.post('/sessions', async (req, res, next) => {
  try {
    const { token, session } = await sessionService.createSession();
    res.status(201).json({
      token,
      sessionId: session.sessionId,
      expiresInSeconds: env.ROOM_CONNECTED_TTL_SECONDS,
    });
  } catch (err) {
    next(err);
  }
});

// 2. Create room with CSPRNG 6-digit code
router.post('/rooms', requireAuth, async (req, res, next) => {
  try {
    const parsed = CreateRoomRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'Label perangkat tidak valid.', req.requestId);
    }

    const created = await roomService.createRoom(
      req.session!.sessionId,
      parsed.data.deviceLabel
    );
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// 3. Get room metadata
router.get('/rooms/:roomId', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 4. Guest requests to join room via 6-digit code
router.post('/rooms/join', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 5. Host approves join request
router.post('/rooms/:roomId/requests/:requestId/approve', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 6. Host rejects join request
router.post('/rooms/:roomId/requests/:requestId/reject', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 7. Leave room
router.post('/rooms/:roomId/leave', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 8. STUN & TURN credentials
router.get('/ice-servers', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 9. Send signal message (Serverless REST Signaling)
router.post('/signal/send', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 10. Poll signal messages (Serverless REST Signaling)
router.get('/signal/poll', requireAuth, async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 11. Health checks
router.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
router.get('/health/ready', (_req, res) => res.json({ status: 'ready', zeroDb: true }));

// Mount router on both /api/v1 and /v1 so any Vercel rewrite matches seamlessly
app.use('/api/v1', router);
app.use('/v1', router);

// Global Error Handler Middleware
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error('Express Error Handler Caught:', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err?.message || 'Terjadi kesalahan pada server.',
      requestId: req.requestId,
    },
  });
});

export default app;
