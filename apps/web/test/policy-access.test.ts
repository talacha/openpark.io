import { describe, expect, it } from 'vitest';
import { canEditPassPolicy } from '../src/app-context.js';
import type { Me, Role } from '../src/app-context.js';

/** A minimal Me with the given roles / super-admin flag; only the fields canEditPassPolicy reads need to be real. */
const me = (roles: Role[], superadmin = false): Me => ({
  roles, superadmin, user: null, unit: null,
  tenant: { slug: 't', name: 'T', country: 'MX', default_locale: 'es-MX', locales: ['es-MX'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
});

describe('who may edit the guest-pass (overstay) policy', () => {
  // This MUST mirror the server's settings.edit permission: admins and super admins only. A supervisor holds
  // fee.override / session.void but NOT settings.edit, so PATCH /v1/pass-policy returns 403 for them — the editor
  // must therefore be read-only for supervisors, never an apparently-editable form whose Save always fails.
  it('allows admins and super admins', () => {
    expect(canEditPassPolicy(me(['admin']))).toBe(true);
    expect(canEditPassPolicy(me(['resident'], true))).toBe(true); // platform super admin
    expect(canEditPassPolicy(me(['supervisor', 'admin']))).toBe(true);
  });

  it('denies supervisors and attendants, matching the API (no settings.edit)', () => {
    expect(canEditPassPolicy(me(['supervisor']))).toBe(false);
    expect(canEditPassPolicy(me(['attendant']))).toBe(false);
    expect(canEditPassPolicy(me(['resident']))).toBe(false);
    expect(canEditPassPolicy(null)).toBe(false);
  });
});
