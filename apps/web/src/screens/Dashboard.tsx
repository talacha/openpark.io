import { PlateChip } from '@openpark/ui';
import { pickLabel, useApp } from '../app-context.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
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
        <span className={`pill ${live ? 'ok' : 'warn'}`}>{live ? `● ${t('dash.live')}` : t('dash.reconnecting')}</span>
      </div>
      {occ.error && <div className="banner bad">{occ.error}</div>}
      <div className="tiles">
        <div className="card tile"><div className="label">{t('dash.free')}</div><div className="value">{o ? fmt.number(o.totals.free) : '–'}</div></div>
        <div className="card tile"><div className="label">{t('dash.occupied')}</div><div className="value">{o ? fmt.number(o.totals.occupied) : '–'}</div></div>
        <div className="card tile"><div className="label">{t('dash.outOfService')}</div><div className="value">{o ? fmt.number(o.totals.outOfService) : '–'}</div></div>
        <div className="card tile"><div className="label">{t('dash.fees24h')}</div><div className="value">{o ? fmt.money(o.last24h.fees) : '–'}</div></div>
      </div>
      <section>
        <h2>{t('dash.byZone')}</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>{t('common.zone')}</th><th>{t('common.type')}</th><th className="num">{t('dash.free')}</th><th className="num">{t('dash.occupied')}</th><th className="num">{t('dash.outOfService')}</th></tr></thead>
          <tbody>{o?.breakdown.map((r) => (
            <tr key={r.zone + r.type}><td>{pickLabel(r.zone_labels, locale, r.zone_name)}</td><td>{typeLabel(r.type)}</td><td className="num">{r.free}</td><td className="num">{r.occupied}</td><td className="num">{r.out_of_service}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
      <section>
        <h2>{t('att.recent')}</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>{t('sessions.plate')}</th><th>{t('att.slot')}</th><th>{t('sessions.in')}</th><th>{t('sessions.fee')}</th></tr></thead>
          <tbody>{recent.data?.items.map((r) => (
            <tr key={r.id}><td><PlateChip plate={r.plate} /></td><td>{r.slot}</td><td>{fmt.dateTime(r.in_at)}</td><td className="num">{r.fee != null ? fmt.money(r.fee) : <span className="pill info">{t('sessions.open')}</span>}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </div>
  );
}
