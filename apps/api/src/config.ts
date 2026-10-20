import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Runtime connection: a non-owner role so RLS applies. */
  DATABASE_URL: z.string().default('postgres://openpark_app:openpark_app@localhost:54329/openpark'),
  /** Owner connection for migrations and the pg-boss schema. */
  ADMIN_DATABASE_URL: z.string().default('postgres://openpark:openpark@localhost:54329/openpark'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me'),
  OPENPARK_APP_PASSWORD: z.string().optional(),
  ALPR_URL: z.string().url().optional(),
  STORAGE_DIR: z.string().default('./data'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),
  JOBS_ENABLED: z.enum(['true', 'false', '1', '0']).default('true').transform((v) => v === 'true' || v === '1'),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose and Helm pass unset variables as empty strings; treat those as absent.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const cfg = Env.parse(cleaned);
  if (env.NODE_ENV === 'production' && cfg.JWT_SECRET === 'dev-only-secret-change-me') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return cfg;
}
