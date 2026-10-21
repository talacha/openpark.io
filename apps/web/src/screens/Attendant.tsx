import { PlateChip } from '@openpark/ui';
import { Suspense, createContext, lazy, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, get, isNetworkError, post, request, write } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { LiveCamera } from '../components/LiveCamera.js';
import { matchesRegistry, normalizePlate } from '../alpr/plates.js';
import { parsePassQr, passAcceptPatch, passRemovePatch, spaceCode } from '../pass.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';
import { errText } from '../errors.js';
import { feeLabel, passReason } from '../labels.js';

// The QR decoder is only needed once someone taps Scan, so it stays out of the main bundle.
const QrScanner = lazy(() => import('../components/QrScanner.js').then((m) => ({ default: m.QrScanner })));
const Scanner = (props: { onResult: (text: string) => void; onClose: () => void }) => <Suspense fallback={<div className="muted">…</div>}><QrScanner {...props} /></Suspense>;

/* ---------- shared check-in state ---------- */

interface Candidate { text: string; norm: string; confidence: number; region?: string; formatValid: boolean | null }
interface FlowState {
  plate: string; region: string; source: 'manual' | 'ai_assist' | 'ai_auto';
  candidates: Candidate[]; confidence?: number; textRaw?: string; cropKey?: string;
  /** True while `plate` was filled from a scanned pass hint, so it clears when the pass is removed or replaced. */
  plateFromPass: boolean;
  vehicle: { make?: string; model?: string; color?: string; bodyType?: string };
  /** A scanned resident guest pass: check-in is then free and tied to the pass. */
  pass: { token: string; guest: string; unit: string; plateHint?: string; verifyCode?: string } | null;
}
const empty = (region: string): FlowState => ({ plate: '', region, source: 'manual', candidates: [], vehicle: {}, pass: null, plateFromPass: false });
/** Clear read metadata alongside a pass-derived plate, so a stale candidate/confidence never rides on the next pass. */
const clearedRead = { candidates: [] as Candidate[], confidence: undefined, textRaw: undefined, cropKey: undefined };
const FlowCtx = createContext<{ flow: FlowState; set: (f: Partial<FlowState>) => void; reset: () => void }>(null as never);
const useFlow = () => useContext(FlowCtx);

export function Flow({ children }: { children: ReactNode }) {
  const { me } = useApp();
  const region0 = me?.tenant.plate_regions[0] ?? 'US';
  const [flow, setFlow] = useState<FlowState>(empty(region0));
  const value = useMemo(() => ({ flow, set: (f: Partial<FlowState>) => setFlow((s) => ({ ...s, ...f })), reset: () => setFlow(empty(region0)) }), [flow, region0]);
  return <FlowCtx.Provider value={value}>{children}</FlowCtx.Provider>;
}

const base = (slug: string) => `/t/${slug}/a`;

/* ---------- home ---------- */

interface Occ { totals: { free: number }; breakdown: { zone: string; zone_name: string; type: string; free: number }[] }
interface Row { id: string; plate: string; slot: string | null; in_at: string; out_at: string | null; fee: number | null }

export function AttendantHome() {
  const t = useT();
  const nav = useNavigate();
  const { me, site } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const occ = useApi<Occ>(site ? `/v1/occupancy?site=${site.code}` : null, [site?.code]);
  const recent = useApi<{ items: Row[] }>(site ? `/v1/sessions?site=${site.code}&limit=6` : null, [site?.code]);
  useLiveEvents(() => { void occ.reload(); void recent.reload(); });
  const b = base(me!.tenant.slug);
  return (
    <div className="att">
      <div className="card tile"><div className="label">{t('att.freeNow')}</div><div className="value" style={{ fontSize: '3rem' }}>{occ.data ? fmt.number(occ.data.totals.free) : '–'}</div></div>
      <button className="btn primary big" onClick={() => nav(`${b}/checkin`)}>{t('att.checkin')}</button>
      <button className="btn big" onClick={() => nav(`${b}/checkout`)}>{t('att.checkout')}</button>
      <section><h2>{t('att.recent')}</h2>
        <div className="stack">{recent.data?.items.map((r) => (
          <div key={r.id} className="card row between"><PlateChip plate={r.plate} /><span className="muted">{r.slot} · {fmt.time(r.out_at ?? r.in_at)}</span></div>
        ))}</div>
      </section>
    </div>
  );
}

/* ---------- plate entry: keypad and camera ---------- */

const KEY_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'] as const;

