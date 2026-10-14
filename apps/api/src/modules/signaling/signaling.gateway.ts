import type { Server, Socket } from 'socket.io';
import {
  RoomSubscribeSchema,
  WebRtcSdpSchema,
  WebRtcIceCandidateSchema,
} from '@nexashare/shared';
import { SessionService, type EphemeralSession } from '../auth/session.service';
import { RoomService } from '../rooms/room.service';

interface AuthenticatedSocket extends Socket {
  data: {
    session: EphemeralSession;
    eventTimestamps: number[];
  };
}

export function registerSignalingGateway(
  io: Server,
  sessionService: SessionService,
  roomService: RoomService
) {
  const signalNamespace = io.of('/signal');

  signalNamespace.use(async (socket, next) => {
    const rawAuth =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');

    const session = await sessionService.verifyToken(rawAuth);
    if (!session) {
      return next(new Error('UNAUTHORIZED_SESSION'));
    }

    (socket as AuthenticatedSocket).data = {
      session,
      eventTimestamps: [],
    };
    socket.join(`session:${session.sessionId}`);
    next();
  });

  signalNamespace.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;

    socket.use((packet, next) => {
      const [eventName, payload] = packet;
      if (
        eventName === 'file:chunk' ||
        Buffer.isBuffer(payload) ||
        payload instanceof ArrayBuffer
      ) {
        return next(new Error('BINARY_PAYLOAD_FORBIDDEN_ON_SIGNALING'));
      }

      const now = Date.now();
      socket.data.eventTimestamps = socket.data.eventTimestamps.filter(
        (ts) => now - ts < 10_000
      );
      if (socket.data.eventTimestamps.length >= 80) {
        return next(new Error('SIGNALING_RATE_LIMITED'));
      }
      socket.data.eventTimestamps.push(now);
      next();
    });

    socket.on('room:subscribe', async (rawPayload, ack) => {
      const parsed = RoomSubscribeSchema.safeParse(rawPayload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });

      const freshSession = await sessionService.verifyToken(
        socket.handshake.auth?.token
      );
      if (!freshSession || freshSession.roomId !== parsed.data.roomId) {
        return ack?.({ ok: false, error: 'FORBIDDEN_ROOM' });
      }

      socket.data.session = freshSession;
      await socket.join(`room:${parsed.data.roomId}`);
      socket.to(`room:${parsed.data.roomId}`).emit('peer:presence', {
        status: 'connected',
        role: freshSession.role,
      });
      ack?.({ ok: true });
    });

    const verifyPairedSignaling = async (roomId: string) => {
      const freshSession = await sessionService.verifyToken(
        socket.handshake.auth?.token
      );
      if (
        !freshSession ||
        !freshSession.canSignal ||
        freshSession.roomId !== roomId
      ) {
        return null;
      }
      const room = await roomService.getRoom(roomId);
      if (!room || (room.status !== 'PAIRED' && room.status !== 'ACTIVE')) {
        return null;
      }
      return { session: freshSession, room };
    };

    socket.on('webrtc:offer', async (rawPayload) => {
      const parsed = WebRtcSdpSchema.safeParse(rawPayload);
      if (!parsed.success || parsed.data.sdp.type !== 'offer') return;

      const verified = await verifyPairedSignaling(parsed.data.roomId);
      if (!verified) return;

      socket.to(`room:${parsed.data.roomId}`).emit('webrtc:offer', {
        roomId: parsed.data.roomId,
        sdp: parsed.data.sdp,
      });
    });

    socket.on('webrtc:answer', async (rawPayload) => {
      const parsed = WebRtcSdpSchema.safeParse(rawPayload);
      if (!parsed.success || parsed.data.sdp.type !== 'answer') return;

      const verified = await verifyPairedSignaling(parsed.data.roomId);
      if (!verified) return;

      socket.to(`room:${parsed.data.roomId}`).emit('webrtc:answer', {
        roomId: parsed.data.roomId,
        sdp: parsed.data.sdp,
      });
    });

    socket.on('webrtc:ice-candidate', async (rawPayload) => {
      const parsed = WebRtcIceCandidateSchema.safeParse(rawPayload);
      if (!parsed.success) return;

      const verified = await verifyPairedSignaling(parsed.data.roomId);
      if (!verified) return;

      socket.to(`room:${parsed.data.roomId}`).emit('webrtc:ice-candidate', {
        roomId: parsed.data.roomId,
        candidate: parsed.data.candidate,
      });
    });

    socket.on('webrtc:restart-requested', async (rawPayload) => {
      const parsed = RoomSubscribeSchema.safeParse(rawPayload);
      if (!parsed.success) return;

      const verified = await verifyPairedSignaling(parsed.data.roomId);
      if (!verified) return;

      socket.to(`room:${parsed.data.roomId}`).emit('webrtc:restart-requested', {
        roomId: parsed.data.roomId,
      });
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.session?.roomId;
      if (roomId) {
        socket.to(`room:${roomId}`).emit('peer:presence', {
          status: 'disconnected',
          role: socket.data.session.role,
        });
      }
    });
  });

  return signalNamespace;
}
