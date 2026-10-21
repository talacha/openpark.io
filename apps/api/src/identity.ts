import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { externalAuthEnabled, type Config } from './config.js';

export interface ExternalIdentity {
  /** The provider's stable user id (`sub`). */
  sub: string;
  email: string | null;
  name: string | null;
}

/**
 * Verifies access tokens from an external identity provider: Supabase Auth (JWKS or legacy HS256 secret)
 * or any OIDC issuer. The provider only proves who someone is; roles and tenants live in our database.
 * Supabase must keep "Confirm email" enabled, so a token implies a verified address.
 */
export class IdentityVerifier {
  readonly enabled: boolean;
  private jwks?: JWTVerifyGetKey;
  private secret?: Uint8Array;
  private issuer?: string;
  private audience?: string;

  constructor(cfg: Config, opts: { keySet?: JWTVerifyGetKey; issuer?: string; audience?: string } = {}) {
    this.enabled = externalAuthEnabled(cfg) || !!opts.keySet;
    const supa = cfg.SUPABASE_URL?.replace(/\/$/, '');
    this.issuer = opts.issuer ?? cfg.OIDC_ISSUER ?? (supa ? `${supa}/auth/v1` : undefined);
    this.audience = opts.audience ?? cfg.OIDC_AUDIENCE ?? (supa ? 'authenticated' : undefined);
    const jwksUrl = cfg.OIDC_JWKS_URL ?? (supa ? `${supa}/auth/v1/.well-known/jwks.json` : undefined);
    this.jwks = opts.keySet ?? (jwksUrl ? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000 }) : undefined);
    if (cfg.SUPABASE_JWT_SECRET) this.secret = new TextEncoder().encode(cfg.SUPABASE_JWT_SECRET);
  }

  async verify(token: string): Promise<ExternalIdentity | null> {
    if (!this.enabled) return null;
    const opts = { ...(this.issuer ? { issuer: this.issuer } : {}), ...(this.audience ? { audience: this.audience } : {}) };
    try {
      const { payload } = this.jwks
        ? await jwtVerify(token, this.jwks, opts)
        : await jwtVerify(token, this.secret!, { ...opts, algorithms: ['HS256'] });
      if (!payload.sub || payload.is_anonymous === true) return null;
      const meta = (payload.user_metadata ?? {}) as { full_name?: string; name?: string; email_verified?: boolean };
      return {
        sub: payload.sub,
        // An address the provider has not verified must never link to an account or claim invitations.
        email: typeof payload.email === 'string' && (payload.email_verified ?? meta.email_verified) !== false ? payload.email.toLowerCase() : null,
        name: meta.full_name ?? meta.name ?? null,
      };
    } catch {
      return null;
    }
  }
}
