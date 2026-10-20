import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, request, setSession } from '../api.js';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';

const COUNTRIES = ['MX', 'US', 'BR', 'ES', 'FR', 'DE', 'CO', 'AR', 'CL', 'PE', 'CA', 'GB', 'SA', 'AE'];

export function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const t = useT();
  const nav = useNavigate();
  const { reload } = useApp();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true); setErr('');
    try {
      if (mode === 'signup') {
        const r = await request<{ token: string; tenant: { slug: string } }>('POST', '/v1/signup', { email: f.email, password: f.password, name: f.name, organisation: f.org, country: f.country });
        setSession({ token: r.token, tenant: r.tenant.slug });
        await reload(); nav(`/t/${r.tenant.slug}/dashboard`);
      } else {
        const r = await request<{ token: string; memberships: { slug: string }[] }>('POST', '/v1/auth/login', { email: f.email, password: f.password });
        const slug = r.memberships[0]?.slug ?? null;
        setSession({ token: r.token, tenant: slug });
        await reload(); nav(slug ? `/t/${slug}` : '/login');
      }
    } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h1>{mode === 'signup' ? t('auth.signup') : t('auth.signin')}</h1>
        {mode === 'signup' && <p className="muted">{t('auth.trial')}</p>}
        {mode === 'signup' && <label className="field">{t('auth.name')}<input name="name" autoComplete="name" /></label>}
        {mode === 'signup' && <label className="field">{t('auth.org')}<input name="org" required minLength={2} /></label>}
        {mode === 'signup' && (
          <label className="field">{t('auth.country')}
            <select name="country" defaultValue="MX">{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
        )}
        <label className="field">{t('auth.email')}<input name="email" type="email" required autoComplete="email" /></label>
        <label className="field">{t('auth.password')}
          <input name="password" type="password" required minLength={mode === 'signup' ? 10 : 1} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          {mode === 'signup' && <small>{t('auth.passwordHint')}</small>}
        </label>
        {err && <div className="banner bad" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{mode === 'signup' ? t('auth.signup') : t('auth.signin')}</button>
        <Link to={mode === 'signup' ? '/login' : '/signup'}>{mode === 'signup' ? t('auth.signin') : t('auth.signup')}</Link>
      </form>
    </div>
  );
}
