import { PlateChip } from '@openpark/ui';
import { Suspense, createContext, lazy, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, get, isNetworkError, post, request, write } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { LiveCamera } from '../components/LiveCamera.js';
import { matchesRegistry, normalizePlate } from '../alpr/plates.js';
import { parsePassQr, spaceCode } from '../pass.js';
import { applyPassAccept, applyPassError, applyPassRemove, beginPassLookup, canConfirm, capacityBar, clearPassError, emptyFlow, isStalePassLookup, type Candidate, type FlowState } from '../attendant-flow.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';
import { errText } from '../errors.js';
import { feeLabel, passReason } from '../labels.js';

/* ---------- small shared UI primitives ---------- */

/** A button-driven disclosure region (not <details>, so open state can be driven from router/props). */
function Collapsible({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="collapsible">
      <h2>
        <button type="button" className="disclosure" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true" className="chevron">{open ? '▾' : '▸'}</span> {title}
        </button>
      </h2>
      <div id={id} hidden={!open}>{open && children}</div>
    </section>
  );
}

/** Two-tab Camera / Manual Entry control. Defaults to Camera; the active tab's panel is rendered by the caller. */
function Tabs({ tab, onTab, labels }: { tab: 'camera' | 'manual'; onTab: (t: 'camera' | 'manual') => void; labels: { camera: string; manual: string } }) {
  return (
    <div className="tabs" role="tablist">
      {(['camera', 'manual'] as const).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => onTab(k)}>{labels[k]}</button>
      ))}
    </div>
  );
}

// The QR decoder is only needed once someone taps Scan, so it stays out of the main bundle.
const QrScanner = lazy(() => import('../components/QrScanner.js').then((m) => ({ default: m.QrScanner })));
const Scanner = (props: { onResult: (text: string) => void; onClose: () => void }) => <Suspense fallback={<div className="muted">…</div>}><QrScanner {...props} /></Suspense>;

/* ---------- shared check-in state ---------- */

const FlowCtx = createContext<{
  flow: FlowState;
  /** Merge a fixed patch (for synchronous edits like the keypad). */
  set: (f: Partial<FlowState>) => void;
  /** Merge a patch computed from the LATEST state — use this for anything that lands after an await, so a concurrent camera read is never overwritten by a stale snapshot. */
  update: (fn: (s: FlowState) => Partial<FlowState>) => void;
  /**
   * The monotonically increasing pass-lookup generation. It lives HERE, above the nested check-in routes, so it
   * survives CheckInCapture remounts (capture → confirm → "edit plate" → capture). A ref owned by the capture screen
   * would reset to 0 on every remount, letting an older in-flight lookup compare as current and overwrite a newer
   * pass; keeping it on the persistent Flow makes "newest scan wins" hold across the whole flow lifecycle.
   */
  passSeq: { current: number };
  reset: () => void;
}>(null as never);
export const useFlow = () => useContext(FlowCtx);

export function Flow({ children }: { children: ReactNode }) {
  const me = useApp()?.me;
  const region0 = me?.tenant.plate_regions[0] ?? 'US';
  const [flow, setFlow] = useState<FlowState>(emptyFlow(region0));
  const passSeq = useRef(0);
  const value = useMemo(() => ({
    flow,
    passSeq,
    set: (f: Partial<FlowState>) => setFlow((s) => ({ ...s, ...f })),
    update: (fn: (s: FlowState) => Partial<FlowState>) => setFlow((s) => ({ ...s, ...fn(s) })),
    // Starting a fresh flow also retires any lookup still in flight, so a late response cannot reattach a pass to it.
    reset: () => { passSeq.current++; setFlow(emptyFlow(region0)); },
  }), [flow, region0]);
  return <FlowCtx.Provider value={value}>{children}</FlowCtx.Provider>;
}

const base = (slug: string) => `/t/${slug}/a`;

/* ---------- home ---------- */

