import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, request, setSession } from '../api.js';
import { homeFor, useApp } from '../app-context.js';
import { externalAuth, peekPending, savePending, supabase, takePending } from '../auth.js';
import { PasswordInput } from '../components/PasswordInput.js';
import { LOCALES, NAMES, useI18n, useT } from '../i18n.js';

const COUNTRIES = ['MX', 'US', 'BR', 'ES', 'FR', 'DE', 'CO', 'AR', 'CL', 'PE', 'CA', 'GB', 'SA', 'AE'];
const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error)?.message ?? String(e));

function LangPick() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  return (
    <select className="langpick" aria-label={t('auth.language')} value={locale} onChange={(e) => setLocale(e.target.value)}>
      {[...LOCALES].map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}
    </select>
  );
}

function useCountryName() {
  const { locale } = useI18n();
  return (c: string) => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(c) ?? c; } catch { return c; } };
}

/** Sign in, sign up, forgot-password and reset. Uses Supabase Auth when configured, else OpenPark's own accounts. */
export function Auth({ mode }: { mode: 'login' | 'signup' | 'forgot' | 'reset' }) {
  const t = useT();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { reload, config } = useApp();
  const countryName = useCountryName();
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  // Closed preview: no new organisations, but invited people may still create an account (Supabase) and are joined automatically.
  const open = config.trialSignup;
  const inviteOnly = mode === 'signup' && !open && externalAuth;
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true); setErr(''); setNotice('');
    try {
      if (supabase) {
        if (mode === 'signup') {
          if (open) savePending({ organisation: f.org!, country: f.country!, name: f.name });
          const r = await supabase.auth.signUp({ email: f.email!, password: f.password!, options: { data: { full_name: f.name }, emailRedirectTo: `${location.origin}/login` } });
          if (r.error) throw r.error;
          if (r.data.session) { await reload(); nav('/'); } else setNotice(t('auth.checkEmail'));
        } else if (mode === 'login') {
          const r = await supabase.auth.signInWithPassword({ email: f.email!, password: f.password! });
          if (r.error) throw r.error;
          await reload(); nav('/');
        } else if (mode === 'forgot') {
          await supabase.auth.resetPasswordForEmail(f.email!, { redirectTo: `${location.origin}/reset` });
          setNotice(t('auth.resetSent'));
        } else {
          const r = await supabase.auth.updateUser({ password: f.password! });
          if (r.error) throw r.error;
          setNotice(t('auth.passwordUpdated')); setTimeout(() => nav('/'), 1200);
        }
      } else if (mode === 'signup') {
        const r = await request<{ token: string; tenant: { slug: string } }>('POST', '/v1/signup', { email: f.email, password: f.password, name: f.name, organisation: f.org, country: f.country });
        setSession({ token: r.token, tenant: r.tenant.slug });
        await reload(); nav(`/t/${r.tenant.slug}/dashboard`);
      } else {
        const r = await request<{ token: string; memberships: { slug: string }[] }>('POST', '/v1/auth/login', { email: f.email, password: f.password });
        setSession({ token: r.token, tenant: r.memberships[0]?.slug ?? null });
        await reload(); nav('/');
      }
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  }

  if (mode === 'signup' && !open && !externalAuth) {
    return (
      <div className="auth"><div className="card stack">
        <LangPick /><h1>{t('auth.closedTitle')}</h1><p className="muted">{t('auth.closedBody')}</p>
        <Link className="btn primary" to="/login" style={{ textAlign: 'center', textDecoration: 'none', display: 'grid', placeItems: 'center' }}>{t('auth.signin')}</Link>
      </div></div>
    );
  }

  const title = inviteOnly ? t('auth.createAccount') : mode === 'signup' ? t('auth.signup') : mode === 'forgot' ? t('auth.forgot') : mode === 'reset' ? t('auth.newPassword') : t('auth.signin');
  const pending = mode === 'signup' ? { organisation: params.get('org') ?? '', country: params.get('country') ?? 'MX', email: params.get('email') ?? '' } : null;

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <LangPick />
        <h1>{title}</h1>
        {mode === 'signup' && <p className="muted">{inviteOnly ? t('auth.inviteOnly') : t('auth.trial')}</p>}
        {mode === 'signup' && <label className="field">{t('auth.name')}<input name="name" autoComplete="name" /></label>}
        {mode === 'signup' && open && <label className="field">{t('auth.org')}<input name="org" required minLength={2} defaultValue={pending!.organisation} /></label>}
        {mode === 'signup' && open && (
          <label className="field">{t('auth.country')}
            <select name="country" defaultValue={pending!.country}>{COUNTRIES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</select>
          </label>
        )}
        {mode !== 'reset' && <label className="field">{t('auth.email')}<input name="email" type="email" required autoComplete="email" defaultValue={pending?.email} /></label>}
        {mode !== 'forgot' && (
          <label className="field">{mode === 'reset' ? t('auth.newPassword') : t('auth.password')}
            <PasswordInput name="password" required minLength={mode === 'login' ? 1 : 10} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode !== 'login' && <small>{t('auth.passwordHint')}</small>}
          </label>
        )}
        {err && <div className="banner bad" role="alert">{err}</div>}
        {notice && <div className="banner" role="status">{notice}</div>}
        <button className="btn primary" disabled={busy}>{mode === 'forgot' ? t('auth.sendReset') : mode === 'reset' ? t('auth.setPassword') : title}</button>
        {mode === 'login' && externalAuth && <Link to="/forgot">{t('auth.forgot')}</Link>}
        {(mode === 'signup' || (mode === 'login' && (open || externalAuth))) && <Link to={mode === 'signup' ? '/login' : '/signup'}>{mode === 'signup' ? t('auth.signin') : inviteOnly || !open ? t('auth.createAccount') : t('auth.signup')}</Link>}
      </form>
    </div>
  );
}

