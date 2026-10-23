import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError, post } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi, useSubmitKey } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
  const [busy, setBusy] = useState(false);
  const createKey = useSubmitKey();

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return; // block a double submit; the button is disabled while pending too
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const payload = { organisation: f.org, country: f.country, ownerEmail: f.owner };
    setBusy(true);
    // The submission-scoped Idempotency-Key is reused on every retry so a lost-response retry replays the original
    // create (one organisation, one owner) instead of provisioning a second auto-suffixed tenant. It rotates only
    // after a success, so the next organisation is a distinct request.
    try {
      const r = await post<{ slug: string; ownerEmail: string; temporaryPassword?: string; invited?: boolean }>('/v1/platform/tenants', payload, createKey.key(`POST /v1/platform/tenants ${JSON.stringify(payload)}`));
      createKey.rotate();
      setNote(`${t('platform.created')} ${r.temporaryPassword ? t('users.tempPassword', { password: r.temporaryPassword }) : t('platform.ownerInvited', { email: r.ownerEmail })}`);
      setErr(''); form.reset(); await tenants.reload();
    } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); }
    finally { setBusy(false); }
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
        <Card render={<form className="card row" onSubmit={create} />}>
          <label className="field grow">{t('auth.org')}<Input name="org" required minLength={2} /></label>
          <label className="field">{t('auth.country')}<NativeSelect name="country" defaultValue="MX">{['MX', 'US', 'BR', 'ES', 'FR', 'DE'].map((c) => <option key={c}>{c}</option>)}</NativeSelect></label>
          <label className="field grow">{t('platform.ownerEmail')}<Input name="owner" type="email" required dir="ltr" /></label>
          <Button className="btn primary" disabled={busy}>{t('platform.create')}</Button>
        </Card>
        {note && <Alert className="banner" role="status">{note}</Alert>}
        {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('auth.org')}</TableHead><TableHead>{t('auth.country')}</TableHead><TableHead className="num">{t('platform.members')}</TableHead><TableHead className="num">{t('platform.sites')}</TableHead><TableHead className="num">{t('platform.open')}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={tenants.loading} error={tenants.error} empty={!tenants.data?.length} table colSpan={6} />
            {!tenants.loading && !tenants.error && tenants.data?.map((x) => (
              <TableRow key={x.slug}>
                <TableCell><strong>{x.name}</strong><br /><span className="muted">{x.slug} · {fmt.dateTime(x.created_at)}</span></TableCell>
                <TableCell>{x.country}</TableCell><TableCell className="num">{x.members}</TableCell><TableCell className="num">{x.sites}</TableCell><TableCell className="num">{x.open_sessions}</TableCell>
                <TableCell>
                  <span className="row">
                    {x.suspended_at ? <><Badge className="pill bad" title={x.suspended_reason ?? ''}>{t('platform.suspended')}</Badge><Button variant="outline" className="btn" onClick={() => resume(x.slug)}>{t('platform.resume')}</Button></>
                      : <Button variant="destructive" className="btn danger" onClick={() => suspend(x.slug)}>{t('platform.suspend')}</Button>}
                    <Button className="btn primary" onClick={() => enter(x.slug)}>{t('platform.enter')}</Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table></div>
      </div>
    </div>
  );
}