interface Occ {
  totals: { free: number; occupied: number; reserved: number; outOfService: number };
  issuedPending: number; over10: number; over12: number;
  breakdown: { zone: string; zone_name: string; type: string; free: number }[];
}
interface Row { id: string; status: 'open' | 'closed' | 'void'; ticket_code: string; plate: string; slot: string | null; unit: string | null; in_at: string; out_at: string | null; fee: number | null }

/**
 * The gate capacity bar: N light-gray segments (every assignable slot), green for checked-in, yellow for logged but
 * not-yet-checked-in passes, with over-10h (orange) / over-12h (red) overlay stripes on the rightmost green segments.
 * Colour is never the only signal: a legend with text + patterns and an aria summary carry the same information.
 */
function CapacityBar({ occ }: { occ: Occ }) {
  const t = useT();
  const fmt = useFormat();
  const n = occ.totals.free + occ.totals.occupied + occ.totals.reserved;
  const bar = capacityBar({ n, occupied: occ.totals.occupied, issuedPending: occ.issuedPending, over10: occ.over10, over12: occ.over12 });
  const summary = t('att.capacityAria', { occupied: occ.totals.occupied, n, pending: occ.issuedPending, over10: occ.over10, over12: occ.over12 });
  // Build the N segments. Green segments that fall in the over-10/over-12 tail carry the overlay class.
  const segs: ('green' | 'yellow' | 'free')[] = [];
  for (let i = 0; i < bar.green; i++) segs.push('green');
  for (let i = 0; i < bar.yellow; i++) segs.push('yellow');
  for (let i = 0; i < bar.free; i++) segs.push('free');
  const over = (idx: number): '' | 'over10' | 'over12' => {
    // Overlays mark the rightmost GREEN segments; RED (>12h) takes precedence over ORANGE (>10h).
    const fromEnd = bar.green - idx; // 1-based distance from the end of the green run
    if (idx >= bar.green) return '';
    if (fromEnd <= bar.over12) return 'over12';
    if (fromEnd <= bar.over10) return 'over10';
    return '';
  };
  return (
    <section className="capwrap">
      {n === 0 ? (
        <div className="capbar empty" role="img" aria-label={t('att.capacityNone')}><span className="muted">{t('att.capacityNone')}</span></div>
      ) : (
        <div className="capbar" role="img" aria-label={summary} style={{ ['--n' as string]: n }}>
          {segs.map((s, i) => {
            const o = over(i);
            return <span key={i} className={`capseg ${s} ${o}`} data-over={o || undefined} aria-hidden="true" />;
          })}
        </div>
      )}
      <div className="caplegend" aria-hidden="true">
        <span className="legend green">{t('att.legendOccupied', { n: occ.totals.occupied })}</span>
        <span className="legend yellow">{t('att.legendPending', { n: occ.issuedPending })}</span>
        <span className="legend free">{t('att.legendFree', { n: bar.free })}</span>
        {occ.over10 > 0 && <span className="legend over10">{t('att.legendOver10', { n: occ.over10 })}</span>}
        {occ.over12 > 0 && <span className="legend over12">{t('att.legendOver12', { n: occ.over12 })}</span>}
      </div>
      <p className="muted capcaption">
        {t('att.capacityCaption', { occupied: occ.totals.occupied, n })}
        {bar.pendingSurplus > 0 && ` · ${t('att.capacityPendingSurplus', { n: bar.pendingSurplus })}`}
      </p>
    </section>
  );
}

function ActivityRow({ r }: { r: Row }) {
  const t = useT();
  const nav = useNavigate();
  const { me, site } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const b = base(me!.tenant.slug);
  return (
    <div className="card row between">
      <div className="row"><PlateChip plate={r.plate} />{r.unit && <span className="pill">{r.unit}</span>}</div>
      <span className="muted">{r.slot ?? '—'} · {fmt.time(r.out_at ?? r.in_at)}</span>
      {r.status === 'open'
        ? <button type="button" className="btn" onClick={() => nav(`${b}/checkout`, { state: { ticket: r.ticket_code } })}>{t('att.checkout')}</button>
        : <span className="muted num">{r.fee != null ? fmt.money(r.fee) : '—'}</span>}
    </div>
  );
}

