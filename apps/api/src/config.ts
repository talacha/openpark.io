import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Runtime connection: a non-owner role so RLS applies. */
  DATABASE_URL: z.string().default('postgres://openpark_app:openpark_app@localhost:54329/openpark'),
  /** LISTEN/NOTIFY needs a session-mode connection (Supabase's transaction pooler drops it). Defaults to DATABASE_URL. */
  LISTEN_DATABASE_URL: z.string().optional(),
  /** Owner connection for migrations and the pg-boss schema. */
  ADMIN_DATABASE_URL: z.string().default('postgres://openpark:openpark@localhost:54329/openpark'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me'),
  OPENPARK_APP_PASSWORD: z.string().optional(),
  /** External identity (Supabase Auth or any OIDC provider). Roles and tenants stay in our database. */
  SUPABASE_URL: z.string().url().optional(),
  /** Legacy Supabase projects sign tokens with a shared HS256 secret instead of publishing JWKS. */
  SUPABASE_JWT_SECRET: z.string().optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_JWKS_URL: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  /** Emails that become platform super admins when they sign in (comma separated). */
  SUPERADMIN_EMAILS: z.string().default('').transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
  /** Email + password accounts held by OpenPark itself. Defaults off when an external provider is configured. */
  LOCAL_AUTH: z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  /**
   * Self-service trial: anyone may create an organisation. Off by default (closed preview); when off, new organisations
   * are created by a platform admin and people join by invitation. Self-hosters turn it on for first-run setup.
   */
  TRIAL_SIGNUP: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),
  /**
   * Optional Gravatar API key. Used server-side only (never sent to the browser) to call the v3 profile
   * endpoint, which has higher rate limits than the public avatar URL and confirms a profile exists.
   */
  GRAVATAR_API_KEY: z.string().optional(),
  /** Notifications (all optional; without any, messages are logged and recorded as undeliverable). */
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  /** `whatsapp` sends via Twilio WhatsApp (needs approved templates for business-initiated messages). */
  NOTIFY_PHONE_CHANNEL: z.enum(['sms', 'whatsapp']).default('sms'),
  ALPR_URL: z.string().url().optional(),
  STORAGE_DIR: z.string().default('./data'),
  CORS_ORIGIN: z.string().default('*'),
  /** Webhooks may only target public addresses; allow private ones for local development and tests. */
  WEBHOOKS_ALLOW_PRIVATE: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.string().default('info'),
  /** On Vercel: no background workers or shared LISTEN connection; see server.ts. */
  SERVERLESS: z.enum(['true', 'false', '1', '0']).default(process.env.VERCEL ? 'true' : 'false').transform((v) => v === 'true' || v === '1'),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(process.env.VERCEL ? 2 : 10),
  /** Server-sent events hold a connection open, which serverless platforms bill for; off there (clients poll instead). */
  SSE_ENABLED: z.enum(['true', 'false', '1', '0']).default(process.env.VERCEL ? 'false' : 'true').transform((v) => v === 'true' || v === '1'),
  /** End SSE streams after this long (0 = never). EventSource reconnects on its own. */
  SSE_MAX_SECONDS: z.coerce.number().int().min(0).default(process.env.VERCEL ? 50 : 0),
  /** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
  CRON_SECRET: z.string().optional(),
  REGISTRY_DIR: z.string().optional(),
  JOBS_ENABLED: z.enum(['true', 'false', '1', '0']).default('true').transform((v) => v === 'true' || v === '1'),
});
export type Config = z.infer<typeof Env>;

export const externalAuthEnabled = (c: Config) => !!(c.SUPABASE_URL || c.OIDC_JWKS_URL || c.SUPABASE_JWT_SECRET);
export const localAuthEnabled = (c: Config) => c.LOCAL_AUTH ?? !externalAuthEnabled(c);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose and Helm pass unset variables as empty strings; treat those as absent.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const cfg = Env.parse(cleaned);
  if (env.NODE_ENV === 'production' && cfg.JWT_SECRET === 'dev-only-secret-change-me') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return cfg;
}
