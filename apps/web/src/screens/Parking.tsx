import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post } from '../api.js';
import { pickLabel, useApp } from '../app-context.js';
import { useApi, useSubmitKey } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { errText } from '../errors.js';
import { useI18n, useT } from '../i18n.js';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface Zone { code: string; name: string; labels: Record<string, string>; level: number | null; slots: number }
interface SiteRow { code: string; name: string; timezone: string; address: string | null; settings: { aiThreshold?: number }; slots: number; open_sessions: number; zones: Zone[] }
interface SlotRow { code: string; zone: string; level: number | null; type: string; status: string; note: string | null; plate: string | null }

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
    const payload = { code: f.code, name: f.name, timezone: f.timezone, address: f.address || null };
    try { await post('/v1/sites', payload, siteKey.key(`POST /v1/sites ${JSON.stringify(payload)}`)); siteKey.rotate(); form.reset(); setErr(''); await sites.reload(); await reloadApp(); }
    catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1>{t('parking.title')}</h1>
      <p className="muted">{t('parking.intro')}</p>
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      {canEdit && <CommunitySettings />}
      {canEdit && (
        <Card render={<form className="card stack" onSubmit={addSite} />}>
          <h2>{t('parking.addSite')}</h2>
          <div className="row">
            <label className="field">{t('units.code')}<Input name="code" required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" dir="ltr" /></label>
            <label className="field grow">{t('units.name')}<Input name="name" required maxLength={100} /></label>
            <label className="field">{t('parking.timezone')}
              <NativeSelect name="timezone" required defaultValue={me?.tenant.country === 'MX' ? 'America/Mexico_City' : Intl.DateTimeFormat().resolvedOptions().timeZone}>{timezones(Intl.DateTimeFormat().resolvedOptions().timeZone).map((z) => <option key={z}>{z}</option>)}</NativeSelect></label>
          </div>
          <label className="field">{t('parking.address')}<Input name="address" maxLength={300} /></label>
          <div><Button type="submit" className="btn primary" disabled={busy}>{t('parking.addSite')}</Button></div>
        </Card>
      )}
      <QueryState loading={sites.loading} error={sites.error} empty={!sites.data?.length} emptyLabel={t('parking.none')} />
      {!sites.loading && !sites.error && sites.data?.map((s) => <SiteCard key={s.code} site={s} tz={tz} canEdit={canEdit} run={run} />)}
    </div>
  );
}

