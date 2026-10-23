import { PlateChip } from '@openpark/ui';
import { pickLabel, useApp } from '../app-context.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormat, useI18n, useT } from '../i18n.js';

interface Occ {
  totals: { free: number; occupied: number; reserved: number; outOfService: number };
  last24h: { fees: number; closed: number };
  breakdown: { site: string; zone: string; zone_name: string; zone_labels: Record<string, string>; type: string; free: number; occupied: number; out_of_service: number }[];
}
interface Row { id: string; plate: string; slot: string | null; in_at: string; out_at: string | null; status: string; fee: number | null; in_by: string | null }

export function Dashboard() {
  const t = useT();
  const { site, me } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const { locale } = useI18n();
  const typeLabel = (c: string) => pickLabel(me?.tenant.slot_types.find((x) => x.code === c)?.label, locale, c);
  const occ = useApi<Occ>(site ? `/v1/occupancy?site=${site.code}` : null, [site?.code]);
  const recent = useApi<{ items: Row[] }>(site ? `/v1/sessions?site=${site.code}&limit=8` : null, [site?.code]);
  const live = useLiveEvents(() => { void occ.reload(); void recent.reload(); });
  const o = occ.data;

  return (
    <div className="stack">
      <div className="row between">
        <h1>{t('dash.title')}</h1>
        <Badge className={`pill ${live ? 'ok' : 'warn'}`}>{live ? `● ${t('dash.live')}` : t('dash.reconnecting')}</Badge>
      </div>
      {occ.error && <Alert variant="destructive" className="banner bad">{occ.error}</Alert>}
      <div className="tiles">
        <Card className="card tile"><div className="label">{t('dash.free')}</div><div className="value">{o ? fmt.number(o.totals.free) : '–'}</div></Card>
        <Card className="card tile"><div className="label">{t('dash.occupied')}</div><div className="value">{o ? fmt.number(o.totals.occupied) : '–'}</div></Card>
        <Card className="card tile"><div className="label">{t('dash.outOfService')}</div><div className="value">{o ? fmt.number(o.totals.outOfService) : '–'}</div></Card>
        <Card className="card tile"><div className="label">{t('dash.fees24h')}</div><div className="value">{o ? fmt.money(o.last24h.fees) : '–'}</div></Card>
      </div>
      <section>
        <h2>{t('dash.byZone')}</h2>
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('common.zone')}</TableHead><TableHead>{t('common.type')}</TableHead><TableHead className="num">{t('dash.free')}</TableHead><TableHead className="num">{t('dash.occupied')}</TableHead><TableHead className="num">{t('dash.outOfService')}</TableHead></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={occ.loading} error="" empty={!!o && !o.breakdown.length} table colSpan={5} />
            {!occ.loading && o?.breakdown.map((r) => (
              <TableRow key={r.zone + r.type}><TableCell>{pickLabel(r.zone_labels, locale, r.zone_name)}</TableCell><TableCell>{typeLabel(r.type)}</TableCell><TableCell className="num">{r.free}</TableCell><TableCell className="num">{r.occupied}</TableCell><TableCell className="num">{r.out_of_service}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table></div>
      </section>
      <section>
        <h2>{t('att.recent')}</h2>
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('sessions.plate')}</TableHead><TableHead>{t('att.slot')}</TableHead><TableHead>{t('sessions.in')}</TableHead><TableHead>{t('sessions.fee')}</TableHead></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={recent.loading} error={recent.error} empty={!recent.data?.items.length} table colSpan={4} />
            {!recent.loading && !recent.error && recent.data?.items.map((r) => (
              <TableRow key={r.id}><TableCell><PlateChip plate={r.plate} /></TableCell><TableCell>{r.slot}</TableCell><TableCell>{fmt.dateTime(r.in_at)}</TableCell><TableCell className="num">{r.fee != null ? fmt.money(r.fee) : <Badge className="pill info">{t('sessions.open')}</Badge>}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table></div>
      </section>
    </div>
  );
}