function RecentActivity() {
  const t = useT();
  const { site } = useApp();
  const [sort, setSort] = useState<'in_at_desc' | 'unit'>('in_at_desc');
  const [q, setQ] = useState('');
  const query = useMemo(() => {
    if (!site) return null;
    const p = new URLSearchParams({ site: site.code, limit: '20', sort });
    if (q.trim()) p.set('q', q.trim());
    return `/v1/sessions?${p.toString()}`;
  }, [site?.code, sort, q]);
  const recent = useApi<{ items: Row[] }>(query, [query]);
  useLiveEvents(() => { void recent.reload(); });
  return (
    <>
      <div className="row">
        <label className="field grow">{t('att.sortBy')}
          <select value={sort} onChange={(e) => setSort(e.target.value as 'in_at_desc' | 'unit')}>
            <option value="in_at_desc">{t('att.sortInAt')}</option>
            <option value="unit">{t('att.sortUnit')}</option>
          </select>
        </label>
        <label className="field grow">{t('att.searchActivity')}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('att.searchHint')} autoCapitalize="characters" />
        </label>
      </div>
      <div className="stack">
        {recent.data?.items.length === 0 && <div className="muted">{t('att.noActivity')}</div>}
        {recent.data?.items.map((r) => <ActivityRow key={r.id} r={r} />)}
      </div>
    </>
  );
}

