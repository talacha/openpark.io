import { useEffect, useState } from 'react';
import { ApiError, patch, post } from '../api.js';
import { canEditPassPolicy, useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormat, useT } from '../i18n.js';
import type { PassView } from './Resident.js';

interface Policy { qrTtlMin: number; maxStayHours: number; reminderHours: [number, number]; overstayCharge: number; alertRecipients: ('host' | 'guest' | 'supervisors')[] }
interface PolicyRes { policy: Policy; currency: string }
type StaffPass = PassView & { host: string | null; site: string };

export function GuestPasses() {
  const t = useT();
  const { me } = useApp();
  const fmt = useFormat(undefined, me?.tenant.currency);
  const res = useApi<PolicyRes>('/v1/pass-policy');
  const list = useApi<StaffPass[]>('/v1/passes?limit=50');
  const [p, setP] = useState<Policy | null>(null);
  const [msg, setMsg] = useState('');
  // The policy editor must match the server's settings.edit permission (admin/super admin only); supervisors see it read-only.
  const canEdit = canEditPassPolicy(me);
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
      <QueryState loading={res.loading} error={res.error} empty={!res.data} />
      {p && (
        <Card className="card stack">
          <h2>{t('passes.rules')}</h2>
          <div className="tiles">
            <label className="field">{t('passes.qrTtl')}<Input type="number" min={5} max={1440} value={p.qrTtlMin} disabled={!canEdit} onChange={(e) => num('qrTtlMin', e.target.value)} /></label>
            <label className="field">{t('passes.maxStay')}<Input type="number" min={1} max={72} step="0.5" value={p.maxStayHours} disabled={!canEdit} onChange={(e) => num('maxStayHours', e.target.value)} /></label>
            <label className="field">{t('passes.reminder1')}<Input type="number" min={0.5} step="0.5" value={p.reminderHours[0]} disabled={!canEdit} onChange={(e) => setP({ ...p, reminderHours: [Number(e.target.value), p.reminderHours[1]] })} /></label>
            <label className="field">{t('passes.reminder2')}<Input type="number" min={0.5} step="0.5" value={p.reminderHours[1]} disabled={!canEdit} onChange={(e) => setP({ ...p, reminderHours: [p.reminderHours[0], Number(e.target.value)] })} /></label>
            <label className="field">{t('passes.charge')} ({res.data?.currency})
              <Input type="number" min={0} step="0.01" value={p.overstayCharge / 100} disabled={!canEdit} onChange={(e) => setP({ ...p, overstayCharge: Math.round(Number(e.target.value) * 100) })} /></label>
          </div>
          <p className="muted">{t('passes.chargeHelp')}</p>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend>{t('passes.alerts')}</legend>
            <div className="row">
              <label className="row"><Checkbox checked disabled />{t('passes.alertHost')}</label>
              <label className="row"><Checkbox checked={p.alertRecipients.includes('guest')} disabled={!canEdit} onCheckedChange={() => toggle('guest')} />{t('passes.alertGuest')}</label>
              <label className="row"><Checkbox checked={p.alertRecipients.includes('supervisors')} disabled={!canEdit} onCheckedChange={() => toggle('supervisors')} />{t('passes.alertSupervisors')}</label>
            </div>
          </fieldset>
          {canEdit && <div className="row"><Button className="btn primary" onClick={save}>{t('common.save')}</Button>{msg && <span className="muted">{msg}</span>}</div>}
        </Card>
      )}
      <section>
        <h2>{t('passes.list')}</h2>
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('units.code')}</TableHead><TableHead>{t('passes.guest')}</TableHead><TableHead>{t('common.status')}</TableHead><TableHead>{t('passes.expires')}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={list.loading} error={list.error} empty={!list.data?.length} table colSpan={5} />
            {!list.loading && !list.error && list.data?.map((x) => (
              <TableRow key={x.id}>
                <TableCell>{x.unit.code}</TableCell><TableCell>{x.guestName}</TableCell><TableCell><Badge className="pill">{t(`res.status_${x.displayStatus}`)}</Badge></TableCell>
                <TableCell>{fmt.dateTime(x.expiresAt)}</TableCell>
                <TableCell>{x.status === 'active' && <Button variant="destructive" className="btn danger" onClick={() => cancel(x.id)}>{t('res.cancel')}</Button>}{x.overstayCharge ? ` ${fmt.money(x.overstayCharge)}` : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table></div>
      </section>
    </div>
  );
}
