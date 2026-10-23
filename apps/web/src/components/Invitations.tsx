import { useState } from 'react';
import { post } from '../api.js';
import { useApp } from '../app-context.js';
import { errText } from '../errors.js';
import { useT } from '../i18n.js';
import { useApi } from './hooks.js';
import { Alert } from './ui/alert.js';
import { Button } from './ui/button.js';

interface Invite { slug: string; name: string; roles: string[]; unit: string | null; superadmin: boolean }

export function Invitations() {
  const t = useT();
  const { reload, switchTenant } = useApp();
  const list = useApi<Invite[]>('/v1/auth/invitations');
  const [err, setErr] = useState('');
  if (!list.data?.length) return err ? <Alert className="banner bad" variant="destructive">{err}</Alert> : null;

  async function accept(slug: string) {
    try {
      await post(`/v1/auth/invitations/${slug}/accept`);
      setErr('');
      await list.reload();
      await reload();
      await switchTenant(slug);
    } catch (error) { setErr(errText(error)); }
  }

  return (
    <section className="stack" aria-label={t('invite.title')}>
      {list.data.map((invite) => (
        <Alert key={invite.slug} className="banner row between" role="status">
          <span><strong>{t('invite.text', { org: invite.name, roles: [...invite.roles.map((role) => t(`role.${role}`)), ...(invite.superadmin ? [t('role.superadmin')] : [])].join(' · ') })}</strong></span>
          <Button type="button" className="btn primary" onClick={() => void accept(invite.slug)}>{t('invite.accept')}</Button>
        </Alert>
      ))}
      {err && <Alert className="banner bad" variant="destructive">{err}</Alert>}
    </section>
  );
}