/**
 * On-screen plate keyboard: digits, then QWERTY rows (with Ñ), and a last row of Z..M plus Delete and a clear (✕) key.
 * Plates are always typed left-to-right whatever the interface language.
 */
function Keypad({ value, onChange }: { region?: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const key = (c: string) => <button key={c} type="button" onClick={() => onChange(value + c)} aria-label={c}>{c}</button>;
  return (
    <div className="keypad" dir="ltr" role="group" aria-label={t('att.keypad')}>
      {KEY_ROWS.slice(0, 3).map((row) => <div className="keyrow" key={row}>{[...row].map(key)}</div>)}
      <div className="keyrow">
        {[...KEY_ROWS[3]].map(key)}
        <button type="button" className="key-delete" onClick={() => onChange(value.slice(0, -1))} aria-label={t('att.keyDelete')}>⌫</button>
        <button type="button" className="key-clear" onClick={() => onChange('')} aria-label={t('att.keyClear')}>✕</button>
      </div>
    </div>
  );
}

interface AlprRes { decision: 'auto' | 'review'; threshold: number; candidates: Candidate[]; vehicle: FlowState['vehicle'] | null; readId: string }

export function CheckInCapture() {
  const t = useT();
  const nav = useNavigate();
  const { me, site } = useApp();
  const { flow, set } = useFlow();
  const aiOn = me!.tenant.ai_mode !== 'off';
  const [camera, setCamera] = useState(aiOn);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = base(me!.tenant.slug);
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [passErr, setPassErr] = useState('');
  const passBannerRef = useRef<HTMLDivElement>(null);

  // When a pass is accepted, move focus to its banner so keyboard and screen-reader users land on the result and hear it.
  useEffect(() => { if (flow.pass) passBannerRef.current?.focus(); }, [flow.pass?.token]);

  /** Look a scanned or typed pass up before taking the plate, so a bad QR is caught at the gate, not after. */
  async function usePass(raw: string) {
    const token = raw.trim();
    setScanning(false); setPassErr('');
    if (!token) return;
    // The QR carries the guest, unit, plate hint and expiry, so an expired or foreign code is rejected before any round trip.
    const q = parsePassQr(token);
    // Expiry is the server's call: this phone's clock may be wrong, and a wrong clock must not turn a valid guest away.
    if (q && site && q.site !== site.code) { setPassErr(t('pass.reason_pass_wrong_site')); return; }
    try {
      const r = await get<{ valid: boolean; reason: string | null; pass: { guestName: string; unit: { name: string } } }>(`/v1/passes/lookup?token=${encodeURIComponent(token)}`);
      if (!r.valid) { setPassErr(passReason(t, r.reason ?? 'pass_invalid')); return; }
      // A pass that carries a plate hint pre-fills the plate field so the attendant only verifies it; the keypad and
      // camera stay available to correct it. A pass with no hint clears a plate left over from a PREVIOUS pass (so pass A's
      // plate can never redeem against pass B) but keeps a plate the attendant captured independently.
      const patch = passAcceptPatch({ plate: flow.plate, plateFromPass: flow.plateFromPass }, q);
      set({
        pass: { token, guest: r.pass.guestName, unit: r.pass.unit.name, plateHint: q?.plate || undefined, verifyCode: q?.code },
        plate: patch.plate, plateFromPass: patch.plateFromPass,
        ...(patch.plate ? { region: me!.tenant.plate_regions[0] ?? flow.region, source: 'manual' as const } : {}),
        ...(patch.clearRead ? clearedRead : {}),
      });
      // Reveal the editable prefilled plate (keypad view) so the attendant can see and verify it, not just the banner.
      if (patch.plate) setCamera(false);
      setCode('');
    } catch (e) { setPassErr(e instanceof ApiError && e.code.startsWith('pass_') ? passReason(t, e.code, errText(e)) : errText(e)); }
  }

  /** A plate read on-device. Seen in several frames it goes straight to confirm; a single "Capture" read below the site threshold goes to review. */
  function onPlate(p: { text: string; confidence: number; votes: number; manual?: boolean }) {
    const norm = normalizePlate(p.text);
    const region = me!.tenant.plate_regions[0] ?? flow.region;
    const valid = matchesRegistry(p.text, me!.tenant.plate_regions);
    const threshold = site?.settings.aiThreshold ?? 0.85;
    // Live reads were already agreed by several frames, but they still need the site's confidence to skip review.
    const confident = valid && p.confidence >= threshold;
    set({ candidates: [{ text: p.text, norm, confidence: p.confidence, region, formatValid: valid }], plate: p.text, plateFromPass: false, confidence: p.confidence, textRaw: p.text, source: confident ? 'ai_auto' : 'ai_assist', vehicle: {} });
    nav(`${b}/checkin/${confident ? 'confirm' : 'review'}`);
  }

  /** Fallback when the on-device models are not installed: ask the server to read a still frame. */
  async function capture(image: string) {
    if (!site) return;
    setBusy(true); setErr('');
    try {
      const r = await request<AlprRes>('POST', '/v1/alpr/read', { site: site.code, image, region: flow.region });
      const top = r.candidates[0];
      set({ candidates: r.candidates, plate: top?.text ?? '', plateFromPass: false, confidence: top?.confidence, textRaw: top?.text, source: r.decision === 'auto' ? 'ai_auto' : 'ai_assist', vehicle: r.vehicle ?? {} });
      // Low confidence or a failed format check: the attendant picks or types; nothing saves until confirmed.
      const confident = top && top.confidence >= r.threshold && top.formatValid !== false;
      nav(`${b}/checkin/${confident ? 'confirm' : 'review'}`);
    } catch (e) { setErr(isNetworkError(e) ? t('att.offline') : errText(e)); setCamera(false); } finally { setBusy(false); }
  }

  return (
    <div className="att">
      <h1>{t('att.capture')}</h1>
      {flow.pass ? (
        <div className="banner" role="status" aria-live="polite" tabIndex={-1} ref={passBannerRef}>
          <strong>{t('att.passFor', { guest: flow.pass.guest, unit: flow.pass.unit })}</strong>
          {flow.pass.verifyCode && <div className="num" dir="ltr">{t('att.passVerified', { code: spaceCode(flow.pass.verifyCode) })}</div>}
          {flow.pass.plateHint && <div className="muted">{t('att.passPlateHint', { plate: flow.pass.plateHint })}</div>}
          <div><button type="button" className="btn" onClick={() => {
            // Removing a pass drops the plate that came from it (never leave pass A's plate to submit later), keeping a captured one.
            const patch = passRemovePatch({ plate: flow.plate, plateFromPass: flow.plateFromPass });
            set({ pass: null, plate: patch.plate, plateFromPass: patch.plateFromPass, ...(patch.clearRead ? clearedRead : {}) });
          }}>{t('att.passRemove')}</button></div>
        </div>
      ) : scanning ? (
        <Scanner onClose={() => setScanning(false)} onResult={(text) => { void usePass(text); }} />
      ) : (
        <section className="card stack">
          <button type="button" className="btn big" onClick={() => setScanning(true)}>{t('att.scanPass')}</button>
          <div className="row">
            <input className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('att.passCode')} aria-label={t('att.passCode')} dir="ltr" autoCapitalize="off" />
            <button type="button" className="btn" disabled={!code.trim()} onClick={() => { void usePass(code); }}>{t('att.passUse')}</button>
          </div>
          {passErr && <div className="banner bad" role="alert">{passErr}</div>}
        </section>
      )}
      {aiOn && <div className="row"><button className={`btn ${camera ? 'primary' : ''}`} onClick={() => setCamera(true)}>{t('att.camera')}</button><button data-mode="keypad" className={`btn ${!camera ? 'primary' : ''}`} onClick={() => setCamera(false)}>{t('att.keypad')}</button></div>}
      {camera ? (
        <>
          <LiveCamera regions={me!.tenant.plate_regions} qr={!flow.pass} busy={busy} onQr={(text) => { void usePass(text); }} onPlate={onPlate} onSnap={(img) => { void capture(img); }} />
        </>
      ) : (
        <>
          <label className="field">{t('att.region')}
            <select value={flow.region} onChange={(e) => set({ region: e.target.value })}>{[...new Set([...(me!.tenant.plate_regions), flow.region])].map((r) => <option key={r}>{r}</option>)}</select></label>
          <div className="platebox">{flow.plate ? <PlateChip plate={flow.plate} region={flow.region} size="xl" /> : <span className="muted">{t('att.plate')}</span>}</div>
          <Keypad region={flow.region} value={flow.plate} onChange={(v) => set({ plate: v, source: 'manual', candidates: [], plateFromPass: false })} />
          <button className="btn primary big" disabled={!flow.plate} onClick={() => nav(`${b}/checkin/confirm`)}>{t('common.next')}</button>
        </>
      )}
      {err && <div className="banner bad" role="alert">{err}</div>}
    </div>
  );
}

