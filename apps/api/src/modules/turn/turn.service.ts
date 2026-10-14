import crypto from 'node:crypto';
import { env } from '../../config/env';

export interface IceServersResponse {
  iceServers: Array<{
    urls: string[];
    username?: string;
    credential?: string;
  }>;
  ttlSeconds: number;
}

export class TurnService {
  generateIceServers(sessionId: string): IceServersResponse {
    const iceServers: IceServersResponse['iceServers'] = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
        ],
      },
    ];

    // 1. Managed TURN via TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL (e.g. Metered.ca)
    if (env.TURN_URLS) {
      const urls = env.TURN_URLS.split(',').map((u) => u.trim());
      iceServers.push({
        urls,
        username: env.TURN_USERNAME,
        credential: env.TURN_CREDENTIAL,
      });
    } else if (env.TURN_HOST && env.TURN_SHARED_SECRET) {
      // 2. Self-hosted coturn with ephemeral HMAC credentials
      const ttlSeconds = env.TURN_CREDENTIAL_TTL_SECONDS;
      const expirationTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expirationTimestamp}:${sessionId}`;
      const credential = crypto
        .createHmac('sha1', env.TURN_SHARED_SECRET)
        .update(username)
        .digest('base64');

      iceServers.push({
        urls: [
          `turn:${env.TURN_HOST}:3478?transport=udp`,
          `turns:${env.TURN_HOST}:5349?transport=tcp`,
        ],
        username,
        credential,
      });
    }

    return {
      iceServers,
      ttlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
    };
  }
}

