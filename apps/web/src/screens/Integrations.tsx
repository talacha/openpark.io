import { useState, type FormEvent } from 'react';
import { del, patch, post } from '../api.js';
import { ROLES, useApp, type Role } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errText } from '../errors.js';
import { useT } from '../i18n.js';

const EVENTS = ['session.opened', 'session.closed', 'slot.changed', 'read.needs_review', 'pass.overstay'] as const;
interface Key { id: string; name: string; prefix: string; role: Role; site: string | null; created_at: string; revoked_at: string | null }
interface Hook { id: string; url: string; events: string[]; active: boolean }

/** API keys for other systems (gate software, reports) and webhooks that tell them what happened. */
export function Integrations() {
  const t = useT();
  const { sites } = useApp();
  const keys = useApi<Key[]>('/v1/api-keys');
  const hooks = useApi<Hook[]>('/v1/webhooks');
  const [err, setErr] = useState('');
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [events, setEvents] = useState<string[]>(['session.opened', 'session.closed']);
  const [editing, setEditing] = useState<Hook | null>(null);
  const [busy, setBusy] = useState(false);
  // One request at a time: a double click must not create two keys and show only one secret.
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); try { await fn(); setErr(''); } catch (x) { setErr(errText(x)); } finally { setBusy(false); } };

  const addKey = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    return run(async () => { const r = await post<{ key: string }>('/v1/api-keys', { name: f.name, role: f.role, site: f.site || undefined }); setSecret({ label: t('integ.keyOnce'), value: r.key }); form.reset(); await keys.reload(); }); };
  const addHook = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (!events.length) { setErr(t('integ.noEvents')); return Promise.resolve(); }
    return run(async () => { const r = await post<{ secret: string }>('/v1/webhooks', { url: f.url, events }); setSecret({ label: t('integ.secretOnce'), value: r.secret }); form.reset(); await hooks.reload(); }); };
  const saveHook = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    return run(async () => { await patch(`/v1/webhooks/${editing!.id}`, { url: f.url, events: editing!.events, active: editing!.active }); setEditing(null); await hooks.reload(); }); };
  const toggle = (list: string[], ev: string) => (list.includes(ev) ? list.filter((x) => x !== ev) : [...list, ev]);

  return (
    <div className="stack">
      <h1>{t('integ.title')}</h1>
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      {secret && <Alert className="banner" role="status"><strong>{secret.label}</strong><div dir="ltr"><code>{secret.value}</code></div></Alert>}

      <section className="stack"><h2>{t('integ.keys')}</h2>
        <Card render={<form className="card row" onSubmit={addKey} />}>
          <label className="field grow">{t('units.name')}<Input name="name" required maxLength={100} /></label>
          <label className="field">{t('users.role')}<NativeSelect name="role" defaultValue="attendant">{ROLES.filter((r) => r !== 'resident').map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</NativeSelect></label>
          <label className="field">{t('units.site')}<NativeSelect name="site"><option value="">{t('integ.allSites')}</option>{sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</NativeSelect></label>
          <Button type="submit" className="btn primary" disabled={busy}>{t('integ.createKey')}</Button>
        </Card>
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('units.name')}</TableHead><TableHead>{t('integ.prefix')}</TableHead><TableHead>{t('users.role')}</TableHead><TableHead>{t('units.site')}</TableHead><TableHead>{t('common.status')}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={keys.loading} error={keys.error} empty={!keys.data?.length} table colSpan={6} />
            {!keys.loading && !keys.error && keys.data?.map((k) => (
              <TableRow key={k.id}><TableCell>{k.name}</TableCell><TableCell dir="ltr"><code>{k.prefix}…</code></TableCell><TableCell>{t(`role.${k.role}`)}</TableCell><TableCell>{k.site ?? t('integ.allSites')}</TableCell>
                <TableCell>{k.revoked_at ? <Badge className="pill warn">{t('integ.revoked')}</Badge> : <Badge className="pill ok">{t('integ.active')}</Badge>}</TableCell>
                <TableCell>{!k.revoked_at && <Button variant="destructive" className="btn danger" onClick={() => void run(async () => { await del(`/v1/api-keys/${k.id}`); await keys.reload(); })}>{t('integ.revoke')}</Button>}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table></div>
      </section>

      <section className="stack"><h2>{t('integ.hooks')}</h2>
        <Card render={<form className="card stack" onSubmit={addHook} />}>
          <label className="field">{t('integ.url')}<Input name="url" type="url" required placeholder="https://" dir="ltr" /></label>
          <fieldset className="roles"><legend>{t('integ.events')}</legend>
            {EVENTS.map((ev) => <div key={ev} className="rolebox"><Checkbox id={`ev-${ev}`} checked={events.includes(ev)} onCheckedChange={() => setEvents(toggle(events, ev))} /><label htmlFor={`ev-${ev}`}><strong dir="ltr">{ev}</strong><small>{t(`integ.ev_${ev.replace('.', '_')}`)}</small></label></div>)}
          </fieldset>
          <div><Button type="submit" className="btn primary" disabled={busy}>{t('integ.createHook')}</Button></div>
        </Card>
        {editing && (
          <Card key={editing.id} render={<form className="card stack" onSubmit={saveHook} aria-label={t('users.editing', { who: editing.url })} />}>
            <label className="field">{t('integ.url')}<Input name="url" type="url" required defaultValue={editing.url} dir="ltr" /></label>
            <fieldset className="roles"><legend>{t('integ.events')}</legend>
              {EVENTS.map((ev) => <div key={ev} className="rolebox"><Checkbox id={`ee-${ev}`} checked={editing.events.includes(ev)} onCheckedChange={() => setEditing({ ...editing, events: toggle(editing.events, ev) })} /><label htmlFor={`ee-${ev}`}><strong dir="ltr">{ev}</strong></label></div>)}
            </fieldset>
            <label className="row"><Checkbox checked={editing.active} onCheckedChange={(checked) => setEditing({ ...editing, active: checked === true })} />{t('integ.active')}</label>
            <div className="row"><Button type="submit" className="btn primary" disabled={!editing.events.length}>{t('common.save')}</Button><Button type="button" variant="outline" className="btn" onClick={() => setEditing(null)}>{t('common.cancel')}</Button></div>
          </Card>
        )}
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('integ.url')}</TableHead><TableHead>{t('integ.events')}</TableHead><TableHead>{t('common.status')}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={hooks.loading} error={hooks.error} empty={!hooks.data?.length} table colSpan={4} />
            {!hooks.loading && !hooks.error && hooks.data?.map((h) => (
              <TableRow key={h.id}><TableCell dir="ltr">{h.url}</TableCell><TableCell dir="ltr">{h.events.join(', ')}</TableCell>
                <TableCell>{h.active ? <Badge className="pill ok">{t('integ.active')}</Badge> : <Badge className="pill warn">{t('integ.paused')}</Badge>}</TableCell>
                <TableCell><div className="row"><Button variant="outline" className="btn" onClick={() => setEditing(h)}>{t('users.edit')}</Button>
                  <Button variant="destructive" className="btn danger" onClick={() => void run(async () => { await del(`/v1/webhooks/${h.id}`); await hooks.reload(); })}>{t('common.remove')}</Button></div></TableCell></TableRow>
            ))}
          </TableBody>
        </Table></div>
      </section>
    </div>
  );
}