export function CheckInReview() {
  const t = useT();
  const nav = useNavigate();
  const { me } = useApp();
  const { flow, set } = useFlow();
  const fmt = useFormat();
  const b = base(me!.tenant.slug);
  return (
    <div className="att">
      <div className="banner warn">{t('att.lowConf')}</div>
      <h2>{t('att.candidates')}</h2>
      <div className="stack">{flow.candidates.map((c) => (
        <button key={c.norm} className="btn row between" onClick={() => { set({ plate: c.text, confidence: c.confidence, source: 'ai_assist', plateFromPass: false }); nav(`${b}/checkin/confirm`); }}>
          <PlateChip plate={c.text} region={c.region} size="lg" /><span className="muted">{t('att.confidence', { pct: fmt.percent(c.confidence) })}{c.formatValid === false ? ' ⚠' : ''}</span>
        </button>
      ))}</div>
      <h2>{t('att.keypad')}</h2>
      <div className="platebox"><PlateChip plate={flow.plate || '—'} region={flow.region} size="xl" /></div>
      <Keypad region={flow.region} value={flow.plate} onChange={(v) => set({ plate: v, source: 'manual', plateFromPass: false })} />
      <button className="btn primary big" disabled={!flow.plate} onClick={() => nav(`${b}/checkin/confirm`)}>{t('common.next')}</button>
    </div>
  );
}

