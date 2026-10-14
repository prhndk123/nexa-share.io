import { z } from 'zod';

const cleanString = z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().optional());
const cleanUrl = z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  API_ORIGIN: z.string().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Upstash Serverless Redis (Native for Vercel)
  UPSTASH_REDIS_REST_URL: cleanUrl,
  UPSTASH_REDIS_REST_TOKEN: cleanString,
  KV_REST_API_URL: cleanUrl,
  KV_REST_API_TOKEN: cleanString,

  // Standard Redis (Optional for local or traditional server)
  REDIS_URL: cleanString,

  SESSION_SIGNING_SECRET: z.preprocess(
    (val) => (typeof val === 'string' && val.length >= 16 ? val : undefined),
    z.string().min(16).default('dev-session-signing-secret-must-be-at-least-16-chars')
  ),
  ROOM_CODE_HMAC_SECRET: z.preprocess(
    (val) => (typeof val === 'string' && val.length >= 16 ? val : undefined),
    z.string().min(16).default('dev-room-code-hmac-secret-must-be-at-least-16-chars')
  ),
  ROOM_JOIN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  ROOM_PENDING_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  ROOM_CONNECTED_TTL_SECONDS: z.coerce.number().int().positive().default(7200),

  // STUN / TURN
  TURN_URLS: cleanString,
  TURN_USERNAME: cleanString,
  TURN_CREDENTIAL: cleanString,
  TURN_HOST: cleanString,
  TURN_SHARED_SECRET: cleanString,
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // Optional Pusher
  PUSHER_APP_ID: cleanString,
  PUSHER_KEY: cleanString,
  PUSHER_SECRET: cleanString,
  PUSHER_CLUSTER: cleanString,

  RATE_JOIN_LIMIT: z.coerce.number().int().positive().default(5),
  RATE_JOIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const env = EnvSchema.parse(process.env);


