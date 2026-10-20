import { useState, type FormEvent } from 'react';
import { ApiError, del, patch, post, request } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { useT } from '../i18n.js';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const ROLES = ['admin', 'supervisor', 'attendant', 'auditor', 'resident'] as const;

interface UnitRow { code: string; name: string; site: string | null; residents: { id: string; email: string; name: string | null }[]; pass_status: string | null }
interface Member { id: string; email: string; name: string | null; role: string; unit: string | null }
interface Invite { email: string; role: string; unit: string | null }

export function Units() {
  const t = useT();
  const units = useApi<UnitRow[]>('/v1/units');
  const [err, setErr] = useState('');
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try { await request('POST', '/v1/units', { code: f.code, name: f.name }); form.reset(); setErr(''); await units.reload(); } catch (x) { setErr(errText(x)); }
  }
  return (
    <div className="stack">
      <h1>{t('units.title')}</h1>
      <form className="card row" onSubmit={add}>
        <label className="field">{t('units.code')}<input name="code" required maxLength={30} dir="ltr" /></label>
        <label className="field grow">{t('units.name')}<input name="name" required maxLength={100} /></label>
        <button className="btn primary">{t('units.add')}</button>
      </form>
      {err && <div className="banner bad" role="alert">{err}</div>}
      <div className="tablewrap"><table>
        <thead><tr><th>{t('units.code')}</th><th>{t('units.name')}</th><th>{t('units.residents')}</th><th>{t('units.pass')}</th></tr></thead>
        <tbody>{units.data?.map((u) => (
          <tr key={u.code}><td>{u.code}</td><td>{u.name}</td><td>{u.residents.map((r) => r.name || r.email).join(', ') || '–'}</td>
            <td>{u.pass_status ? <span className={`pill ${u.pass_status === 'checked_in' ? 'info' : 'ok'}`}>{t(`res.status_${u.pass_status}`)}</span> : '–'}</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

export function People() {
  const t = useT();
  const { me } = useApp();
  const users = useApi<{ members: Member[]; invites: Invite[] }>('/v1/users');
  const units = useApi<UnitRow[]>('/v1/units');
  const [role, setRole] = useState<string>('attendant');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setErr(''); setMsg('');
    try {
      const r = await post<{ temporaryPassword?: string; invited?: boolean }>('/v1/users', { email: f.email, name: f.name || undefined, role: f.role, unit: f.role === 'resident' ? f.unit : undefined });
      setMsg(r.temporaryPassword ? t('users.tempPassword', { password: r.temporaryPassword }) : t('users.invited'));
      form.reset(); setRole('attendant'); await users.reload();
    } catch (x) { setErr(errText(x)); }
  }
  async function change(id: string, body: object) { try { await patch(`/v1/users/${id}`, body); setErr(''); await users.reload(); } catch (x) { setErr(errText(x)); } }
  async function remove(id: string) { try { await del(`/v1/users/${id}`); setErr(''); await users.reload(); } catch (x) { setErr(errText(x)); } }

  return (
    <div className="stack">
      <h1>{t('users.title')}</h1>
      <form className="card stack" onSubmit={invite}>
        <h2>{t('users.invite')}</h2>
        <div className="row">
          <label className="field grow">{t('auth.email')}<input name="email" type="email" required dir="ltr" /></label>
          <label className="field">{t('auth.name')}<input name="name" /></label>
          <label className="field">{t('users.role')}
            <select name="role" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></label>
          {role === 'resident' && (
            <label className="field">{t('users.unit')}
              <select name="unit" required>{units.data?.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}</select></label>
          )}
          <button className="btn primary">{t('users.invite')}</button>
        </div>
      </form>
      {msg && <div className="banner" role="status">{msg}</div>}
      {err && <div className="banner bad" role="alert">{err}</div>}

      <section><h2>{t('users.members')}</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>{t('auth.email')}</th><th>{t('users.role')}</th><th>{t('users.unit')}</th><th /></tr></thead>
          <tbody>{users.data?.members.map((m) => (
            <tr key={m.id}>
              <td>{m.name ? `${m.name} · ` : ''}{m.email}</td>
              <td>
                <select value={m.role} aria-label={t('users.role')} onChange={(e) => change(m.id, { role: e.target.value, ...(e.target.value === 'resident' && !m.unit ? { unit: units.data?.[0]?.code } : {}) })}>
                  {['owner', ...ROLES].map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select>
              </td>
              <td>{m.role === 'resident'
                ? <select value={m.unit ?? ''} aria-label={t('users.unit')} onChange={(e) => change(m.id, { unit: e.target.value })}>{units.data?.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}</select> : '–'}</td>
              <td><button className="btn danger" onClick={() => remove(m.id)} disabled={m.email === me?.user?.email}>{t('common.remove')}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>

      {!!users.data?.invites.length && (
        <section><h2>{t('users.pending')}</h2>
          <div className="tablewrap"><table><tbody>{users.data.invites.map((i) => (
            <tr key={i.email}><td>{i.email}</td><td>{t(`role.${i.role}`)}</td><td>{i.unit ?? '–'}</td></tr>
          ))}</tbody></table></div>
        </section>
      )}
    </div>
  );
}
