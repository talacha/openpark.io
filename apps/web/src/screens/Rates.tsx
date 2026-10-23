import { useEffect, useState } from 'react';
import { ApiError, request } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useFormat, useT } from '../i18n.js';
import { feeLabel } from '../labels.js';

interface Rules { graceMin: number; firstPeriodMin: number; firstPeriodFee: number; incrementMin: number; incrementFee: number; dailyCap: number | null; lostTicketFee: number; taxMode: string; taxRate: number }
interface Plan { id: string; name: string; version: number; rules: Rules; is_default: boolean; in_use: boolean; currency: string }
interface Quote { minutes: number; total: number; tax: number; lines: { label: string; amount: number }[] }

const toIso = (local: string) => new Date(local).toISOString();

export function Rates() {
  const t = useT();
  const { site, me } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const plans = useApi<Plan[]>(site ? `/v1/rate-plans?site=${site.code}` : null, [site?.code]);
  const plan = plans.data?.find((p) => p.is_default) ?? plans.data?.[0];
  const [rules, setRules] = useState<Rules | null>(null);
  const [msg, setMsg] = useState('');
  const [inAt, setInAt] = useState('2026-10-20T08:12');
  const [outAt, setOutAt] = useState('2026-10-20T14:09');
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => { if (plan) setRules(plan.rules); }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!plan || !rules) return <div className="stack"><h1>{t('rates.title')}</h1><QueryState loading={plans.loading || (!!plan && !rules)} error={plans.error} empty={!plan} /></div>;
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => setRules({ ...rules, [k]: v });
  // Money fields are shown in major units and stored as minor units.
  const money = (k: 'firstPeriodFee' | 'incrementFee' | 'lostTicketFee') => (
    <Input type="number" step="0.01" min="0" value={rules[k] / 100} onChange={(e) => set(k, Math.round(Number(e.target.value) * 100))} />
  );

  async function save() {
    try { const r = await request<{ version: number }>('POST', '/v1/rate-plans', { site: site!.code, name: plan!.name, rules }); setMsg(t('rates.version', { version: r.version })); await plans.reload(); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
  }
  async function simulate() {
    try { setQuote(await request<Quote>('POST', `/v1/rate-plans/${plan!.id}/quote`, { inAt: toIso(inAt), outAt: toIso(outAt) })); setMsg(''); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="stack">
      <div className="row between"><h1>{t('rates.title')}</h1><Badge className="pill ok">{plan.name} · {t('rates.version', { version: plan.version })}</Badge></div>
      {plan.in_use && <Alert className="banner">{t('rates.inUse')}</Alert>}
      <Card className="card stack">
        <div className="tiles">
          <label className="field">{t('rates.grace')}<Input type="number" min="0" value={rules.graceMin} onChange={(e) => set('graceMin', Number(e.target.value))} /></label>
          <label className="field">{t('rates.first')}<Input type="number" min="1" value={rules.firstPeriodMin} onChange={(e) => set('firstPeriodMin', Number(e.target.value))} /></label>
          <label className="field">{t('rates.firstFee')}{money('firstPeriodFee')}</label>
          <label className="field">{t('rates.increment')}<Input type="number" min="1" value={rules.incrementMin} onChange={(e) => set('incrementMin', Number(e.target.value))} /></label>
          <label className="field">{t('rates.incrementFee')}{money('incrementFee')}</label>
          <label className="field">{t('rates.cap')}<Input type="number" step="0.01" min="0" value={(rules.dailyCap ?? 0) / 100} onChange={(e) => set('dailyCap', e.target.value ? Math.round(Number(e.target.value) * 100) : null)} /></label>
          <label className="field">{t('rates.lost')}{money('lostTicketFee')}</label>
        </div>
        <div className="row"><Button className="btn primary" onClick={save}>{t('rates.newVersion')}</Button>{msg && <span className="muted">{msg}</span>}</div>
      </Card>
      <Card className="card stack">
        <h2>{t('rates.simulator')}</h2>
        <div className="row">
          <label className="field">{t('rates.in')}<Input type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} /></label>
          <label className="field">{t('rates.out')}<Input type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} /></label>
          <Button variant="outline" className="btn" onClick={simulate}>{t('rates.quote')}</Button>
        </div>
        {quote && (
          <div>
            <div className="muted">{t('rates.minutes')}: {t('sessions.minutes', { count: quote.minutes })}</div>
            {quote.lines.map((l, i) => <div className="feeline" key={i}><span>{feeLabel(t, l.label)}</span><span className="num">{fmt.money(l.amount)}</span></div>)}
            <div className="feeline"><strong>{t('rates.total')}</strong><span className="feetotal num">{fmt.money(quote.total)}</span></div>
            {quote.tax > 0 && <div className="muted">{t('rates.tax')}: {fmt.money(quote.tax)}</div>}
          </div>
        )}
      </Card>
    </div>
  );
}
