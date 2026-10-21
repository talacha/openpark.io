import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError, post } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';

interface Tenant { slug: string; name: string; country: string; created_at: string; suspended_at: string | null; suspended_reason: string | null; members: number; sites: number; open_sessions: number }

/** Platform super admin: every organisation, with suspend/resume and a way in. */
export function Platform() {
  const t = useT();
  const nav = useNavigate();
  const { switchTenant, who } = useApp();
  const fmt = useFormat();
  const tenants = useApi<Tenant[]>('/v1/platform/tenants');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      const r = await post<{ slug: string; ownerEmail: string; temporaryPassword?: string; invited?: boolean }>('/v1/platform/tenants', { organisation: f.org, country: f.country, ownerEmail: f.owner });
      setNote(`${t('platform.created')} ${r.temporaryPassword ? t('users.tempPassword', { password: r.temporaryPassword }) : t('platform.ownerInvited', { email: r.ownerEmail })}`);
      setErr(''); form.reset(); await tenants.reload();
    } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); }
  }

  async function suspend(slug: string) {
    const reason = prompt(t('platform.reason'));
    if (!reason) return;
    try { await post(`/v1/platform/tenants/${slug}/suspend`, { reason }); setErr(''); await tenants.reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }
  async function resume(slug: string) { try { await post(`/v1/platform/tenants/${slug}/resume`); await tenants.reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } }
  async function enter(slug: string) { await switchTenant(slug); nav(`/t/${slug}/dashboard`); }

  if (!who) return <Navigate to="/login" replace />;
  if (!who.superadmin) return <Navigate to="/" replace />;
  return (
    <div>
      <div className="stack">
        <h1>{t('platform.tenants')}</h1>
        <form className="card row" onSubmit={create}>
          <label className="field grow">{t('auth.org')}<input name="org" required minLength={2} /></label>
          <label className="field">{t('auth.country')}<select name="country" defaultValue="MX">{['MX', 'US', 'BR', 'ES', 'FR', 'DE'].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="field grow">{t('platform.ownerEmail')}<input name="owner" type="email" required dir="ltr" /></label>
          <button className="btn primary">{t('platform.create')}</button>
        </form>
        {note && <div className="banner" role="status">{note}</div>}
        {err && <div className="banner bad" role="alert">{err}</div>}
        <div className="tablewrap"><table>
          <thead><tr><th>{t('auth.org')}</th><th>{t('auth.country')}</th><th className="num">{t('platform.members')}</th><th className="num">{t('platform.sites')}</th><th className="num">{t('platform.open')}</th><th /></tr></thead>
          <tbody>{tenants.data?.map((x) => (
            <tr key={x.slug}>
              <td><strong>{x.name}</strong><br /><span className="muted">{x.slug} · {fmt.dateTime(x.created_at)}</span></td>
              <td>{x.country}</td><td className="num">{x.members}</td><td className="num">{x.sites}</td><td className="num">{x.open_sessions}</td>
              <td>
                <span className="row">
                  {x.suspended_at ? <><span className="pill bad" title={x.suspended_reason ?? ''}>{t('platform.suspended')}</span><button className="btn" onClick={() => resume(x.slug)}>{t('platform.resume')}</button></>
                    : <button className="btn danger" onClick={() => suspend(x.slug)}>{t('platform.suspend')}</button>}
                  <button className="btn primary" onClick={() => enter(x.slug)}>{t('platform.enter')}</button>
                </span>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </div>
  );
}
