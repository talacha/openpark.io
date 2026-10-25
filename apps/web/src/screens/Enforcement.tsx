import { PlateChip } from '@openpark/ui';
import { useRef, useState } from 'react';
import { get, post } from '../api.js';
import { useApp } from '../app-context.js';
import { errText } from '../errors.js';
import { useFormat, useT } from '../i18n.js';
import { Keypad, Tabs } from './Attendant.js';
import { LiveCamera } from '../components/LiveCamera.js';
import { EvidenceCapture } from '../components/EvidenceCapture.js';
import { EnforcementReports } from '../components/EnforcementReports.js';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Inspection {
  status: 'valid' | 'invalid';
  reasons: ('overstay' | 'not_checked_in' | 'wrong_slot')[];
  plate: string | null;
  region: string | null;
  sessionId: string | null;
  ticketCode: string | null;
  checkedInAt: string | null;
  currentSlot: string | null;
  expectedSlot: string | null;
  unit: { id: string; code: string; name: string } | null;
  fine: { amountMinor: number; currency: 'MXN' } | null;
  action: 'fine' | 'immobilization' | null;
}
type Flagged = Inspection & { id: string; evidenceUrl: string | null };

export function Enforcement() {
  const t = useT();
  const { me, site } = useApp();
  const fmt = useFormat(site?.timezone, 'MXN');
  const [tab, setTab] = useState<'camera' | 'manual'>('camera');
  const [entry, setEntry] = useState('');
  const [result, setResult] = useState<Inspection | null>(null);
  const [recorded, setRecorded] = useState<Flagged | null>(null);
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sequence = useRef(0);

  function changeEntry(value: string) {
    setEntry(value);
    setResult(null);
    setRecorded(null);
    setEvidence('');
    setErr('');
  }

  async function inspect(raw = entry) {
    const value = raw.trim();
    if (!value || !site) return;
    const own = ++sequence.current;
    setBusy(true); setErr(''); setResult(null); setRecorded(null); setEvidence('');
    try {
      const found = await get<Inspection>(`/v1/enforcement/inspect?site=${encodeURIComponent(site.code)}&entry=${encodeURIComponent(value)}`);
      if (own === sequence.current) setResult(found);
    } catch (e) {
      if (own === sequence.current) setErr(errText(e));
    } finally {
      if (own === sequence.current) setBusy(false);
    }
  }

  async function flag() {
    if (!result?.action || !site) return;
    setBusy(true); setErr('');
    try {
      // Every violation can include evidence; unlinked immobilization requires it.
      const withEvidence = result.action === 'immobilization' || !!evidence;
      const flagged = await post<Flagged>('/v1/enforcement/flags', {
        site: site.code, entry: entry.trim(), action: result.action,
        ...(withEvidence ? { evidence: { contentType: 'image/jpeg', dataBase64: evidence.split(',')[1] } } : {}),
      });
      setRecorded(flagged);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }

  if (!site) return <div className="att"><p className="muted" role="status">{t('common.loading')}</p></div>;
  if (recorded) {
    return (
      <div className="att">
        <h1>{t('enf.title')}</h1>
        <Alert className="banner" role="status">
          <strong>{recorded.action === 'fine' ? t('enf.fineRecorded', { unit: recorded.unit!.code }) : t('enf.immobilized')}</strong>
        </Alert>
        {recorded.plate ? <div className="platebox"><PlateChip plate={recorded.plate} region={recorded.region ?? undefined} size="xl" /></div> : <p>{t('enf.noPlate')}</p>}
        {recorded.evidenceUrl && <p><a className="btn" href={recorded.evidenceUrl} target="_blank" rel="noreferrer">{t('enf.viewEvidence')}</a></p>}
        <Button type="button" className="btn primary big" onClick={() => changeEntry('')}>{t('enf.another')}</Button>
        <EnforcementReports status="all" />
      </div>
    );
  }

  return (
    <div className="att">
      <h1>{t('enf.title')}</h1>
      <p className="muted">{t('enf.subtitle')}</p>
      <Tabs tab={tab} onTab={setTab} label={t('att.captureMethod')} labels={{ camera: t('att.camera'), manual: t('att.manualEntry') }} />
      <label className="field">{t('att.plateTicketOrPass')}
        <Input value={entry} onChange={(e) => changeEntry(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void inspect(); }}
          placeholder={t('att.plateTicketOrPass')} aria-label={t('att.plateTicketOrPass')} dir="ltr" autoCapitalize="off" />
      </label>
      <Button type="button" className="btn primary big" disabled={busy || !entry.trim()} onClick={() => void inspect()}>{busy ? t('enf.checking') : t('enf.inspect')}</Button>
      {tab === 'camera' ? (
        <LiveCamera regions={me!.tenant.plate_regions} plate={me!.tenant.ai_mode !== 'off'} busy={busy}
          onQr={(text) => { setEntry(text); void inspect(text); }}
          onPlate={(p) => { setEntry(p.text); void inspect(p.text); }} />
      ) : <Keypad region={me!.tenant.plate_regions[0]} value={entry} onChange={changeEntry} />}

      {busy && <p className="muted" role="status">{t('enf.checking')}</p>}
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      {!result && !busy && !err && <p className="muted">{t('enf.empty')}</p>}
      {result && (
        <section className="stack" aria-live="polite">
          <Alert variant={result.status === 'invalid' ? 'destructive' : undefined} className={result.status === 'invalid' ? 'banner bad' : 'banner'}>
            <strong>{t(result.status === 'valid' ? 'enf.valid' : 'enf.invalid')}</strong>
            {result.reasons.map((reason) => <div key={reason}>{t(`enf.reason_${reason}`)}</div>)}
          </Alert>
          {result.plate ? <div className="platebox"><PlateChip plate={result.plate} region={result.region ?? undefined} size="xl" /></div> : <p>{t('enf.noPlate')}</p>}
          <dl className="kv">
            <dt>{t('enf.expectedSlot')}</dt><dd>{result.expectedSlot ?? t('common.none')}</dd>
            {result.currentSlot && <><dt>{t('enf.currentSlot')}</dt><dd>{result.currentSlot}</dd></>}
            {result.checkedInAt && <><dt>{t('enf.checkedIn')}</dt><dd>{fmt.dateTime(result.checkedInAt)}</dd></>}
            {result.unit && <><dt>{t('enf.unit')}</dt><dd>{result.unit.code} · {result.unit.name}</dd></>}
            {result.fine && <><dt>{t('enf.fine')}</dt><dd className="num">{fmt.money(result.fine.amountMinor)}</dd></>}
          </dl>
          {result.action === 'fine' && (
            <>
              <EvidenceCapture value={evidence} onChange={setEvidence} />
              <Button type="button" className="btn danger big" disabled={busy} onClick={() => void flag()}>{t('enf.flagFine', { amount: fmt.money(result.fine!.amountMinor) })}</Button>
            </>
          )}
          {result.action === 'immobilization' && (
            <>
              <p>{t('enf.unlinked')}</p>
              <EvidenceCapture value={evidence} onChange={setEvidence} required />
              <Button type="button" className="btn danger big" disabled={busy || !evidence} onClick={() => void flag()}>{t('enf.immobilize')}</Button>
            </>
          )}
        </section>
      )}
      <EnforcementReports status="all" />
    </div>
  );
}
