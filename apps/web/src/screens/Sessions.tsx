import { PlateChip } from '@openpark/ui';
import { useState } from 'react';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { PlateInput } from '../components/PlateInput.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormat, useT } from '../i18n.js';
import { eventLabel } from '../labels.js';

interface Row { id: string; status: 'open' | 'closed' | 'void'; plate: string; slot: string | null; zone: string | null; in_at: string; out_at: string | null; minutes: number; fee: number | null; in_by: string | null; out_by: string | null }
interface Ev { id: number; type: string; server_at: string; device_at: string | null; actor: string | null; payload: Record<string, unknown> }

export function Sessions() {
  const t = useT();
  const { site, me } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const [status, setStatus] = useState('');
  const [plate, setPlate] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const q = `/v1/sessions?site=${site?.code ?? ''}&limit=100${status ? `&status=${status}` : ''}${plate ? `&plate=${encodeURIComponent(plate)}` : ''}`;
  const list = useApi<{ total: number; items: Row[] }>(site ? q : null, [q]);
  const events = useApi<Ev[]>(sel ? `/v1/sessions/${sel}/events` : null, [sel]);

  return (
    <div className="stack">
      <h1>{t('sessions.title')}</h1>
      <div className="row">
        <label className="field grow" aria-label={t('sessions.plate')}><PlateInput placeholder={t('sessions.plate')} value={plate} onChange={setPlate} /></label>
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('sessions.all')}</option>
          <option value="open">{t('sessions.open')}</option><option value="closed">{t('sessions.closed')}</option><option value="void">{t('sessions.void')}</option>
        </NativeSelect>
        <span className="muted">{list.data && t('sessions.count', { count: list.data.total })}</span>
      </div>
      <div className="tablewrap"><Table>
        <TableHeader><TableRow><TableHead>{t('sessions.plate')}</TableHead><TableHead>{t('att.slot')}</TableHead><TableHead>{t('sessions.in')}</TableHead><TableHead>{t('sessions.out')}</TableHead><TableHead>{t('sessions.by')}</TableHead><TableHead>{t('sessions.duration')}</TableHead><TableHead>{t('sessions.fee')}</TableHead></TableRow></TableHeader>
        <TableBody>
          {list.loading && <TableRow><TableCell colSpan={7}><span role="status">{t('common.loading')}</span></TableCell></TableRow>}
          {list.error && <TableRow><TableCell colSpan={7}><span role="alert">{list.error}</span></TableCell></TableRow>}
          {!list.loading && !list.error && list.data?.items.length === 0 && <TableRow><TableCell colSpan={7}>{t('sessions.count', { count: 0 })}</TableCell></TableRow>}
          {!list.loading && !list.error && list.data?.items.map((r) => (
            <TableRow key={r.id} className="click" onClick={() => setSel(r.id === sel ? null : r.id)} aria-selected={r.id === sel}>
              <TableCell><Button type="button" variant="ghost" aria-label={`${t('sessions.timeline')}: ${r.plate}`} aria-expanded={r.id === sel} aria-controls={`session-events-${r.id}`} onClick={(e) => { e.stopPropagation(); setSel(r.id === sel ? null : r.id); }}><PlateChip plate={r.plate} /></Button></TableCell>
              <TableCell>{r.slot}</TableCell><TableCell>{fmt.dateTime(r.in_at)}</TableCell><TableCell>{r.out_at ? fmt.dateTime(r.out_at) : <Badge className="pill info">{t('sessions.open')}</Badge>}</TableCell>
              <TableCell>{r.in_by}{r.out_by && r.out_by !== r.in_by ? ` → ${r.out_by}` : ''}</TableCell><TableCell>{t('sessions.minutes', { count: r.minutes })}</TableCell>
              <TableCell className="num">{r.fee != null ? fmt.money(r.fee) : '–'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></div>
      {sel && (
        <Card className="card" id={`session-events-${sel}`}>
          <h2>{t('sessions.timeline')}</h2>
          {events.loading && <p role="status">{t('common.loading')}</p>}
          {events.error && <Alert variant="destructive" className="banner bad" role="alert">{events.error}</Alert>}
          {!events.loading && !events.error && events.data?.length === 0 && <p className="muted">{t('common.none')}</p>}
          {!events.loading && !events.error && <ol className="timeline">{events.data?.map((e) => (
            <li key={e.id}>
              <strong>{eventLabel(t, e.type)}</strong> <span className="muted">{fmt.dateTime(e.server_at)} · {e.actor ?? 'api'}</span>
              <div className="muted" style={{ fontSize: '0.85rem' }}>{Object.entries(e.payload).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>
            </li>
          ))}</ol>}
        </Card>
      )}
    </div>
  );
}
