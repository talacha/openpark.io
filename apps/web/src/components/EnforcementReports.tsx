import { PlateChip } from '@openpark/ui';
import { useState } from 'react';
import { post } from '../api.js';
import { useApp } from '../app-context.js';
import { errText } from '../errors.js';
import { useFormat, useT } from '../i18n.js';
import { EvidenceCapture } from './EvidenceCapture.js';
import { useApi } from './hooks.js';
import { QueryState } from './QueryState.js';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export interface EnforcementReport {
  id: string;
  site: string;
  sessionId: string | null;
  plate: string | null;
  region: string | null;
  reasons: ('overstay' | 'not_checked_in' | 'wrong_slot')[];
  action: 'fine' | 'immobilization';
  unit: { id: string; code: string; name: string } | null;
  fine: { amountMinor: number; currency: string } | null;
  createdAt: string;
  fineIssuedAt: string | null;
  immobilizedAt: string | null;
  requiredActions: ('fine' | 'immobilization')[];
  status: 'open' | 'complete';
  evidence: { id: string; url: string; createdAt: string }[];
}

export function EnforcementReports({ status = 'open' }: { status?: 'open' | 'all' }) {
  const t = useT();
  const { site } = useApp();
  const fmt = useFormat(site?.timezone, 'MXN');
  const reports = useApi<{ items: EnforcementReport[] }>(site ? `/v1/enforcement/reports?site=${encodeURIComponent(site.code)}&status=${status}` : null, [site?.code, status]);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function issueFine(id: string) {
    setBusy(id); setErr('');
    try { await post(`/v1/enforcement/cases/${id}/fine`); await reports.reload(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(''); }
  }

  async function upload(report: EnforcementReport, immobilize: boolean) {
    const data = evidence[report.id];
    if (!data) return;
    setBusy(`${report.id}:${immobilize ? 'immobilize' : 'photo'}`); setErr('');
    try {
      await post(`/v1/enforcement/cases/${report.id}/evidence`, { contentType: 'image/jpeg', dataBase64: data.split(',')[1], immobilize });
      setEvidence((current) => ({ ...current, [report.id]: '' }));
      await reports.reload();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(''); }
  }

  return (
    <section className="stack" aria-label={t('enf.reports')}>
      <h2>{t(status === 'open' ? 'enf.pending' : 'enf.reports')}</h2>
      <QueryState loading={reports.loading} error={reports.error} empty={!reports.data?.items?.length} emptyLabel={t(status === 'open' ? 'enf.noPending' : 'enf.noReports')} />
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      {reports.data?.items?.map((report, index) => (
        <Card key={report.id} className="card stack">
          <details open={status === 'open' || index === 0}>
            <summary>
              {report.plate ? <PlateChip plate={report.plate} region={report.region ?? undefined} /> : t('enf.noPlate')}
              {report.requiredActions.length > 0 && <span className="pill warn">{t('enf.actionRequired')}</span>}
            </summary>
            <div className="stack">
              <div>{report.reasons.map((reason) => t(`enf.reason_${reason}`)).join(' · ')}</div>
              {report.unit && <div>{t('enf.unit')}: <strong>{report.unit.code} · {report.unit.name}</strong></div>}
              <dl className="kv">
                {report.fine && <><dt>{t('enf.fine')}</dt><dd>{fmt.money(report.fine.amountMinor)} · {t(report.fineIssuedAt ? 'enf.fineIssued' : 'enf.finePending')}</dd></>}
                <dt>{t('enf.immobilizationStatus')}</dt><dd>{t(report.immobilizedAt ? 'enf.immobilizedDone' : 'enf.immobilizationPending')}</dd>
              </dl>
              {report.evidence.length > 0 && (
                <div className="row" aria-label={t('enf.photoHistory')}>
                  {report.evidence.map((photo, photoIndex) => (
                    <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" aria-label={`${t('enf.viewEvidence')} ${photoIndex + 1}`}>
                      <img src={photo.url} alt={`${t('enf.evidencePreview')} ${photoIndex + 1}`} style={{ inlineSize: '96px', blockSize: '96px', objectFit: 'cover', maxInlineSize: '100%' }} />
                    </a>
                  ))}
                </div>
              )}
              {report.requiredActions.includes('fine') && (
                <Button type="button" className="btn primary" disabled={busy === report.id} onClick={() => void issueFine(report.id)}>
                  {busy === report.id ? t('common.loading') : t('enf.issueFine', { amount: fmt.money(report.fine!.amountMinor) })}
                </Button>
              )}
              <EvidenceCapture value={evidence[report.id] ?? ''} onChange={(data) => setEvidence((current) => ({ ...current, [report.id]: data }))} required={report.requiredActions.includes('immobilization')} disabled={!!busy} />
              <div className="row">
                <Button type="button" className="btn" disabled={!!busy || !evidence[report.id]} onClick={() => void upload(report, false)}>{t('enf.addPhoto')}</Button>
                {report.requiredActions.includes('immobilization') && (
                  <Button type="button" className="btn danger" disabled={!!busy || !evidence[report.id]} onClick={() => void upload(report, true)}>{t('enf.immobilize')}</Button>
                )}
              </div>
            </div>
          </details>
        </Card>
      ))}
    </section>
  );
}
