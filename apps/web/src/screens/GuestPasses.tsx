import { useEffect, useState } from 'react';
import { ApiError, patch, post } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';
import type { PassView } from './Resident.js';

interface Policy { qrTtlMin: number; maxStayHours: number; reminderHours: [number, number]; overstayCharge: number; alertRecipients: ('host' | 'guest' | 'supervisors')[] }
interface PolicyRes { policy: Policy; currency: string }
type StaffPass = PassView & { host: string | null; site: string };

export function GuestPasses() {
  const t = useT();
  const { me, can } = useApp();
  const fmt = useFormat(undefined, me?.tenant.currency);
  const res = useApi<PolicyRes>('/v1/pass-policy');
  const list = useApi<StaffPass[]>('/v1/passes?limit=50');
  const [p, setP] = useState<Policy | null>(null);
  const [msg, setMsg] = useState('');
  const canEdit = can('override');
  useEffect(() => { if (res.data) setP(res.data.policy); }, [res.data]);

  async function save() {
    if (!p) return;
    try { await patch('/v1/pass-policy', p); setMsg(t('common.saved')); await res.reload(); } catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
  }
  async function cancel(id: string) { try { await post(`/v1/passes/${id}/cancel`); await list.reload(); } catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); } }
  const num = (k: 'qrTtlMin' | 'maxStayHours', v: string) => setP({ ...p!, [k]: Number(v) });
  const toggle = (who: 'guest' | 'supervisors') => setP({ ...p!, alertRecipients: p!.alertRecipients.includes(who) ? p!.alertRecipients.filter((x) => x !== who) : [...p!.alertRecipients, who] });

  return (
    <div className="stack">
      <h1>{t('passes.title')}</h1>
      {p && (
        <section className="card stack">
          <h2>{t('passes.rules')}</h2>
          <div className="tiles">
            <label className="field">{t('passes.qrTtl')}<input type="number" min={5} max={1440} value={p.qrTtlMin} disabled={!canEdit} onChange={(e) => num('qrTtlMin', e.target.value)} /></label>
            <label className="field">{t('passes.maxStay')}<input type="number" min={1} max={72} step="0.5" value={p.maxStayHours} disabled={!canEdit} onChange={(e) => num('maxStayHours', e.target.value)} /></label>
            <label className="field">{t('passes.reminder1')}<input type="number" min={0.5} step="0.5" value={p.reminderHours[0]} disabled={!canEdit} onChange={(e) => setP({ ...p, reminderHours: [Number(e.target.value), p.reminderHours[1]] })} /></label>
            <label className="field">{t('passes.reminder2')}<input type="number" min={0.5} step="0.5" value={p.reminderHours[1]} disabled={!canEdit} onChange={(e) => setP({ ...p, reminderHours: [p.reminderHours[0], Number(e.target.value)] })} /></label>
            <label className="field">{t('passes.charge')} ({res.data?.currency})
              <input type="number" min={0} step="0.01" value={p.overstayCharge / 100} disabled={!canEdit} onChange={(e) => setP({ ...p, overstayCharge: Math.round(Number(e.target.value) * 100) })} /></label>
          </div>
          <p className="muted">{t('passes.chargeHelp')}</p>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend>{t('passes.alerts')}</legend>
            <div className="row">
              <label className="row"><input type="checkbox" checked disabled />{t('passes.alertHost')}</label>
              <label className="row"><input type="checkbox" checked={p.alertRecipients.includes('guest')} disabled={!canEdit} onChange={() => toggle('guest')} />{t('passes.alertGuest')}</label>
              <label className="row"><input type="checkbox" checked={p.alertRecipients.includes('supervisors')} disabled={!canEdit} onChange={() => toggle('supervisors')} />{t('passes.alertSupervisors')}</label>
            </div>
          </fieldset>
          {canEdit && <div className="row"><button className="btn primary" onClick={save}>{t('common.save')}</button>{msg && <span className="muted">{msg}</span>}</div>}
        </section>
      )}
      <section>
        <h2>{t('passes.list')}</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>{t('units.code')}</th><th>{t('passes.guest')}</th><th>{t('common.status')}</th><th>{t('passes.expires')}</th><th /></tr></thead>
          <tbody>{list.data?.map((x) => (
            <tr key={x.id}>
              <td>{x.unit.code}</td><td>{x.guestName}</td><td><span className="pill">{t(`res.status_${x.displayStatus}`)}</span></td>
              <td>{fmt.dateTime(x.expiresAt)}</td>
              <td>{x.status === 'active' && <button className="btn danger" onClick={() => cancel(x.id)}>{t('res.cancel')}</button>}{x.overstayCharge ? ` ${fmt.money(x.overstayCharge)}` : ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
    </div>
  );
}
