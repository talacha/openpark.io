import { PlateChip } from '@openpark/ui';
import { useState } from 'react';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
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
        <input placeholder={t('sessions.plate')} value={plate} onChange={(e) => setPlate(e.target.value)} aria-label={t('sessions.plate')} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('sessions.all')}</option>
          <option value="open">{t('sessions.open')}</option><option value="closed">{t('sessions.closed')}</option><option value="void">{t('sessions.void')}</option>
        </select>
        <span className="muted">{list.data && t('sessions.count', { count: list.data.total })}</span>
      </div>
      <div className="tablewrap"><table>
        <thead><tr><th>{t('sessions.plate')}</th><th>{t('att.slot')}</th><th>{t('sessions.in')}</th><th>{t('sessions.out')}</th><th>{t('sessions.by')}</th><th>{t('sessions.duration')}</th><th>{t('sessions.fee')}</th></tr></thead>
        <tbody>{list.data?.items.map((r) => (
          <tr key={r.id} className="click" onClick={() => setSel(r.id === sel ? null : r.id)} aria-selected={r.id === sel}>
            <td><PlateChip plate={r.plate} /></td><td>{r.slot}</td><td>{fmt.dateTime(r.in_at)}</td><td>{r.out_at ? fmt.dateTime(r.out_at) : <span className="pill info">{t('sessions.open')}</span>}</td>
            <td>{r.in_by}{r.out_by && r.out_by !== r.in_by ? ` → ${r.out_by}` : ''}</td><td>{t('sessions.minutes', { count: r.minutes })}</td>
            <td className="num">{r.fee != null ? fmt.money(r.fee) : '–'}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {sel && (
        <section className="card">
          <h2>{t('sessions.timeline')}</h2>
          <ol className="timeline">{events.data?.map((e) => (
            <li key={e.id}>
              <strong>{eventLabel(t, e.type)}</strong> <span className="muted">{fmt.dateTime(e.server_at)} · {e.actor ?? 'api'}</span>
              <div className="muted" style={{ fontSize: '0.85rem' }}>{Object.entries(e.payload).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>
            </li>
          ))}</ol>
        </section>
      )}
    </div>
  );
}