/** Community-level (the surfaced name for the tenant) optional details: an address and free-form notes. */
function CommunitySettings() {
  const t = useT();
  const { me, reload } = useApp();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(me!.tenant.address ?? '');
  const [notes, setNotes] = useState(me!.tenant.notes ?? '');
  const [msg, setMsg] = useState('');
  async function save() {
    try { await patch('/v1/tenant', { address, notes }); await reload(); setMsg(t('common.saved')); }
    catch (x) { setMsg(errText(x)); }
  }
  return (
    <Card render={<section className="card stack" data-community />}>
      <div className="row between">
        <h2>{t('community.settings')} <small className="muted">{me!.tenant.name}</small></h2>
        <Button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('common.hide') : t('community.edit')}</Button>
      </div>
      {open && (
        <>
          <label className="field">{t('community.address')}<Input value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} /></label>
          <label className="field">{t('community.notes')}<Textarea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></label>
          <div className="row"><Button type="button" className="btn primary" onClick={save}>{t('common.save')}</Button>{msg && <span className="muted">{msg}</span>}</div>
        </>
      )}
    </Card>
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
  async function create(k: ReturnType<typeof useSubmitKey>, fingerprint: string, make: (key: string) => Promise<unknown>, form: HTMLFormElement) {
    if (busy) return;
    setBusy(true);
    try { await refresh(async () => { await make(k.key(fingerprint)); k.rotate(); form.reset(); }); }
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
    const payload = { code: f.code, name: f.name, level: f.level === '' ? null : Number(f.level) };
    await create(zoneKey, `POST /v1/sites/${site.code}/zones ${JSON.stringify(payload)}`, (key) => post(`/v1/sites/${site.code}/zones`, payload, key), form);
  }
  async function saveZone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    await refresh(async () => { await patch(`/v1/sites/${site.code}/zones/${editZone!.code}`, { name: f.name, level: f.level === '' ? null : Number(f.level) }); setEditZone(null); });
  }
  async function addSlot(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const payload = { code: f.code, zone: f.zone, type: f.type, note: f.note || null };
    await create(slotKey, `POST /v1/slots?site=${site.code} ${JSON.stringify(payload)}`, (key) => post(`/v1/slots?site=${site.code}`, payload, key), form);
  }
  async function saveSlot(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    await refresh(async () => { await patch(`/v1/slots/${editSlot!.code}?site=${site.code}`, { zone: f.zone, type: f.type, status: editSlot!.status === 'occupied' ? undefined : f.status, note: f.note }); setEditSlot(null); });
  }

  return (
    <Card render={<section className="card stack" data-site={site.code} />}>
      <div className="row between">
        <h2>{site.name} <small className="muted" dir="ltr">{site.code}</small></h2>
        <Button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('common.hide') : t('parking.manage')}</Button>
      </div>
      <div className="muted">{t('parking.summary', { zones: site.zones.length, slots: site.slots, inside: site.open_sessions })}</div>
      {open && (
        <>
          {canEdit && (
            <form className="stack" onSubmit={save}>
              <div className="row">
                <label className="field grow">{t('units.name')}<Input name="name" required defaultValue={site.name} maxLength={100} /></label>
                <label className="field">{t('parking.timezone')}
                  <NativeSelect name="timezone" defaultValue={site.timezone}>{[...new Set([site.timezone, ...tz])].map((z) => <option key={z}>{z}</option>)}</NativeSelect></label>
                <label className="field">{t('parking.threshold')}
                  <Input name="aiThreshold" type="number" min={0.5} max={1} step={0.01} defaultValue={site.settings.aiThreshold ?? 0.95} dir="ltr" /></label>
              </div>
              <label className="field">{t('parking.address')}<Input name="address" defaultValue={site.address ?? ''} maxLength={300} /></label>
              <div className="row">
                <Button type="submit" className="btn primary">{t('common.save')}</Button>
                <Button type="button" className="btn danger" disabled={site.open_sessions > 0} title={site.open_sessions ? t('parking.retireBlocked') : undefined}
                  onClick={() => { if (confirm(t('parking.retireConfirm', { name: site.name }))) void run(() => del(`/v1/sites/${site.code}`)); }}>{t('parking.retire')}</Button>
              </div>
            </form>
          )}

          <h3>{t('parking.zones')}</h3>
          <div className="tablewrap"><Table>
            <TableHeader><TableRow><TableHead>{t('units.code')}</TableHead><TableHead>{t('units.name')}</TableHead><TableHead>{t('parking.level')}</TableHead><TableHead className="num">{t('parking.slots')}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{site.zones.map((z) => (
              <TableRow key={z.code}>
                <TableCell dir="ltr">{z.code}</TableCell><TableCell>{pickLabel(z.labels, locale, z.name)}</TableCell><TableCell className="num">{z.level ?? '–'}</TableCell><TableCell className="num">{z.slots}</TableCell>
                <TableCell>{canEdit && <div className="row">
                  <Button type="button" className="btn" onClick={() => setEditZone(z)}>{t('users.edit')}</Button>
                  <Button type="button" className="btn danger" disabled={z.slots > 0} title={z.slots ? t('parking.zoneNotEmpty') : undefined} onClick={() => void refresh(() => del(`/v1/sites/${site.code}/zones/${z.code}`))}>{t('common.remove')}</Button>
                </div>}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table></div>
          {editZone && (
            <Card key={editZone.code} render={<form className="card row" onSubmit={saveZone} aria-label={t('users.editing', { who: editZone.code })} />}>
              <label className="field grow">{t('units.name')}<Input name="name" required defaultValue={editZone.name} maxLength={100} /></label>
              <label className="field">{t('parking.level')}<Input name="level" type="number" step={1} min={-20} max={200} defaultValue={editZone.level ?? ''} dir="ltr" /></label>
              <Button type="submit" className="btn primary">{t('common.save')}</Button><Button type="button" className="btn" onClick={() => setEditZone(null)}>{t('common.cancel')}</Button>
            </Card>
          )}
          {canEdit && (
            <form className="row" onSubmit={addZone}>
              <label className="field">{t('units.code')}<Input name="code" required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" dir="ltr" /></label>
              <label className="field grow">{t('units.name')}<Input name="name" required maxLength={100} /></label>
              <label className="field">{t('parking.level')}<Input name="level" type="number" step={1} min={-20} max={200} dir="ltr" /></label>
              <Button type="submit" className="btn" disabled={busy}>{t('parking.addZone')}</Button>
            </form>
          )}

          <div className="row between"><h3>{t('parking.slots')}</h3>
            <NativeSelect value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} aria-label={t('common.zone')}>
              <option value="">{t('sessions.all')}</option>{site.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}</NativeSelect></div>
          <div className="tablewrap"><Table>
            <TableHeader><TableRow><TableHead>{t('units.code')}</TableHead><TableHead>{t('common.zone')}</TableHead><TableHead>{t('parking.level')}</TableHead><TableHead>{t('parking.type')}</TableHead><TableHead>{t('common.status')}</TableHead><TableHead>{t('slots.note')}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              <QueryState loading={slots.loading} error={slots.error} empty={!shown.length} table colSpan={7} />
              {!slots.loading && !slots.error && shown.map((x) => (
                <TableRow key={x.code}>
                  <TableCell dir="ltr">{x.code}</TableCell><TableCell dir="ltr">{x.zone}</TableCell><TableCell className="num">{x.level ?? '–'}</TableCell><TableCell>{typeLabel(x.type)}</TableCell><TableCell>{t(`slots.${x.status}`)}{x.plate ? ` · ${x.plate}` : ''}</TableCell><TableCell>{x.note ?? '–'}</TableCell>
                  <TableCell>{canEdit && <div className="row">
                    <Button type="button" className="btn" onClick={() => setEditSlot(x)}>{t('users.edit')}</Button>
                    <Button type="button" className="btn danger" disabled={x.status === 'occupied'} onClick={() => void refresh(() => del(`/v1/slots/${x.code}?site=${site.code}`))}>{t('common.remove')}</Button>
                  </div>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
          {editSlot && (
            <Card key={editSlot.code} render={<form className="card row" onSubmit={saveSlot} aria-label={t('users.editing', { who: editSlot.code })} />}>
              <label className="field">{t('common.zone')}<NativeSelect name="zone" defaultValue={editSlot.zone}>{site.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}</NativeSelect></label>
              <label className="field">{t('parking.type')}<NativeSelect name="type" defaultValue={editSlot.type}>{types.map((x) => <option key={x.code} value={x.code}>{pickLabel(x.label, locale, x.code)}</option>)}</NativeSelect></label>
              <label className="field">{t('common.status')}<NativeSelect name="status" defaultValue={editSlot.status} disabled={editSlot.status === 'occupied'}>
                {editSlot.status === 'occupied' && <option value="occupied">{t('slots.occupied')}</option>}{STATUSES.map((x) => <option key={x} value={x}>{t(`slots.${x}`)}</option>)}</NativeSelect></label>
              <label className="field grow">{t('slots.note')}<Input name="note" defaultValue={editSlot.note ?? ''} maxLength={300} /></label>
              <Button type="submit" className="btn primary">{t('common.save')}</Button><Button type="button" className="btn" onClick={() => setEditSlot(null)}>{t('common.cancel')}</Button>
            </Card>
          )}
          {canEdit && (site.zones.length ? (
            <form className="row" onSubmit={addSlot}>
              <label className="field">{t('units.code')}<Input name="code" required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*" dir="ltr" /></label>
              <label className="field">{t('common.zone')}<NativeSelect name="zone" required>{site.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}</NativeSelect></label>
              <label className="field">{t('parking.type')}<NativeSelect name="type" required>{types.map((x) => <option key={x.code} value={x.code}>{pickLabel(x.label, locale, x.code)}</option>)}</NativeSelect></label>
              <label className="field grow">{t('slots.note')}<Input name="note" maxLength={300} /></label>
              <Button type="submit" className="btn" disabled={busy}>{t('parking.addSlot')}</Button>
            </form>
          ) : <Alert className="banner warn">{t('parking.needZone')}</Alert>)}
          <div className="muted">{t('parking.bulk')} <Link to="../inventory">{t('nav.inventory')}</Link></div>
        </>
      )}
    </Card>
  );
}