/** Signed in with an external identity but no organisation yet: create one (details may carry over from signup). */
export function Onboarding() {
  const t = useT();
  const nav = useNavigate();
  const { who, reload, signOut, config } = useApp();
  const countryName = useCountryName();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const auto = useRef(false);

  async function create(org: { organisation: string; country: string; name?: string }) {
    setBusy(true); setErr('');
    try {
      const r = await request<{ tenant: { slug: string } }>('POST', '/v1/signup', org);
      setSession({ token: null, tenant: r.tenant.slug });
      await reload(); nav('/');
    } catch (x) { setErr(errText(x)); setBusy(false); }
  }

  // Details typed at sign-up are used straight away, once the confirmed account first signs in.
  useEffect(() => {
    if (auto.current || !who || !config.trialSignup) return;
    const pending = takePending();
    if (pending) { auto.current = true; void create(pending); }
  }, [who]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void create({ organisation: f.org!, country: f.country! });
  }
  const p = peekPending();
  if (!config.trialSignup) {
    return (
      <div className="auth"><div className="card stack">
        <LangPick /><h1>{t('auth.closedTitle')}</h1><p className="muted">{who?.user?.email}</p><p className="muted">{t('auth.closedBody')}</p>
        <button type="button" className="btn" onClick={async () => { await signOut(); nav('/login'); }}>{t('nav.signout')}</button>
      </div></div>
    );
  }
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <LangPick />
        <h1>{t('auth.onboardTitle')}</h1>
        <p className="muted">{who?.user?.email}</p>
        <label className="field">{t('auth.org')}<input name="org" required minLength={2} defaultValue={p?.organisation} /></label>
        <label className="field">{t('auth.country')}
          <select name="country" defaultValue={p?.country ?? 'MX'}>{COUNTRIES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</select>
        </label>
        {err && <div className="banner bad" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{t('auth.onboardCreate')}</button>
        <button type="button" className="btn" onClick={async () => { await signOut(); nav('/login'); }}>{t('nav.signout')}</button>
      </form>
    </div>
  );
}

export { homeFor };
