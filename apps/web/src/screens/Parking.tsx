import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post } from '../api.js';
import { pickLabel, useApp } from '../app-context.js';
import { useApi, useSubmitKey } from '../components/hooks.js';
import { errText } from '../errors.js';
import { useI18n, useT } from '../i18n.js';

interface Zone { code: string; name: string; labels: Record<string, string>; level: number | null; slots: number }
interface SiteRow { code: string; name: string; timezone: string; address: string | null; settings: { aiThreshold?: number }; slots: number; open_sessions: number; zones: Zone[] }
interface SlotRow { code: string; zone: string; type: string; status: string; note: string | null; plate: string | null }

const STATUSES = ['available', 'reserved', 'out_of_service'] as const;

function timezones(current?: string): string[] {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  const list = all.length ? all : ['UTC', 'America/Mexico_City', 'America/New_York', 'America/Sao_Paulo', 'Europe/Madrid'];
  return current && !list.includes(current) ? [current, ...list] : list;
}

/** Sites, zones and slots: the parking facilities of a property, each with create / edit / retire. */
export function Parking() {
  const t = useT();
  const { me, reload: reloadApp } = useApp();
  const sites = useApi<SiteRow[]>('/v1/sites');
  const [err, setErr] = useState('');
  const canEdit = !!me && (me.superadmin || me.roles.includes('admin'));
  const tz = useMemo(() => timezones(), []);
  const [busy, setBusy] = useState(false);
  const siteKey = useSubmitKey();

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); setErr(''); await sites.reload(); await reloadApp(); } catch (x) { setErr(errText(x)); }
  }

  async function addSite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return; // block a double submit; the pending button is also disabled
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    // Submission-scoped Idempotency-Key: reused on every retry so a lost-response retry replays the original create;
    // rotated only after a success so the next site is a distinct request.
    try { await post('/v1/sites', { code: f.code, name: f.name, timezone: f.timezone, address: f.address || null }, siteKey.key()); siteKey.rotate(); form.reset(); setErr(''); await sites.reload(); await reloadApp(); }
    catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1>{t('parking.title')}</h1>
      <p className="muted">{t('parking.intro')}</p>
      {err && <div className="banner bad" role="alert">{err}</div>}
      {canEdit && (
        <form className="card stack" onSubmit={addSite}>
          <h2>{t('parking.addSite')}</h2>
          <div className="row">
            <label className="field">{t('units.code')}<input name="code" required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" dir="ltr" /></label>
            <label className="field grow">{t('units.name')}<input name="name" required maxLength={100} /></label>
            <label className="field">{t('parking.timezone')}
              <select name="timezone" required defaultValue={me?.tenant.country === 'MX' ? 'America/Mexico_City' : Intl.DateTimeFormat().resolvedOptions().timeZone}>{timezones(Intl.DateTimeFormat().resolvedOptions().timeZone).map((z) => <option key={z}>{z}</option>)}</select></label>
          </div>
          <label className="field">{t('parking.address')}<input name="address" maxLength={300} /></label>
          <div><button className="btn primary" disabled={busy}>{t('parking.addSite')}</button></div>
        </form>
      )}
      {sites.data?.map((s) => <SiteCard key={s.code} site={s} tz={tz} canEdit={canEdit} run={run} />)}
      {sites.data && !sites.data.length && <div className="banner">{t('parking.none')}</div>}
    </div>
  );
}