export function AttendantHome() {
  const t = useT();
  const nav = useNavigate();
  const { me, site } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const occ = useApi<Occ>(site ? `/v1/occupancy?site=${site.code}` : null, [site?.code]);
  useLiveEvents(() => { void occ.reload(); });
  const b = base(me!.tenant.slug);
  return (
    <div className="att">
      <div className="row">
        <button className="btn primary big grow" onClick={() => nav(`${b}/checkin`)}>{t('att.checkin')}</button>
        <button className="btn big grow" onClick={() => nav(`${b}/checkout`)}>{t('att.checkout')}</button>
      </div>
      <div className="card tile"><div className="label">{t('att.freeNow')}</div><div className="value" style={{ fontSize: '3rem' }}>{occ.data ? fmt.number(occ.data.totals.free) : '–'}</div></div>
      {occ.data && <CapacityBar occ={occ.data} />}
      <Collapsible title={t('att.recent')} defaultOpen={false}><RecentActivity /></Collapsible>
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
  const { flow, set, update, passSeq } = useFlow();
  const aiOn = me!.tenant.ai_mode !== 'off';
  // Two tabs (Camera / Manual Entry), defaulting to Camera even when AI plate reading is off: the Camera tab then
  // shows the QR scanner plus an AI-off note, and Manual Entry stays the working path.
  const [tab, setTab] = useState<'camera' | 'manual'>('camera');
  const camera = tab === 'camera';
  const setCamera = (on: boolean) => setTab(on ? 'camera' : 'manual');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = base(me!.tenant.slug);
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const passBannerRef = useRef<HTMLDivElement>(null);
  const passErrRef = useRef<HTMLDivElement>(null);

  // When a pass is accepted, move focus to its banner so keyboard and screen-reader users land on the result and hear it.
  useEffect(() => { if (flow.pass) passBannerRef.current?.focus(); }, [flow.pass?.token]);
  // A rejected scan likewise takes focus, so a keyboard/screen-reader attendant lands on the failure, not past it.
  useEffect(() => { if (flow.passError) passErrRef.current?.focus(); }, [flow.passError]);

  /** Look a scanned or typed pass up before taking the plate, so a bad QR is caught at the gate, not after. */
  async function usePass(raw: string) {
    const token = raw.trim();
    setScanning(false);
    if (!token) return;
    // The QR carries the guest, unit, plate hint and expiry, so an expired or foreign code is rejected before any round trip.
    const q = parsePassQr(token);
    // Claim the latest generation BEFORE anything else — including the local wrong-site rejection below. This newest
    // scan owns the pending state, so any earlier lookup still in flight is now stale and cannot win when it resolves,
    // even if this scan is rejected locally without a round trip.
    const mySeq = ++passSeq.current;
    // Expiry is the server's call: this phone's clock may be wrong, and a wrong clock must not turn a valid guest away.
    if (q && site && q.site !== site.code) {
      // Persist the rejection (as the latest scan, this owns the state) so it is shown and blocks confirm until acknowledged.
      update(() => applyPassError(t('pass.reason_pass_wrong_site')));
      return;
    }
    // Mark the lookup in flight so Confirm stays disabled until it settles: a concurrent camera plate read may have
    // navigated to confirm already, and the attendant must not submit the walk-in branch while a valid pass is resolving.
    update(beginPassLookup);
    try {
      const r = await get<{ valid: boolean; reason: string | null; pass: { guestName: string; unit: { name: string } } }>(`/v1/passes/lookup?token=${encodeURIComponent(token)}`);
      if (isStalePassLookup(mySeq, passSeq.current)) return; // a newer scan superseded this one; it owns the pending state
      // A rejection is PERSISTED on the flow, not in this (possibly-unmounted) screen: if a camera plate read already
      // navigated to Confirm, the failure still shows there and still blocks the walk-in until it is acknowledged.
      if (!r.valid) { update(() => applyPassError(passReason(t, r.reason ?? 'pass_invalid'))); return; }
      // Apply the pass against the LATEST flow state, because this lands after an await and a live camera read may have
      // filled the plate in the meantime: a hinted pass pre-fills the plate (keypad/camera stay available to correct it);
      // a no-hint pass clears a plate left over from a PREVIOUS pass but keeps one the attendant captured independently.
      update((s) => applyPassAccept(s, { token, guest: r.pass.guestName, unit: r.pass.unit.name, q, regions: me!.tenant.plate_regions }));
      // A hinted pass reveals the editable prefilled plate (keypad view) so the attendant sees and verifies it, not just the banner.
      if (q?.plate) setCamera(false);
      setCode('');
    } catch (e) {
      if (isStalePassLookup(mySeq, passSeq.current)) return;
      update(() => applyPassError(e instanceof ApiError && e.code.startsWith('pass_') ? passReason(t, e.code, errText(e)) : errText(e)));
    }
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
          <div><button type="button" className="btn" onClick={() => { passSeq.current++; update(applyPassRemove); }}>{t('att.passRemove')}</button></div>
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
        </section>
      )}
      {flow.passError && (
        <div className="banner bad" role="alert" tabIndex={-1} ref={passErrRef}>
          <div>{flow.passError}</div>
          <div><button type="button" className="btn" onClick={() => update(clearPassError)}>{t('att.passDismiss')}</button></div>
        </div>
      )}
      <Tabs tab={tab} onTab={setTab} labels={{ camera: t('att.camera'), manual: t('att.manualEntry') }} />
      {camera ? (
        <>
          {!aiOn && <div className="banner">{t('att.cameraAiOff')}</div>}
          <LiveCamera regions={me!.tenant.plate_regions} qr={!flow.pass} plate={aiOn} busy={busy} onQr={(text) => { void usePass(text); }} onPlate={onPlate} onSnap={(img) => { void capture(img); }} />
        </>
      ) : (
        <>
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
interface UnitRow { code: string; name: string }
type HostValue = { unit: string } | { name: string; phone: string } | null;

function Ticket({ code }: { code: string }) { return <QrCode value={code} size={180} />; }

/**
 * Who authorizes a walk-in: a type-ahead over the site's community units, plus an "Other" option that captures a
 * name + E.164 phone. For a pass redemption the host is fixed read-only to the pass's unit.
 */
function HostControl({ fixedUnit, onChange }: { fixedUnit?: string; onChange: (v: HostValue) => void }) {
  const t = useT();
  const { site } = useApp();
  const units = useApi<UnitRow[]>(site && !fixedUnit ? `/v1/units?site=${site.code}` : null, [site?.code, fixedUnit]);
  const [query, setQuery] = useState('');
  const [other, setOther] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const listId = useId();

  // A pass redemption fixes the host to the pass's unit; the control is read-only.
  if (fixedUnit) return <label className="field">{t('att.host')}<input value={fixedUnit} readOnly aria-readonly="true" /></label>;

  const matches = (units.data ?? []).filter((u) => `${u.code} ${u.name}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8);
  const pickUnit = (code: string) => { setOther(false); setQuery(code); onChange({ unit: code }); };
  const toggleOther = () => {
    const next = !other; setOther(next);
    if (next) { setQuery(''); onChange(name && phone ? { name, phone } : null); } else onChange(null);
  };
  const setOtherField = (field: 'name' | 'phone', value: string) => {
    const nm = field === 'name' ? value : name; const ph = field === 'phone' ? value : phone;
    if (field === 'name') setName(value); else setPhone(value);
    onChange(nm && ph ? { name: nm, phone: ph } : null);
  };

  return (
    <div className="stack">
      <div className="row between">
        <label className="field grow">{t('att.host')}
          <input role="combobox" aria-expanded={!other && matches.length > 0} aria-controls={listId} aria-autocomplete="list"
            value={query} disabled={other} onChange={(e) => { setQuery(e.target.value); onChange(null); }} placeholder={t('att.hostSearch')} />
        </label>
        <label className="row"><input type="checkbox" checked={other} onChange={toggleOther} /> {t('att.hostOther')}</label>
      </div>
      {!other && query.trim() && (
        <ul id={listId} role="listbox" className="stack autolist">
          {matches.length === 0 && <li className="muted">{t('att.hostNoMatch')}</li>}
          {matches.map((u) => (
            <li key={u.code} role="option" aria-selected={false}>
              <button type="button" className="btn row between" onClick={() => pickUnit(u.code)}><span>{u.code}</span><span className="muted">{u.name}</span></button>
            </li>
          ))}
        </ul>
      )}
      {other && (
        <div className="stack">
          <label className="field">{t('att.hostName')}<input value={name} onChange={(e) => setOtherField('name', e.target.value)} /></label>
          <label className="field">{t('att.hostPhone')}<input value={phone} onChange={(e) => setOtherField('phone', e.target.value)} placeholder="+525512345678" dir="ltr" inputMode="tel" /></label>
        </div>
      )}
    </div>
  );
}

interface SlotRow { code: string; zone: string; type: string; status: string }

/** The assigned-slot picker: a button showing the suggested slot that opens a list of free slots to override it. */
function SlotPicker({ suggested, value, onPick }: { suggested: string | null; value: string; onPick: (code: string) => void }) {
  const t = useT();
  const { site } = useApp();
  const [open, setOpen] = useState(false);
  const free = useApi<SlotRow[]>(site && open ? `/v1/slots?site=${site.code}&status=available` : null, [site?.code, open]);
  const shown = value || suggested || t('att.nothingFree');
  return (
    <div className="stack">
      <button type="button" className="btn row between" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{t('att.slot')}: <strong>{shown}</strong></span><span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul role="listbox" className="stack autolist slotlist">
          {free.data?.length === 0 && <li className="muted">{t('att.nothingFree')}</li>}
          {free.data?.map((s) => (
            <li key={s.code} role="option" aria-selected={s.code === value}>
              <button type="button" className="btn row between" onClick={() => { onPick(s.code); setOpen(false); }}><span>{s.code}</span><span className="muted">{s.zone}</span></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CheckInConfirm() {
  const t = useT();
  const nav = useNavigate();
  const { me, site } = useApp();
  const { flow, set, update, reset } = useFlow();
  const b = base(me!.tenant.slug);
  const [slot, setSlot] = useState('');
  const [host, setHost] = useState<HostValue>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; code?: string; details?: Record<string, unknown> } | null>(null);
  const [done, setDone] = useState<Opened | 'queued' | null>(null);
  const idem = useRef(crypto.randomUUID()); // one key per confirm screen, so a retry never double-redeems
  const passErrRef = useRef<HTMLDivElement>(null);
  // A scan that rejected after a camera read navigated here takes focus, so a keyboard/screen-reader attendant
  // lands on the failure (and the acknowledge control) instead of past it, mirroring the capture screen.
  useEffect(() => { if (flow.passError) passErrRef.current?.focus(); }, [flow.passError]);
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
        // A guest pass is validated by the server, so it is never queued offline. The host is the pass's unit; the
        // server never trusts a client-supplied host for a redemption, so none is sent.
        setDone(await post<Opened>('/v1/passes/redeem', { ...body, token: flow.pass.token }, idem.current));
      } else {
        const r = await write<Opened>('/v1/sessions', { ...body, host: host ?? undefined });
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
      <h2>{t('att.hostHeading')}</h2>
      <HostControl fixedUnit={flow.pass?.unit} onChange={setHost} />
      <h2>{t('att.vehicle')}</h2>
      <div className="row">
        <label className="field grow">{t('att.make')}<input {...v('make')} /></label>
        <label className="field grow">{t('att.model')}<input {...v('model')} /></label>
        <label className="field grow">{t('att.year')}
          <input type="number" inputMode="numeric" min={1900} max={new Date().getFullYear() + 1} value={flow.vehicle.year ?? ''}
            onChange={(e) => { const n = e.target.value ? Number(e.target.value) : undefined; set({ vehicle: { ...flow.vehicle, year: Number.isFinite(n) ? n : undefined } }); }} /></label>
      </div>
      <div className="row">
        <label className="field grow">{t('att.color')}<input {...v('color')} /></label>
        <label className="field grow">{t('att.body')}<select {...v('bodyType')}><option value="" />{BODY.map((x) => <option key={x} value={x}>{t(`body.${x}`)}</option>)}</select></label>
      </div>
      <h2>{t('att.suggested')}</h2>
      <SlotPicker suggested={suggestion.data?.slot ?? null} value={slot} onPick={(code) => setSlot(code)} />
      {err && (
        <div className="banner bad" role="alert">
          {err.code === 'already_inside' ? t('att.inside', { time: new Date(String(err.details?.inAt)).toLocaleTimeString(), slot: String(err.details?.slot ?? '—') })
            : err.code === 'assigned_slot_taken' ? t('att.takenBy', { plate: String(err.details?.offender ?? '?') })
            : err.code === 'site_full' ? t('att.full') : err.message}
          {typeof err.details?.suggestion === 'string' && <div><button className="btn" onClick={() => confirm(err.details!.suggestion as string)}>{t('att.slot')} {String(err.details!.suggestion)}</button></div>}
        </div>
      )}
      {flow.passPending && <div className="banner" role="status" aria-live="polite">{t('att.passChecking')}</div>}
      {/* A scan that rejected AFTER a camera plate read navigated here stays visible and blocks the walk-in: the
          attendant must acknowledge (return to scan) before an ordinary check-in can be submitted. */}
      {flow.passError && (
        <div className="banner bad" role="alert" tabIndex={-1} ref={passErrRef}>
          <div>{flow.passError}</div>
          <div><button type="button" className="btn" onClick={() => { update(clearPassError); nav(`${b}/checkin`); }}>{t('att.passDismiss')}</button></div>
        </div>
      )}
      {!flow.passPending && !flow.passError && !flow.plate && <div className="banner warn" role="alert">{t('att.needPlate')}</div>}
      <button className="btn primary big" disabled={!canConfirm(flow, busy)} onClick={() => confirm()}>{t('att.confirm')}</button>
      <button type="button" className="btn" onClick={() => nav(`${b}/checkin`)}>{t('att.editPlate')}</button>
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

interface OpenRow { id: string; ticket_code: string; plate: string; slot: string | null; in_at: string }

/** A floating on-screen keyboard that animates up from the bottom; keyboard-operable and dismissible (Esc + close). */
function BottomSheetKeypad({ value, onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet" role="dialog" aria-modal="false" aria-label={t('att.keyboard')}>
      <div className="sheet-head row between">
        <span className="muted">{t('att.keyboard')}</span>
        <button type="button" className="btn" onClick={onClose} aria-label={t('att.keyboardClose')}>✕</button>
      </div>
      <Keypad value={value} onChange={onChange} />
    </div>
  );
}

/** Check-out Manual Entry: a plate autocomplete over open sessions (longest stay first). The ticket is internal only. */
function PlateAutocomplete({ open, busy, onSelect }: { open: OpenRow[]; busy: boolean; onSelect: (ticket: string) => void }) {
  const t = useT();
  const { me, site } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const listId = useId();
  const norm = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const matches = open.filter((o) => o.plate.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(norm));
  const dur = (inAt: string) => { const min = Math.max(0, Math.round((Date.now() - new Date(inAt).getTime()) / 60000)); return t('att.duration', { hours: Math.floor(min / 60), minutes: min % 60 }); };
  const choose = (o: OpenRow) => { setQuery(o.plate); setActive(-1); setSheet(false); onSelect(o.ticket_code); };
  const onKeyDown = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && active >= 0 && matches[active]) { e.preventDefault(); choose(matches[active]); }
  };
  const optId = (i: number) => `${listId}-opt-${i}`;
  return (
    <div className="stack">
      <label className="field">{t('att.plate')}
        <input role="combobox" aria-autocomplete="list" aria-expanded={matches.length > 0} aria-controls={listId}
          aria-activedescendant={active >= 0 ? optId(active) : undefined}
          value={query} dir="ltr" autoCapitalize="characters" onFocus={() => setSheet(true)} onKeyDown={onKeyDown}
          onChange={(e) => { setQuery(e.target.value.toUpperCase()); setActive(-1); }} />
      </label>
      {open.length === 0 ? <div className="muted">{t('att.noneParked')}</div> : (
        <ul id={listId} role="listbox" className="stack autolist" aria-label={t('att.plate')}>
          {matches.map((o, i) => (
            <li key={o.id} id={optId(i)} role="option" aria-selected={i === active}>
              <button type="button" className={`btn row between ${i === active ? 'primary' : ''}`} onClick={() => choose(o)}>
                <PlateChip plate={o.plate} /><span className="muted">{o.slot ?? '—'} · {dur(o.in_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sheet && <BottomSheetKeypad value={query} onChange={(v) => { setQuery(v); setActive(-1); }} onClose={() => setSheet(false)} />}
      {busy && <div className="muted">{t('common.loading')}</div>}
    </div>
  );
}

export function CheckOut() {
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  const { me, site, can } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const [tab, setTab] = useState<'camera' | 'manual'>('camera');
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
  // The Manual Entry autocomplete lists currently-parked cars, oldest first (longest stay first).
  const openSessions = useApi<{ items: OpenRow[] }>(site && tab === 'manual' ? `/v1/sessions?site=${site.code}&status=open&sort=in_at_asc&limit=200` : null, [site?.code, tab]);

  // A quick-checkout link from Recent Activity carries the session ticket in router state: resolve it on mount.
  const fromState = (loc.state as { ticket?: string } | null)?.ticket;
  useEffect(() => { if (fromState) { setTab('manual'); void find({ ticket: fromState }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        <h1>{t('att.leavingTitle')}</h1>
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
        <button className="btn primary big" disabled={busy} onClick={confirm}>{t('att.confirmLeaving')} · {fmt.money(m.fee.total)}</button>
        <button className="btn" onClick={() => { setM(null); setFuzzy(null); }}>{t('common.back')}</button>
      </div>
    );
  }

  return (
    <div className="att">
      <h1>{t('att.checkout')}</h1>
      <Tabs tab={tab} onTab={setTab} labels={{ camera: t('att.camera'), manual: t('att.manualEntry') }} />
      {tab === 'camera' ? (
        <>
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
          <button className="btn primary big" disabled={busy || (!plate && !ticket)} onClick={() => find()}>{t('att.find')}</button>
        </>
      ) : (
        <PlateAutocomplete open={openSessions.data?.items ?? []} busy={busy || openSessions.loading} onSelect={(tk) => { setTicket(tk); void find({ ticket: tk }); }} />
      )}
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
      <Link to={b}>{t('common.back')}</Link>
    </div>
  );
}

export { get };
