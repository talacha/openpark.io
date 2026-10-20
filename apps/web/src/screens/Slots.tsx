import { PlateChip } from '@openpark/ui';
import { useState } from 'react';
import { ApiError, patch } from '../api.js';
import { pickLabel, useApp } from '../app-context.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
import { useI18n, useT } from '../i18n.js';

interface Slot { code: string; zone: string; type: string; status: string; note: string | null; plate: string | null }

export function Slots() {
  const t = useT();
  const { site, me } = useApp();
  const { locale } = useI18n();
  const typeLabel = (c: string) => pickLabel(me?.tenant.slot_types.find((x) => x.code === c)?.label, locale, c);
  const [zone, setZone] = useState('');
  const [sel, setSel] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const list = useApi<Slot[]>(site ? `/v1/slots?site=${site.code}${zone ? `&zone=${zone}` : ''}` : null, [site?.code, zone]);
  useLiveEvents(() => { void list.reload(); });

  async function set(status: 'available' | 'out_of_service') {
    if (!sel || !site) return;
    try { await patch(`/v1/slots/${sel.code}?site=${site.code}`, { status, note: note || undefined }); setSel(null); setNote(''); setErr(''); await list.reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>{t('slots.title')}</h1>
        <select value={zone} onChange={(e) => setZone(e.target.value)} aria-label={t('common.zone')}>
          <option value="">{t('sessions.all')}</option>
          {site?.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}
        </select>
      </div>
      <div className="slotgrid">{list.data?.map((s) => (
        <button key={s.code} className="slot" data-status={s.status} data-selected={sel?.code === s.code} onClick={() => setSel(s)} title={s.plate ?? s.note ?? s.status}>
          {s.code}<small>{s.plate ?? typeLabel(s.type)}</small>
        </button>
      ))}</div>
      {sel && (
        <section className="card stack">
          <div className="row between"><h2>{sel.code} · {typeLabel(sel.type)}</h2><span className="pill">{t(`slots.${sel.status}`)}</span></div>
          {sel.plate && <PlateChip plate={sel.plate} />}
          {sel.status !== 'occupied' && (
            <>
              <label className="field">{t('slots.note')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <div className="row">
                {sel.status === 'out_of_service'
                  ? <button className="btn primary" onClick={() => set('available')}>{t('slots.markAvailable')}</button>
                  : <button className="btn danger" onClick={() => set('out_of_service')}>{t('slots.markOut')}</button>}
                <button className="btn" onClick={() => setSel(null)}>{t('common.cancel')}</button>
              </div>
            </>
          )}
          {err && <div className="banner bad">{err}</div>}
        </section>
      )}
    </div>
  );
}