function SiteCard({ site, tz, canEdit, run }: { site: SiteRow; tz: string[]; canEdit: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const t = useT();
  const { locale } = useI18n();
  const { me } = useApp();
  const slots = useApi<SlotRow[]>(`/v1/slots?site=${site.code}`, [site.slots]);
  const [open, setOpen] = useState(false);
  const [zoneFilter, setZoneFilter] = useState('');
  const [editZone, setEditZone] = useState<Zone | null>(null);
  const [editSlot, setEditSlot] = useState<SlotRow | null>(null);
  const types = me?.tenant.slot_types ?? [];
  const typeLabel = (c: string) => pickLabel(types.find((x) => x.code === c)?.label, locale, c);
  const refresh = async (fn: () => Promise<unknown>) => run(async () => { await fn(); await slots.reload(); });
  const [busy, setBusy] = useState(false);
  const zoneKey = useSubmitKey();
  const slotKey = useSubmitKey();
  const shown = (slots.data ?? []).filter((x) => !zoneFilter || x.zone === zoneFilter);
  // Create with a submission-scoped Idempotency-Key reused on every retry (so a lost-response retry replays the
  // original create), rotated only after a success. A pending flag blocks double submits. `refresh`/`run` surfaces
  // any error; on error the key and form are left intact so the attendant can retry the same submission safely.
  async function create(k: ReturnType<typeof useSubmitKey>, make: (key: string) => Promise<unknown>, form: HTMLFormElement) {
    if (busy) return;
    setBusy(true);
    try { await refresh(async () => { await make(k.key()); k.rotate(); form.reset(); }); }
    finally { setBusy(false); }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    await run(() => patch(`/v1/sites/${site.code}`, { name: f.name, timezone: f.timezone, address: f.address || null, aiThreshold: Number(f.aiThreshold) }));
  }
  async function addZone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    await create(zoneKey, (key) => post(`/v1/sites/${site.code}/zones`, { code: f.code, name: f.name, level: f.level === '' ? null : Number(f.level) }, key), form);
  }
  async function saveZone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    await refresh(async () => { await patch(`/v1/sites/${site.code}/zones/${editZone!.code}`, { name: f.name, level: f.level === '' ? null : Number(f.level) }); setEditZone(null); });
  }
  async function addSlot(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    await create(slotKey, (key) => post(`/v1/slots?site=${site.code}`, { code: f.code, zone: f.zone, type: f.type, note: f.note || null }, key), form);
  }
  async function saveSlot(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    await refresh(async () => { await patch(`/v1/slots/${editSlot!.code}?site=${site.code}`, { zone: f.zone, type: f.type, status: editSlot!.status === 'occupied' ? undefined : f.status, note: f.note }); setEditSlot(null); });
  }

  return (
    <section className="card stack" data-site={site.code}>
      <div className="row between">
        <h2>{site.name} <small className="muted" dir="ltr">{site.code}</small></h2>
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('common.hide') : t('parking.manage')}</button>
      </div>
      <div className="muted">{t('parking.summary', { zones: site.zones.length, slots: site.slots, inside: site.open_sessions })}</div>
      {open && (
        <>
          {canEdit && (
            <form className="stack" onSubmit={save}>
              <div className="row">
                <label className="field grow">{t('units.name')}<input name="name" required defaultValue={site.name} maxLength={100} /></label>
                <label className="field">{t('parking.timezone')}
                  <select name="timezone" defaultValue={site.timezone}>{[...new Set([site.timezone, ...tz])].map((z) => <option key={z}>{z}</option>)}</select></label>
                <label className="field">{t('parking.threshold')}
                  <input name="aiThreshold" type="number" min={0.5} max={1} step={0.01} defaultValue={site.settings.aiThreshold ?? 0.95} dir="ltr" /></label>
              </div>
              <label className="field">{t('parking.address')}<input name="address" defaultValue={site.address ?? ''} maxLength={300} /></label>
              <div className="row">
                <button className="btn primary">{t('common.save')}</button>
                <button type="button" className="btn danger" disabled={site.open_sessions > 0} title={site.open_sessions ? t('parking.retireBlocked') : undefined}
                  onClick={() => { if (confirm(t('parking.retireConfirm', { name: site.name }))) void run(() => del(`/v1/sites/${site.code}`)); }}>{t('parking.retire')}</button>
              </div>
            </form>
          )}

          <h3>{t('parking.zones')}</h3>
          <div className="tablewrap"><table>
            <thead><tr><th>{t('units.code')}</th><th>{t('units.name')}</th><th>{t('parking.level')}</th><th className="num">{t('parking.slots')}</th><th /></tr></thead>
            <tbody>{site.zones.map((z) => (
              <tr key={z.code}>
                <td dir="ltr">{z.code}</td><td>{pickLabel(z.labels, locale, z.name)}</td><td className="num">{z.level ?? '–'}</td><td className="num">{z.slots}</td>
                <td>{canEdit && <div className="row">
                  <button className="btn" onClick={() => setEditZone(z)}>{t('users.edit')}</button>
                  <button className="btn danger" disabled={z.slots > 0} title={z.slots ? t('parking.zoneNotEmpty') : undefined} onClick={() => void refresh(() => del(`/v1/sites/${site.code}/zones/${z.code}`))}>{t('common.remove')}</button>
                </div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {editZone && (
            <form key={editZone.code} className="card row" onSubmit={saveZone} aria-label={t('users.editing', { who: editZone.code })}>
              <label className="field grow">{t('units.name')}<input name="name" required defaultValue={editZone.name} maxLength={100} /></label>
              <label className="field">{t('parking.level')}<input name="level" type="number" step={1} min={-20} max={200} defaultValue={editZone.level ?? ''} dir="ltr" /></label>
              <button className="btn primary">{t('common.save')}</button><button type="button" className="btn" onClick={() => setEditZone(null)}>{t('common.cancel')}</button>
            </form>
          )}
          {canEdit && (
            <form className="row" onSubmit={addZone}>
              <label className="field">{t('units.code')}<input name="code" required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" dir="ltr" /></label>
              <label className="field grow">{t('units.name')}<input name="name" required maxLength={100} /></label>
              <label className="field">{t('parking.level')}<input name="level" type="number" step={1} min={-20} max={200} dir="ltr" /></label>
              <button className="btn" disabled={busy}>{t('parking.addZone')}</button>
            </form>
          )}

          <div className="row between"><h3>{t('parking.slots')}</h3>
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} aria-label={t('common.zone')}>
              <option value="">{t('sessions.all')}</option>{site.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}</select></div>
          <div className="tablewrap"><table>
            <thead><tr><th>{t('units.code')}</th><th>{t('common.zone')}</th><th>{t('parking.type')}</th><th>{t('common.status')}</th><th>{t('slots.note')}</th><th /></tr></thead>
            <tbody>{shown.map((x) => (
              <tr key={x.code}>
                <td dir="ltr">{x.code}</td><td dir="ltr">{x.zone}</td><td>{typeLabel(x.type)}</td><td>{t(`slots.${x.status}`)}{x.plate ? ` · ${x.plate}` : ''}</td><td>{x.note ?? '–'}</td>
                <td>{canEdit && <div className="row">
                  <button className="btn" onClick={() => setEditSlot(x)}>{t('users.edit')}</button>
                  <button className="btn danger" disabled={x.status === 'occupied'} onClick={() => void refresh(() => del(`/v1/slots/${x.code}?site=${site.code}`))}>{t('common.remove')}</button>
                </div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {editSlot && (
            <form key={editSlot.code} className="card row" onSubmit={saveSlot} aria-label={t('users.editing', { who: editSlot.code })}>
              <label className="field">{t('common.zone')}<select name="zone" defaultValue={editSlot.zone}>{site.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}</select></label>
              <label className="field">{t('parking.type')}<select name="type" defaultValue={editSlot.type}>{types.map((x) => <option key={x.code} value={x.code}>{pickLabel(x.label, locale, x.code)}</option>)}</select></label>
              <label className="field">{t('common.status')}<select name="status" defaultValue={editSlot.status} disabled={editSlot.status === 'occupied'}>
                {editSlot.status === 'occupied' && <option value="occupied">{t('slots.occupied')}</option>}{STATUSES.map((x) => <option key={x} value={x}>{t(`slots.${x}`)}</option>)}</select></label>
              <label className="field grow">{t('slots.note')}<input name="note" defaultValue={editSlot.note ?? ''} maxLength={300} /></label>
              <button className="btn primary">{t('common.save')}</button><button type="button" className="btn" onClick={() => setEditSlot(null)}>{t('common.cancel')}</button>
            </form>
          )}
          {canEdit && (site.zones.length ? (
            <form className="row" onSubmit={addSlot}>
              <label className="field">{t('units.code')}<input name="code" required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*" dir="ltr" /></label>
              <label className="field">{t('common.zone')}<select name="zone" required>{site.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}</select></label>
              <label className="field">{t('parking.type')}<select name="type" required>{types.map((x) => <option key={x.code} value={x.code}>{pickLabel(x.label, locale, x.code)}</option>)}</select></label>
              <label className="field grow">{t('slots.note')}<input name="note" maxLength={300} /></label>
              <button className="btn" disabled={busy}>{t('parking.addSlot')}</button>
            </form>
          ) : <div className="banner warn">{t('parking.needZone')}</div>)}
          <div className="muted">{t('parking.bulk')} <Link to="../inventory">{t('nav.inventory')}</Link></div>
        </>
      )}
    </section>
  );
}
