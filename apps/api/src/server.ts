import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { MAX_SDP_BYTES } from '@nexashare/shared';
import { env } from './config/env';
import { app, sessionService, roomService } from './app';
import { registerSignalingGateway } from './modules/signaling/signaling.gateway';

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  maxHttpBufferSize: MAX_SDP_BYTES,
  cors: {
    origin: (origin, callback) => callback(null, true),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

registerSignalingGateway(io, sessionService, roomService);

httpServer.listen(env.PORT, () => {
  console.info(
    JSON.stringify({
      level: 'info',
      msg: 'NexaShare API & Signaling server running (Zero-Database)',
      port: env.PORT,
    })
  );
});
