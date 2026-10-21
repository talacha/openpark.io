import { useState } from 'react';
import { post } from '../api.js';
import { useApp } from '../app-context.js';
import { errText } from '../errors.js';
import { useT } from '../i18n.js';
import { useApi } from './hooks.js';

interface Invite { slug: string; name: string; roles: string[]; unit: string | null; superadmin: boolean }

/** Invitations to join other properties, addressed to this email. Joining is always the person's own choice. */
export function Invitations() {
  const t = useT();
  const { reload, switchTenant } = useApp();
  const list = useApi<Invite[]>('/v1/auth/invitations');
  const [err, setErr] = useState('');
  if (!list.data?.length) return err ? <div className="banner bad" role="alert">{err}</div> : null;
  async function accept(slug: string) {
    try { await post(`/v1/auth/invitations/${slug}/accept`); setErr(''); await list.reload(); await reload(); await switchTenant(slug); } catch (x) { setErr(errText(x)); }
  }
  return (
    <section className="stack" aria-label={t('invite.title')}>
      {list.data.map((i) => (
        <div key={i.slug} className="banner row between" role="status">
          <span><strong>{t('invite.text', { org: i.name, roles: [...i.roles.map((r) => t(`role.${r}`)), ...(i.superadmin ? [t('role.superadmin')] : [])].join(' · ') })}</strong></span>
          <button type="button" className="btn primary" onClick={() => void accept(i.slug)}>{t('invite.accept')}</button>
        </div>
      ))}
      {err && <div className="banner bad" role="alert">{err}</div>}
    </section>
  );
}
