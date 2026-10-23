import { PlateChip } from '@openpark/ui';
import { useState } from 'react';
import { ApiError, patch } from '../api.js';
import { pickLabel, useApp } from '../app-context.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { useI18n, useT } from '../i18n.js';

interface Slot { code: string; zone: string; level: number | null; type: string; status: string; note: string | null; plate: string | null }

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

  async function set(status: 'available' | 'out_of_service' | 'reserved') {
    if (!sel || !site) return;
    try { await patch(`/v1/slots/${sel.code}?site=${site.code}`, { status, note: note || undefined }); setSel(null); setNote(''); setErr(''); await list.reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>{t('slots.title')}</h1>
        <NativeSelect value={zone} onChange={(e) => setZone(e.target.value)} aria-label={t('common.zone')}>
          <option value="">{t('sessions.all')}</option>
          {site?.zones.map((z) => <option key={z.code} value={z.code}>{pickLabel(z.labels, locale, z.name)}</option>)}
        </NativeSelect>
      </div>
      <QueryState loading={list.loading} error={list.error} empty={!list.data?.length} />
      {!list.loading && !list.error && <div className="slotgrid">{list.data?.map((s) => (
        <Button key={s.code} variant="outline" className="slot h-auto flex-col" data-status={s.status} data-selected={sel?.code === s.code} onClick={() => setSel(s)} title={s.plate ?? s.note ?? s.status}>
          {s.code}<small>{s.level != null ? `${t('parking.level')} ${s.level} · ` : ''}{s.plate ?? typeLabel(s.type)}</small>
        </Button>
      ))}</div>}
      {sel && (
        <Card className="card stack">
          <div className="row between"><h2>{sel.code} · {typeLabel(sel.type)}{sel.level != null ? ` · ${t('parking.level')} ${sel.level}` : ''}</h2><Badge className="pill">{t(`slots.${sel.status}`)}</Badge></div>
          {sel.plate && <PlateChip plate={sel.plate} />}
          {/* Occupied is set by check-out, never by hand: its status shows as a read-only label, not a selectable option. */}
          {sel.status === 'occupied' ? (
            <Alert className="banner" role="status">{t('slots.occupiedReadonly')}</Alert>
          ) : (
            <>
              <label className="field">{t('common.status')}
                <NativeSelect value={sel.status} onChange={(e) => set(e.target.value as 'available' | 'out_of_service' | 'reserved')}>
                  <option value="available">{t('slots.operational')}</option>
                  <option value="out_of_service">{t('slots.out_of_service')}</option>
                  <option value="reserved">{t('slots.reserved')}</option>
                </NativeSelect></label>
              <label className="field">{t('slots.note')}<Input value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <div className="row"><Button variant="outline" className="btn" onClick={() => setSel(null)}>{t('common.cancel')}</Button></div>
            </>
          )}
          {err && <Alert variant="destructive" className="banner bad">{err}</Alert>}
        </Card>
      )}
    </div>
  );
}