/* ---------- check-in confirm ---------- */

interface Opened { session: { id: string; ticketCode: string }; slot: string; warnings: string[] }
const BODY = ['sedan', 'suv', 'pickup', 'van', 'motorcycle'];

function Ticket({ code }: { code: string }) { return <QrCode value={code} size={180} />; }

export function CheckInConfirm() {
  const t = useT();
  const nav = useNavigate();
  const { me, site } = useApp();
  const { flow, set, reset } = useFlow();
  const b = base(me!.tenant.slug);
  const [slot, setSlot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; code?: string; details?: Record<string, unknown> } | null>(null);
  const [done, setDone] = useState<Opened | 'queued' | null>(null);
  const idem = useRef(crypto.randomUUID()); // one key per confirm screen, so a retry never double-redeems
  const suggestion = useApi<{ slot: string | null; zone?: string }>(site ? `/v1/slots/suggest?site=${site.code}${flow.vehicle.bodyType ? `&bodyType=${flow.vehicle.bodyType}` : ''}` : null, [flow.vehicle.bodyType]);
  const v = (k: keyof FlowState['vehicle']) => ({ value: flow.vehicle[k] ?? '', onChange: (e: { target: { value: string } }) => set({ vehicle: { ...flow.vehicle, [k]: e.target.value || undefined } }) });

  async function confirm(slotCode?: string) {
    if (!site) return;
    setBusy(true); setErr(null);
    try {
      const body = {
        site: site.code, plate: { display: flow.plate, region: flow.region }, vehicle: flow.vehicle, slot: slotCode || slot || undefined, source: flow.source,
        read: flow.textRaw ? { textRaw: flow.textRaw, confidence: flow.confidence } : undefined,
      };
      if (flow.pass) {
        // A guest pass is validated by the server, so it is never queued offline.
        setDone(await post<Opened>('/v1/passes/redeem', { ...body, token: flow.pass.token }, idem.current));
      } else {
        const r = await write<Opened>('/v1/sessions', body);
        setDone(r.queued ? 'queued' : r.data);
      }
    } catch (e) {
      if (e instanceof ApiError) setErr({ message: e.code.startsWith('pass_') ? passReason(t, e.code, errText(e)) : errText(e), code: e.code, details: e.details as Record<string, unknown> });
      else setErr({ message: errText(e) });
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="att">
        {done === 'queued' ? <div className="banner warn">{t('att.queued')}</div> : (
          <>
            <div className="platebox"><PlateChip plate={flow.plate} region={flow.region} size="xl" /></div>
            <dl className="kv"><dt>{t('att.slot')}</dt><dd>{done.slot}</dd><dt>{t('att.ticket')}</dt><dd className="num">{done.session.ticketCode}</dd></dl>
            <Ticket code={done.session.ticketCode} />
            {done.warnings.length > 0 && <div className="banner warn">{done.warnings.join(', ')}</div>}
          </>
        )}
        <button className="btn primary big" onClick={() => { reset(); nav(b); }}>{t('att.done')}</button>
      </div>
    );
  }

  return (
    <div className="att">
      {flow.pass && <div className="banner">{t('att.passFor', { guest: flow.pass.guest, unit: flow.pass.unit })}</div>}
      <div className="platebox"><PlateChip plate={flow.plate} region={flow.region} size="xl" /></div>
      {flow.confidence != null && <div className="muted">{t('att.confidence', { pct: Math.round(flow.confidence * 100) + '%' })}</div>}
      <h2>{t('att.vehicle')}</h2>
      <div className="stack">
        <label className="field">{t('att.make')}<input {...v('make')} /></label>
        <label className="field">{t('att.model')}<input {...v('model')} /></label>
        <label className="field">{t('att.color')}<input {...v('color')} /></label>
        <label className="field">{t('att.body')}<select {...v('bodyType')}><option value="" />{BODY.map((x) => <option key={x} value={x}>{t(`body.${x}`)}</option>)}</select></label>
      </div>
      <h2>{t('att.suggested')}</h2>
      <label className="field">{t('att.slot')}
        <input value={slot} onChange={(e) => setSlot(e.target.value.toUpperCase())} placeholder={suggestion.data?.slot ?? t('att.nothingFree')} dir="ltr" /></label>
      {err && (
        <div className="banner bad" role="alert">
          {err.code === 'already_inside' ? t('att.inside', { time: new Date(String(err.details?.inAt)).toLocaleTimeString(), slot: String(err.details?.slot ?? '—') })
            : err.code === 'assigned_slot_taken' ? t('att.takenBy', { plate: String(err.details?.offender ?? '?') })
            : err.code === 'site_full' ? t('att.full') : err.message}
          {typeof err.details?.suggestion === 'string' && <div><button className="btn" onClick={() => confirm(err.details!.suggestion as string)}>{t('att.slot')} {String(err.details!.suggestion)}</button></div>}
        </div>
      )}
      <button className="btn primary big" disabled={busy} onClick={() => confirm()}>{t('att.confirm')}</button>
    </div>
  );
}

