import { useState, type FormEvent } from 'react';
import { del, patch, post } from '../api.js';
import { ROLES, useApp, type Role } from '../app-context.js';
import { useApi } from '../components/hooks.js';
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
      {err && <div className="banner bad" role="alert">{err}</div>}
      {secret && <div className="banner" role="status"><strong>{secret.label}</strong><div dir="ltr"><code>{secret.value}</code></div></div>}

      <section className="stack"><h2>{t('integ.keys')}</h2>
        <form className="card row" onSubmit={addKey}>
          <label className="field grow">{t('units.name')}<input name="name" required maxLength={100} /></label>
          <label className="field">{t('users.role')}<select name="role" defaultValue="attendant">{ROLES.filter((r) => r !== 'resident').map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></label>
          <label className="field">{t('units.site')}<select name="site"><option value="">{t('integ.allSites')}</option>{sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
          <button className="btn primary" disabled={busy}>{t('integ.createKey')}</button>
        </form>
        <div className="tablewrap"><table>
          <thead><tr><th>{t('units.name')}</th><th>{t('integ.prefix')}</th><th>{t('users.role')}</th><th>{t('units.site')}</th><th>{t('common.status')}</th><th /></tr></thead>
          <tbody>{keys.data?.map((k) => (
            <tr key={k.id}><td>{k.name}</td><td dir="ltr"><code>{k.prefix}…</code></td><td>{t(`role.${k.role}`)}</td><td>{k.site ?? t('integ.allSites')}</td>
              <td>{k.revoked_at ? <span className="pill warn">{t('integ.revoked')}</span> : <span className="pill ok">{t('integ.active')}</span>}</td>
              <td>{!k.revoked_at && <button className="btn danger" onClick={() => void run(async () => { await del(`/v1/api-keys/${k.id}`); await keys.reload(); })}>{t('integ.revoke')}</button>}</td></tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="stack"><h2>{t('integ.hooks')}</h2>
        <form className="card stack" onSubmit={addHook}>
          <label className="field">{t('integ.url')}<input name="url" type="url" required placeholder="https://" dir="ltr" /></label>
          <fieldset className="roles"><legend>{t('integ.events')}</legend>
            {EVENTS.map((ev) => <div key={ev} className="rolebox"><input id={`ev-${ev}`} type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(toggle(events, ev))} /><label htmlFor={`ev-${ev}`}><strong dir="ltr">{ev}</strong><small>{t(`integ.ev_${ev.replace('.', '_')}`)}</small></label></div>)}
          </fieldset>
          <div><button className="btn primary" disabled={busy}>{t('integ.createHook')}</button></div>
        </form>
        {editing && (
          <form key={editing.id} className="card stack" onSubmit={saveHook} aria-label={t('users.editing', { who: editing.url })}>
            <label className="field">{t('integ.url')}<input name="url" type="url" required defaultValue={editing.url} dir="ltr" /></label>
            <fieldset className="roles"><legend>{t('integ.events')}</legend>
              {EVENTS.map((ev) => <div key={ev} className="rolebox"><input id={`ee-${ev}`} type="checkbox" checked={editing.events.includes(ev)} onChange={() => setEditing({ ...editing, events: toggle(editing.events, ev) })} /><label htmlFor={`ee-${ev}`}><strong dir="ltr">{ev}</strong></label></div>)}
            </fieldset>
            <label className="row"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />{t('integ.active')}</label>
            <div className="row"><button className="btn primary" disabled={!editing.events.length}>{t('common.save')}</button><button type="button" className="btn" onClick={() => setEditing(null)}>{t('common.cancel')}</button></div>
          </form>
        )}
        <div className="tablewrap"><table>
          <thead><tr><th>{t('integ.url')}</th><th>{t('integ.events')}</th><th>{t('common.status')}</th><th /></tr></thead>
          <tbody>{hooks.data?.map((h) => (
            <tr key={h.id}><td dir="ltr">{h.url}</td><td dir="ltr">{h.events.join(', ')}</td>
              <td>{h.active ? <span className="pill ok">{t('integ.active')}</span> : <span className="pill warn">{t('integ.paused')}</span>}</td>
              <td><div className="row"><button className="btn" onClick={() => setEditing(h)}>{t('users.edit')}</button>
                <button className="btn danger" onClick={() => void run(async () => { await del(`/v1/webhooks/${h.id}`); await hooks.reload(); })}>{t('common.remove')}</button></div></td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </div>
  );
}
