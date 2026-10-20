import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../app-context.js';
import { LOCALES, NAMES, useI18n, useT } from '../i18n.js';
import { SyncBadge } from './SyncBadge.js';

export function AdminShell() {
  const { me, who, sites, site, setSiteCode, signOut, can, switchTenant } = useApp();
  const { locale, setLocale } = useI18n();
  const t = useT();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const base = `/t/${me!.tenant.slug}`;
  const link = (to: string, label: string) => <NavLink className="nav" to={`${base}/${to}`} onClick={() => setOpen(false)}>{label}</NavLink>;
  return (
    <div className="shell" data-open={open}>
      <aside className="side">
        <div className="brand"><img src="/icon.svg" alt="" width="24" height="24" />{t('app.name')}</div>
        <div className="muted" style={{ fontSize: '0.85rem' }}>{me!.tenant.name}</div>
        {(who?.memberships.length ?? 0) > 1 && (
          <select aria-label={t('nav.tenant')} value={me!.tenant.slug} onChange={async (e) => { await switchTenant(e.target.value); nav('/'); }}>
            {who!.memberships.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
          </select>
        )}
        {sites.length > 1 && (
          <select aria-label={t('common.site')} value={site?.code} onChange={(e) => setSiteCode(e.target.value)}>
            {sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        )}
        <nav>
          {link('dashboard', t('nav.dashboard'))}
          {link('sessions', t('nav.sessions'))}
          {link('slots', t('nav.slots'))}
          {can('override') && <>
            {link('inventory', t('nav.inventory'))}
            {link('rates', t('nav.rates'))}
            {link('ai', t('nav.ai'))}
            {link('locale', t('nav.locale'))}
          </>}
          {can('admin') && link('passes', t('nav.passes'))}
          {can('override') && <>{link('units', t('nav.units'))}{link('users', t('nav.users'))}</>}
          {link('queue', t('nav.queue'))}
        </nav>
        <div style={{ flex: 1 }} />
        <SyncBadge />
        {who?.superadmin && <button className="btn" onClick={() => nav('/platform')}>{t('nav.platform')}</button>}
        <button className="btn" onClick={() => nav(`${base}/a`)}>{t('nav.attendant')}</button>
        <select aria-label="Language" value={locale} onChange={(e) => setLocale(e.target.value)}>
          {[...LOCALES, 'en-XA' as const].map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}
        </select>
        <button className="btn" onClick={async () => { await signOut(); nav('/login'); }}>{t('nav.signout')}</button>
      </aside>
      <div>
        <div className="topbar"><button className="btn" aria-label="Menu" onClick={() => setOpen(!open)}>☰</button><strong>{t('app.name')}</strong></div>
        <main className="main"><Outlet /></main>
      </div>
    </div>
  );
}

export function AttendantShell() {
  const { me, can, site } = useApp();
  const t = useT();
  const base = `/t/${me!.tenant.slug}/a`;
  return (
    <>
      <div className="att" style={{ paddingBlockEnd: 0 }}>
        <div className="row between">
          <strong>{site?.name ?? t('app.name')}</strong>
          <span className="row"><SyncBadge />{can('admin') && <NavLink to={`/t/${me!.tenant.slug}/dashboard`}>{t('nav.admin')}</NavLink>}</span>
        </div>
      </div>
      <Outlet />
      <nav className="tabbar">
        <NavLink end to={base}>{t('att.home')}</NavLink>
        <NavLink to={`${base}/checkin`}>{t('att.checkin')}</NavLink>
        <NavLink to={`${base}/checkout`}>{t('att.checkout')}</NavLink>
      </nav>
    </>
  );
}

/** Residents get a deliberately small app: their unit's guest passes and nothing else. */
export function ResidentShell() {
  const { me, signOut } = useApp();
  const t = useT();
  const { locale, setLocale } = useI18n();
  const nav = useNavigate();
  return (
    <>
      <div className="att" style={{ paddingBlockEnd: 0 }}>
        <div className="row between">
          <strong>{me!.tenant.name}</strong>
          <span className="row">
            <select aria-label={t('auth.language')} value={locale} onChange={(e) => setLocale(e.target.value)}>{[...LOCALES].map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}</select>
            <button className="btn" onClick={async () => { await signOut(); nav('/login'); }}>{t('nav.signout')}</button>
          </span>
        </div>
      </div>
      <Outlet />
    </>
  );
}
