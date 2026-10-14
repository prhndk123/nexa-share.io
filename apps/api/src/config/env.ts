import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  API_ORIGIN: z.string().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Upstash Serverless Redis (Native for Vercel)
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().optional(),

  // Standard Redis (Optional for local or traditional server)
  REDIS_URL: z.string().optional(),

  SESSION_SIGNING_SECRET: z.string().min(16).default('dev-session-signing-secret-must-be-at-least-16-chars'),
  ROOM_CODE_HMAC_SECRET: z.string().min(16).default('dev-room-code-hmac-secret-must-be-at-least-16-chars'),
  ROOM_JOIN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  ROOM_PENDING_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  ROOM_CONNECTED_TTL_SECONDS: z.coerce.number().int().positive().default(7200),

  // STUN / TURN
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  TURN_HOST: z.string().optional(),
  TURN_SHARED_SECRET: z.string().optional(),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // Optional Pusher
  PUSHER_APP_ID: z.string().optional(),
  PUSHER_KEY: z.string().optional(),
  PUSHER_SECRET: z.string().optional(),
  PUSHER_CLUSTER: z.string().optional(),

  RATE_JOIN_LIMIT: z.coerce.number().int().positive().default(5),
  RATE_JOIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const env = EnvSchema.parse(process.env);