/* ---------- check-out ---------- */

interface Match {
  matched: boolean; method?: string;
  candidates?: { sessionId: string; ticketCode: string; plate: string; slot: string | null }[];
  session?: { id: string; ticketCode: string; inAt: string; inBy: string | null; outAt: string };
  vehicle?: { plate: string; make: string | null; model: string | null; color: string | null }; slot?: string | null;
  fee?: { minutes: number; total: number; tax: number; lines: { label: string; amount: number }[] };
}
type Pay = 'cash' | 'card' | 'account';

export function CheckOut() {
  const t = useT();
  const nav = useNavigate();
  const { me, site, can } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const [plate, setPlate] = useState('');
  const [ticket, setTicket] = useState('');
  const [m, setM] = useState<Match | null>(null);
  const [fuzzy, setFuzzy] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [pay, setPay] = useState<Pay>('cash');
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState<string | 'queued' | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const b = base(me!.tenant.slug);

  async function find(over?: { ticket?: string; plate?: string }, lostTicket = lost) {
    if (!site) return;
    setErr(''); setBusy(true);
    try {
      const body = { site: site.code, plate: over?.ticket ? undefined : over?.plate ?? (plate || undefined), ticket: over?.ticket ?? (ticket || undefined), region: me!.tenant.plate_regions[0], lostTicket: lostTicket || undefined };
      setM(await request<Match>('POST', '/v1/checkout/match', body));
    } catch (e) { setErr(isNetworkError(e) ? t('att.offline') : errText(e)); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!site || !m?.session) return;
    setBusy(true); setErr('');
    try {
      const r = await write<{ receipt: string }>('/v1/checkout', {
        site: site.code, confirmedSession: m.session.id, lostTicket: lost || undefined,
        payment: { method: pay, amount: m.fee!.total },
      });
      setReceipt(r.queued ? 'queued' : r.data.receipt);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  /** Offline: no fee preview is possible, so queue the check-out by plate and let the server price it on replay. */
  async function queueOffline() {
    if (!site) return;
    const r = await write('/v1/checkout', { site: site.code, plate: plate || undefined, ticket: ticket || undefined, payment: { method: pay, amount: 0 } });
    if (r.queued) setReceipt('queued');
  }

  if (receipt) {
    return (
      <div className="att">
        {receipt === 'queued' ? <div className="banner warn">{t('att.queued')}</div> : <div className="banner">{t('att.receipt', { no: receipt })}</div>}
        <button className="btn primary big" onClick={() => nav(b)}>{t('att.done')}</button>
      </div>
    );
  }

  if (m?.matched && m.session && m.fee) {
    const h = Math.floor(m.fee.minutes / 60), min = m.fee.minutes % 60;
    return (
      <div className="att">
        {fuzzy && <div className="banner warn">{t('att.confirmFuzzy')}</div>}
        <div className="platebox"><PlateChip plate={m.vehicle!.plate} size="xl" /></div>
        <dl className="kv">
          <dt>{t('att.slot')}</dt><dd>{m.slot ?? '—'}</dd>
          <dt>{t('att.entry')}</dt><dd>{fmt.dateTime(m.session.inAt)}</dd>
          <dt>{t('att.vehicle')}</dt><dd>{[m.vehicle!.make, m.vehicle!.model, m.vehicle!.color].filter(Boolean).join(' ') || '—'}</dd>
        </dl>
        <div className="muted">{t('att.checkedInBy', { name: m.session.inBy ?? '—', time: fmt.time(m.session.inAt) })}</div>
        <div className="muted">{t('att.duration', { hours: h, minutes: min })}</div>
        <section className="card">
          {m.fee.lines.map((l, i) => <div key={i} className="feeline"><span>{feeLabel(t, l.label)}</span><span className="num">{fmt.money(l.amount)}</span></div>)}
          <div className="feeline"><strong>{t('att.fee')}</strong><span className="feetotal num">{fmt.money(m.fee.total)}</span></div>
        </section>
        {can('override') && <label className="row"><input type="checkbox" checked={lost} onChange={(e) => { setLost(e.target.checked); void find({ ticket: m.session!.ticketCode }, e.target.checked); }} />{t('att.lost')}</label>}
        <div className="row">{(['cash', 'card', 'account'] as const).map((p) => <button key={p} className={`btn grow ${pay === p ? 'primary' : ''}`} onClick={() => setPay(p)}>{t(`att.${p}`)}</button>)}</div>
        {err && <div className="banner bad" role="alert">{err}</div>}
        <button className="btn primary big" disabled={busy} onClick={confirm}>{t('att.pay')} · {fmt.money(m.fee.total)}</button>
        <button className="btn" onClick={() => { setM(null); setFuzzy(null); }}>{t('common.back')}</button>
      </div>
    );
  }

  return (
    <div className="att">
      <h1>{t('att.checkout')}</h1>
      {scanning ? (
        <>
          <LiveCamera regions={me!.tenant.plate_regions} plate={me!.tenant.ai_mode !== 'off'} busy={busy}
            onQr={(text) => { const tk = text.trim().toUpperCase(); setScanning(false); setTicket(tk); void find({ ticket: tk }); }}
            onPlate={(p) => { setScanning(false); const txt = normalizePlate(p.text); setPlate(txt); void find({ plate: txt }); }} />
          <button type="button" className="btn" onClick={() => setScanning(false)}>{t('att.stopScan')}</button>
        </>
      ) : <button type="button" className="btn big" onClick={() => setScanning(true)}>{t('att.scanQr')}</button>}
      <label className="field">{t('att.scanTicket')}<input value={ticket} onChange={(e) => setTicket(e.target.value.toUpperCase())} dir="ltr" autoCapitalize="characters" /></label>
      <div className="muted" style={{ textAlign: 'center' }}>{t('att.orPlate')}</div>
      <label className="field">{t('att.plate')}<input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} dir="ltr" autoCapitalize="characters" /></label>
      {m && !m.matched && (
        <div className="stack">
          <div className="banner warn">{t('att.noMatch')}</div>
          {!!m.candidates?.length && <h2>{t('att.didYouMean')}</h2>}
          {m.candidates?.map((c) => (
            <button key={c.sessionId} className="btn row between" onClick={() => { setFuzzy(c.sessionId); void find({ ticket: c.ticketCode }); }}>
              <PlateChip plate={c.plate} size="lg" /><span className="muted">{c.slot}</span>
            </button>
          ))}
        </div>
      )}
      {err && <div className="banner bad" role="alert">{err}{!navigator.onLine && (plate || ticket) && <div><button className="btn" onClick={queueOffline}>{t('att.queued')}</button></div>}</div>}
      <button className="btn primary big" disabled={busy || (!plate && !ticket)} onClick={() => find()}>{t('att.find')}</button>
      <Link to={b}>{t('common.back')}</Link>
    </div>
  );
}

export { get };
