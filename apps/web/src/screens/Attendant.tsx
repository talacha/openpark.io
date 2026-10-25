import { PlateChip } from '@openpark/ui';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, get, isNetworkError, post, request, write } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { LiveCamera } from '../components/LiveCamera.js';
import { PlateInput } from '../components/PlateInput.js';
import { matchesRegistry, normalizePlate } from '../alpr/plates.js';
import { parsePassQr, spaceCode } from '../pass.js';
import { applyPassAccept, applyPassError, applyPassRemove, beginPassLookup, canConfirm, capacityBar, clearPassError, emptyFlow, hostValid, isStalePassLookup, type Candidate, type FlowState, type HostValue } from '../attendant-flow.js';
import { useApi, useLiveEvents } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { useFormat, useT } from '../i18n.js';
import { errText } from '../errors.js';
import { feeLabel, passReason } from '../labels.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible as CollapsibleRoot, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** A button-driven disclosure region (not <details>, so open state can be driven from router/props). */
function Collapsible({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <CollapsibleRoot open={open} onOpenChange={setOpen} className="collapsible">
      <h2>
        <CollapsibleTrigger render={<Button type="button" variant="ghost" className="disclosure" aria-controls={id} />}>
          <span aria-hidden="true" className="chevron">{open ? '▾' : '▸'}</span> {title}
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent id={id}>{children}</CollapsibleContent>
    </CollapsibleRoot>
  );
}

/**
 * Camera / Manual Entry switch. This is an ordinary toggle-button GROUP, not an ARIA tabs widget: each button is a
 * normal tab-stop with `aria-pressed`, so keyboard traversal is the standard Tab/Space with no roving-focus or
 * Left/Right contract to half-implement. The active panel is rendered by the caller below the group.
 */
function Tabs({ tab, onTab, labels, label }: { tab: 'camera' | 'manual'; onTab: (t: 'camera' | 'manual') => void; labels: { camera: string; manual: string }; label: string }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {(['camera', 'manual'] as const).map((k) => (
        <Button key={k} type="button" aria-pressed={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => onTab(k)}>{labels[k]}</Button>
      ))}
    </div>
  );
}

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
    <Card className="card row between">
      <div className="row"><PlateChip plate={r.plate} />{r.unit && <Badge className="pill">{r.unit}</Badge>}</div>
      <span className="muted">{r.slot ?? t('common.none')} · {fmt.time(r.out_at ?? r.in_at)}</span>
      {r.status === 'open'
        ? <Button type="button" className="btn" onClick={() => nav(`${b}/checkout`, { state: { ticket: r.ticket_code } })}>{t('att.checkout')}</Button>
        : <span className="muted num">{r.fee != null ? fmt.money(r.fee) : t('common.none')}</span>}
    </Card>
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
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as 'in_at_desc' | 'unit')}>
            <option value="in_at_desc">{t('att.sortInAt')}</option>
            <option value="unit">{t('att.sortUnit')}</option>
          </NativeSelect>
        </label>
        <label className="field grow">{t('att.searchActivity')}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('att.searchHint')} autoCapitalize="characters" />
        </label>
      </div>
      <div className="stack">
        <QueryState loading={recent.loading} error={recent.error} empty={!recent.data?.items.length} emptyLabel={t('att.noActivity')} />
        {!recent.loading && !recent.error && recent.data?.items.map((r) => <ActivityRow key={r.id} r={r} />)}
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
        <Button className="btn primary big grow" onClick={() => nav(`${b}/checkin`)}>{t('att.checkin')}</Button>
        <Button className="btn big grow" onClick={() => nav(`${b}/checkout`)}>{t('att.checkout')}</Button>
      </div>
      <QueryState loading={occ.loading} error={occ.error} empty={false} />
      <Card className="card tile"><div className="label">{t('att.freeNow')}</div><div className="value" style={{ fontSize: '3rem' }}>{occ.data ? fmt.number(occ.data.totals.free) : '–'}</div></Card>
      {occ.data && <CapacityBar occ={occ.data} />}
      <Collapsible title={t('att.recent')} defaultOpen={false}><RecentActivity /></Collapsible>
    </div>
  );
}

const KEY_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'] as const;

/**
 * On-screen plate keyboard: digits, then QWERTY rows (with Ñ), and a last row of Z..M plus Delete and a clear (✕) key.
 * Plates are always typed left-to-right whatever the interface language.
 */
function Keypad({ value, onChange }: { region?: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const key = (c: string) => <Button key={c} type="button" onClick={() => onChange(value + c)} aria-label={c}>{c}</Button>;
  return (
    <div className="keypad" dir="ltr" role="group" aria-label={t('att.keypad')}>
      {KEY_ROWS.slice(0, 3).map((row) => <div className="keyrow" key={row}>{[...row].map(key)}</div>)}
      <div className="keyrow">
        {[...KEY_ROWS[3]].map(key)}
        <Button type="button" className="key-delete" onClick={() => onChange(value.slice(0, -1))} aria-label={t('att.keyDelete')}>⌫</Button>
        <Button type="button" className="key-clear" onClick={() => onChange('')} aria-label={t('att.keyClear')}>✕</Button>
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
  // One field for both capture kinds: a plate or a guest-pass code, typed, keyed or scanned.
  const [entry, setEntry] = useState('');
  const passBannerRef = useRef<HTMLDivElement>(null);
  const passErrRef = useRef<HTMLDivElement>(null);

  // When a pass is accepted, move focus to its banner so keyboard and screen-reader users land on the result and hear it.
  useEffect(() => { if (flow.pass) passBannerRef.current?.focus(); }, [flow.pass?.token]);
  // A rejected scan likewise takes focus, so a keyboard/screen-reader attendant lands on the failure, not past it.
  useEffect(() => { if (flow.passError) passErrRef.current?.focus(); }, [flow.passError]);

  /** A pass QR is always a code; a registry-valid plate always wins; otherwise only long tokens count as pass codes. */
  const looksLikePass = (v: string) => {
    const s = v.trim();
    if (parsePassQr(s)) return true;
    if (matchesRegistry(s, me!.tenant.plate_regions)) return false;
    return s.length >= 10; // /v1/passes/lookup requires tokens of at least 10 characters
  };

  /** Typing or keying edits the one field; plate-shaped values also update the flow's plate directly. */
  function onEntry(v: string) {
    setEntry(v);
    if (!looksLikePass(v)) set({ plate: v, source: 'manual', candidates: [], plateFromPass: false });
  }

  /** One submit for the unified field: pass codes go to the pass lookup, plates to the usual confirmation. */
  function submitEntry() {
    const v = entry.trim();
    if (!v) return;
    if (looksLikePass(v)) { void usePass(v); return; }
    set({ plate: v, source: 'manual', candidates: [], plateFromPass: false });
    nav(`${b}/checkin/confirm`);
  }

  /** Look a scanned or typed pass up before taking the plate, so a bad QR is caught at the gate, not after. */
  async function usePass(raw: string) {
    const token = raw.trim();
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
      setEntry('');
      setCamera(false);
      // AC-4.2.2: a successful scan lands DIRECTLY on the complete prefilled confirmation form (Host from the pass unit,
      // plate from the hint, Make/Model/Year and the auto-picked Slot), not a plate-only keypad that needs another Next.
      // A pass with no plate hint still goes to confirm; the form focuses the editable required Plate field there.
      nav(`${b}/checkin/confirm`, q?.plate ? undefined : { state: { focusPlate: true } });
    } catch (e) {
      if (isStalePassLookup(mySeq, passSeq.current)) return;
      update(() => applyPassError(e instanceof ApiError && e.code.startsWith('pass_') ? passReason(t, e.code, errText(e)) : errText(e)));
    }
  }

  /** A plate read on-device. Seen in several frames it goes straight to confirm; a single "Capture" read below the site threshold goes to review. */
  function onPlate(p: { text: string; confidence: number; votes: number }) {
    setEntry(p.text);
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
      {flow.pass && (
        <Alert className="banner" role="status" aria-live="polite" tabIndex={-1} ref={passBannerRef}>
          <strong>{t('att.passFor', { guest: flow.pass.guest, unit: flow.pass.unit })}</strong>
          {flow.pass.verifyCode && <div className="num" dir="ltr">{t('att.passVerified', { code: spaceCode(flow.pass.verifyCode) })}</div>}
          {flow.pass.plateHint && <div className="muted">{t('att.passPlateHint', { plate: flow.pass.plateHint })}</div>}
          <div><Button type="button" className="btn" onClick={() => { passSeq.current++; update(applyPassRemove); }}>{t('att.passRemove')}</Button></div>
        </Alert>
      )}
      {flow.passError && (
        <Alert variant="destructive" className="banner bad" role="alert" tabIndex={-1} ref={passErrRef}>
          <div>{flow.passError}</div>
          <div><Button type="button" className="btn" onClick={() => update(clearPassError)}>{t('att.passDismiss')}</Button></div>
        </Alert>
      )}
      <Tabs tab={tab} onTab={setTab} label={t('att.captureMethod')} labels={{ camera: t('att.camera'), manual: t('att.manualEntry') }} />
      {camera ? (
        <>
          {!aiOn && <Alert className="banner">{t('att.cameraAiOff')}</Alert>}
          <LiveCamera regions={me!.tenant.plate_regions} qr={!flow.pass} plate={aiOn} busy={busy} onQr={(text) => { setEntry(text); void usePass(text); }} onPlate={onPlate} onSnap={(img) => { void capture(img); }} />
        </>
      ) : (
        <>
          <div className="platebox">{flow.plate ? <PlateChip plate={flow.plate} region={flow.region} size="xl" /> : <span className="muted">{t('att.plate')}</span>}</div>
          <Keypad region={flow.region} value={entry} onChange={onEntry} />
        </>
      )}
      <label className="field">{t('att.plateOrCode')}
        <Input value={entry} onChange={(e) => onEntry(e.target.value)} placeholder={t('att.plateOrCode')} aria-label={t('att.plateOrCode')} dir="ltr" autoCapitalize="off" />
      </label>
      <Button type="button" className="btn primary big" disabled={!entry.trim()} onClick={submitEntry}>{t('common.next')}</Button>
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
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
      <Alert className="banner warn">{t('att.lowConf')}</Alert>
      <h2>{t('att.candidates')}</h2>
      <div className="stack">{flow.candidates.map((c) => (
        <Button type="button" key={c.norm} className="btn row between" onClick={() => { set({ plate: c.text, confidence: c.confidence, source: 'ai_assist', plateFromPass: false }); nav(`${b}/checkin/confirm`); }}>
          <PlateChip plate={c.text} region={c.region} size="lg" /><span className="muted">{t('att.confidence', { pct: fmt.percent(c.confidence) })}{c.formatValid === false ? ' ⚠' : ''}</span>
        </Button>
      ))}</div>
      <h2>{t('att.keypad')}</h2>
      <div className="platebox">{flow.plate ? <PlateChip plate={flow.plate} region={flow.region} size="xl" /> : <span className="muted">{t('common.none')}</span>}</div>
      <Keypad region={flow.region} value={flow.plate} onChange={(v) => set({ plate: v, source: 'manual', plateFromPass: false })} />
      <Button type="button" className="btn primary big" disabled={!flow.plate} onClick={() => nav(`${b}/checkin/confirm`)}>{t('common.next')}</Button>
    </div>
  );
}

interface Opened { session: { id: string; ticketCode: string }; slot: string; warnings: string[] }
const BODY = ['sedan', 'suv', 'pickup', 'van', 'motorcycle'];
interface UnitRow { code: string; name: string }

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
  if (fixedUnit) return <label className="field">{t('att.host')}<Input value={fixedUnit} readOnly aria-readonly="true" /></label>;

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
          <Input role="combobox" aria-expanded={!other && matches.length > 0} aria-controls={listId} aria-autocomplete="list"
            value={query} disabled={other} onChange={(e) => { setQuery(e.target.value); onChange(null); }} placeholder={t('att.hostSearch')} />
        </label>
        <label className="row"><Checkbox checked={other} onCheckedChange={toggleOther} /> {t('att.hostOther')}</label>
      </div>
      {!other && query.trim() && (
        <ul id={listId} role="listbox" className="stack autolist">
          {matches.length === 0 && <li className="muted">{t('att.hostNoMatch')}</li>}
          {matches.map((u) => (
            <li key={u.code} role="option" aria-selected={false}>
              <Button type="button" className="btn row between" onClick={() => pickUnit(u.code)}><span>{u.code}</span><span className="muted">{u.name}</span></Button>
            </li>
          ))}
        </ul>
      )}
      {other && (
        <div className="stack">
          <label className="field">{t('att.hostName')}<Input value={name} onChange={(e) => setOtherField('name', e.target.value)} /></label>
          <label className="field">{t('att.hostPhone')}<Input value={phone} onChange={(e) => setOtherField('phone', e.target.value)} placeholder="+525512345678" dir="ltr" inputMode="tel" /></label>
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
      <Button type="button" className="btn row between" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{t('att.slot')}: <strong>{shown}</strong></span><span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </Button>
      {open && (
        <ul role="listbox" className="stack autolist slotlist">
          {free.data?.length === 0 && <li className="muted">{t('att.nothingFree')}</li>}
          {free.data?.map((s) => (
            <li key={s.code} role="option" aria-selected={s.code === value}>
              <Button type="button" className="btn row between" onClick={() => { onPick(s.code); setOpen(false); }}><span>{s.code}</span><span className="muted">{s.zone}</span></Button>
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
  const plateRef = useRef<HTMLInputElement>(null);
  const loc = useLocation();
  // A scan that rejected after a camera read navigated here takes focus, so a keyboard/screen-reader attendant
  // lands on the failure (and the acknowledge control) instead of past it, mirroring the capture screen.
  useEffect(() => { if (flow.passError) passErrRef.current?.focus(); }, [flow.passError]);
  // AC-4.2.2: a pass with NO plate hint lands here on the complete confirmation form; focus the editable Plate field
  // so the attendant can type it without bouncing back to the capture screen (a hinted pass skips this).
  useEffect(() => { if ((loc.state as { focusPlate?: boolean } | null)?.focusPlate && !flow.plate) plateRef.current?.focus(); }, [loc.state, flow.plate]);
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
        {done === 'queued' ? <Alert className="banner warn">{t('att.queued')}</Alert> : (
          <>
            <div className="platebox"><PlateChip plate={flow.plate} region={flow.region} size="xl" /></div>
            <dl className="kv"><dt>{t('att.slot')}</dt><dd>{done.slot}</dd><dt>{t('att.ticket')}</dt><dd className="num">{done.session.ticketCode}</dd></dl>
            <Ticket code={done.session.ticketCode} />
            {done.warnings.length > 0 && <Alert className="banner warn">{done.warnings.join(', ')}</Alert>}
          </>
        )}
        <Button type="button" className="btn primary big" onClick={() => { reset(); nav(b); }}>{t('att.done')}</Button>
      </div>
    );
  }

  return (
    <div className="att">
      {flow.pass && <Alert className="banner">{t('att.passFor', { guest: flow.pass.guest, unit: flow.pass.unit })}</Alert>}
      {flow.plate && <div className="platebox"><PlateChip plate={flow.plate} region={flow.region} size="xl" /></div>}
      {/* The required Plate stays editable here, so a no-hint pass (or an attendant correcting an OCR read) can type it
          on the confirmation form itself rather than returning to the capture screen. */}
      <label className="field">{t('att.plate')}
        <PlateInput ref={plateRef} value={flow.plate} onChange={(v) => set({ plate: v, plateFromPass: false })} autoFocus={!flow.plate} aria-required="true" />
      </label>
      {flow.confidence != null && <div className="muted">{t('att.confidence', { pct: Math.round(flow.confidence * 100) + '%' })}</div>}
      <h2>{t('att.hostHeading')}</h2>
      <HostControl fixedUnit={flow.pass?.unit} onChange={setHost} />
      <h2>{t('att.vehicle')}</h2>
      <div className="row">
        <label className="field grow">{t('att.make')}<Input {...v('make')} /></label>
        <label className="field grow">{t('att.model')}<Input {...v('model')} /></label>
        <label className="field grow">{t('att.year')}
          <Input type="number" inputMode="numeric" min={1900} max={new Date().getFullYear() + 1} value={flow.vehicle.year ?? ''}
            onChange={(e) => { const n = e.target.value ? Number(e.target.value) : undefined; set({ vehicle: { ...flow.vehicle, year: Number.isFinite(n) ? n : undefined } }); }} /></label>
      </div>
      <div className="row">
        <label className="field grow">{t('att.color')}<Input {...v('color')} /></label>
        <label className="field grow">{t('att.body')}<NativeSelect {...v('bodyType')}><option value="" />{BODY.map((x) => <option key={x} value={x}>{t(`body.${x}`)}</option>)}</NativeSelect></label>
      </div>
      <h2>{t('att.suggested')}</h2>
      <SlotPicker suggested={suggestion.data?.slot ?? null} value={slot} onPick={(code) => setSlot(code)} />
      {err && (
        <Alert variant="destructive" className="banner bad" role="alert">
          {err.code === 'already_inside' ? t('att.inside', { time: new Date(String(err.details?.inAt)).toLocaleTimeString(), slot: String(err.details?.slot ?? t('common.none')) })
            : err.code === 'assigned_slot_taken' ? t('att.takenBy', { plate: String(err.details?.offender ?? '?') })
            : err.code === 'site_full' ? t('att.full') : err.message}
          {typeof err.details?.suggestion === 'string' && <div><Button type="button" className="btn" onClick={() => confirm(err.details!.suggestion as string)}>{t('att.slot')} {String(err.details!.suggestion)}</Button></div>}
        </Alert>
      )}
      {flow.passPending && <Alert className="banner" role="status" aria-live="polite">{t('att.passChecking')}</Alert>}
      {/* A scan that rejected AFTER a camera plate read navigated here stays visible and blocks the walk-in: the
          attendant must acknowledge (return to scan) before an ordinary check-in can be submitted. */}
      {flow.passError && (
        <Alert variant="destructive" className="banner bad" role="alert" tabIndex={-1} ref={passErrRef}>
          <div>{flow.passError}</div>
          <div><Button type="button" className="btn" onClick={() => { update(clearPassError); nav(`${b}/checkin`); }}>{t('att.passDismiss')}</Button></div>
        </Alert>
      )}
      {!flow.passPending && !flow.passError && !flow.plate && <Alert className="banner warn" role="alert">{t('att.needPlate')}</Alert>}
      {/* A walk-in must name who authorized it: a community unit, or a complete "Other" (name + E.164 phone). */}
      {!flow.pass && !flow.passPending && !flow.passError && flow.plate && !hostValid(host, false) && <Alert className="banner warn" role="alert">{t('att.needHost')}</Alert>}
      <Button type="button" className="btn primary big" disabled={!canConfirm(flow, busy) || !hostValid(host, !!flow.pass)} onClick={() => confirm()}>{t('att.confirm')}</Button>
      <Button type="button" className="btn" onClick={() => nav(`${b}/checkin`)}>{t('att.editPlate')}</Button>
    </div>
  );
}

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
        <Button type="button" className="btn" onClick={onClose} aria-label={t('att.keyboardClose')}>✕</Button>
      </div>
      <Keypad value={value} onChange={onChange} />
    </div>
  );
}

/** Check-out Manual Entry: a plate autocomplete over open sessions (longest stay first). The ticket is internal only. */
function PlateAutocomplete({ open, busy, error, onSelect }: { open: OpenRow[]; busy: boolean; error: string; onSelect: (ticket: string) => void }) {
  const t = useT();
  const { me, site } = useApp();
  const fmt = useFormat(site?.timezone, me?.tenant.currency);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const listId = useId();
  // Normalize for matching: uppercase, remove non-alphanumeric chars
  const norm = query.replace(/[^A-Z0-9]/g, '');
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
        <PlateInput value={query} onChange={setQuery} autoFocus aria-autocomplete="list" aria-expanded={matches.length > 0} aria-controls={listId}
          aria-activedescendant={active >= 0 ? optId(active) : undefined} onFocus={() => setSheet(true)} onKeyDown={onKeyDown} />
      </label>
      <QueryState loading={false} error={error} empty={false} />
      {open.length === 0 && !error ? <div className="muted">{t('att.noneParked')}</div> : !error && (
        <ul id={listId} role="listbox" className="stack autolist" aria-label={t('att.plate')}>
          {matches.map((o, i) => (
            <li key={o.id} id={optId(i)} role="option" aria-selected={i === active}>
              <Button type="button" className={`btn row between ${i === active ? 'primary' : ''}`} onClick={() => choose(o)}>
                <PlateChip plate={o.plate} /><span className="muted">{o.slot ?? t('common.none')} · {dur(o.in_at)}</span>
              </Button>
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
  // One field for plate, ticket or guest pass; the match still goes out as plate or ticket, never both.
  const [entry, setEntry] = useState('');
  const [plate, setPlate] = useState('');
  const [ticket, setTicket] = useState('');
  const [m, setM] = useState<Match | null>(null);
  const [fuzzy, setFuzzy] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [pay, setPay] = useState<Pay>('cash');
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState<string | 'queued' | null>(null);
  const [busy, setBusy] = useState(false);
  const b = base(me!.tenant.slug);
  // The Manual Entry autocomplete lists currently-parked cars, oldest first (longest stay first).
  const openSessions = useApi<{ items: OpenRow[] }>(site && tab === 'manual' ? `/v1/sessions?site=${site.code}&status=open&sort=in_at_asc&limit=200` : null, [site?.code, tab]);

  // A quick-checkout link from Recent Activity carries the session ticket in router state: resolve it on mount.
  const fromState = (loc.state as { ticket?: string } | null)?.ticket;
  useEffect(() => { if (fromState) { setTab('manual'); setEntry(fromState); void find({ ticket: fromState }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function find(over?: { ticket?: string; plate?: string }, lostTicket = lost) {
    if (!site) return;
    setErr(''); setBusy(true);
    try {
      // An override fully determines the lookup kind, so a stale plate/ticket from a previous search never rides along.
      const body = { site: site.code, plate: over ? ('ticket' in over ? undefined : over.plate) : (plate || undefined), ticket: over ? ('ticket' in over ? over.ticket : undefined) : (ticket || undefined), region: me!.tenant.plate_regions[0], lostTicket: lostTicket || undefined };
      setM(await request<Match>('POST', '/v1/checkout/match', body));
    } catch (e) { setErr(isNetworkError(e) ? t('att.offline') : errText(e)); } finally { setBusy(false); }
  }

  /** One submit for the unified field: registry-valid plates match by plate; anything else is a ticket or pass code. */
  function findEntry() {
    const v = entry.trim();
    if (!v) return;
    if (parsePassQr(v) || !matchesRegistry(v, me!.tenant.plate_regions)) {
      const tk = v.toUpperCase();
      setTicket(tk); setPlate('');
      void find({ ticket: tk });
    } else {
      const p = normalizePlate(v);
      setPlate(p); setTicket('');
      void find({ plate: p });
    }
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
        {receipt === 'queued' ? <Alert className="banner warn">{t('att.queued')}</Alert> : <Alert className="banner">{t('att.receipt', { no: receipt })}</Alert>}
        <Button type="button" className="btn primary big" onClick={() => nav(b)}>{t('att.done')}</Button>
      </div>
    );
  }

  if (m?.matched && m.session && m.fee) {
    const h = Math.floor(m.fee.minutes / 60), min = m.fee.minutes % 60;
    return (
      <div className="att">
        <h1>{t('att.leavingTitle')}</h1>
        {fuzzy && <Alert className="banner warn">{t('att.confirmFuzzy')}</Alert>}
        <div className="platebox"><PlateChip plate={m.vehicle!.plate} size="xl" /></div>
        <dl className="kv">
          <dt>{t('att.slot')}</dt><dd>{m.slot ?? t('common.none')}</dd>
          <dt>{t('att.entry')}</dt><dd>{fmt.dateTime(m.session.inAt)}</dd>
          <dt>{t('att.vehicle')}</dt><dd>{[m.vehicle!.make, m.vehicle!.model, m.vehicle!.color].filter(Boolean).join(' ') || t('common.none')}</dd>
        </dl>
        <div className="muted">{t('att.checkedInBy', { name: m.session.inBy ?? t('common.none'), time: fmt.time(m.session.inAt) })}</div>
        <div className="muted">{t('att.duration', { hours: h, minutes: min })}</div>
        <Card className="card">
          {m.fee.lines.map((l, i) => <div key={i} className="feeline"><span>{feeLabel(t, l.label)}</span><span className="num">{fmt.money(l.amount)}</span></div>)}
          <div className="feeline"><strong>{t('att.fee')}</strong><span className="feetotal num">{fmt.money(m.fee.total)}</span></div>
        </Card>
        {can('override') && <label className="row"><Checkbox checked={lost} onCheckedChange={(checked) => { const next = checked === true; setLost(next); void find({ ticket: m.session!.ticketCode }, next); }} />{t('att.lost')}</label>}
        <div className="row">{(['cash', 'card', 'account'] as const).map((p) => <Button type="button" key={p} className={`btn grow ${pay === p ? 'primary' : ''}`} onClick={() => setPay(p)}>{t(`att.${p}`)}</Button>)}</div>
        {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
        <Button type="button" className="btn primary big" disabled={busy} onClick={confirm}>{t('att.confirmLeaving')} · {fmt.money(m.fee.total)}</Button>
        <Button type="button" className="btn" onClick={() => { setM(null); setFuzzy(null); }}>{t('common.back')}</Button>
      </div>
    );
  }

  return (
    <div className="att">
      <h1>{t('att.checkout')}</h1>
      <Tabs tab={tab} onTab={setTab} label={t('att.captureMethod')} labels={{ camera: t('att.camera'), manual: t('att.manualEntry') }} />
      <label className="field">{t('att.plateTicketOrPass')}
        <Input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={t('att.plateTicketOrPass')} aria-label={t('att.plateTicketOrPass')} dir="ltr" autoCapitalize="off" />
      </label>
      <Button type="button" className="btn primary big" disabled={busy || !entry.trim()} onClick={findEntry}>{t('att.find')}</Button>
      {tab === 'camera' ? (
        <LiveCamera regions={me!.tenant.plate_regions} plate={me!.tenant.ai_mode !== 'off'} busy={busy}
          onQr={(text) => { const tk = text.trim().toUpperCase(); setEntry(text); setTicket(tk); setPlate(''); void find({ ticket: tk }); }}
          onPlate={(p) => { const txt = normalizePlate(p.text); setEntry(txt); setPlate(txt); setTicket(''); void find({ plate: txt }); }} />
      ) : (
        <>
          <Keypad region={me!.tenant.plate_regions[0]} value={entry} onChange={setEntry} />
          <PlateAutocomplete open={openSessions.data?.items ?? []} busy={busy || openSessions.loading} error={openSessions.error} onSelect={(tk) => { setEntry(tk); setTicket(tk); setPlate(''); void find({ ticket: tk }); }} />
        </>
      )}
      {m && !m.matched && (
        <div className="stack">
          <Alert className="banner warn">{t('att.noMatch')}</Alert>
          {!!m.candidates?.length && <h2>{t('att.didYouMean')}</h2>}
          {m.candidates?.map((c) => (
            <Button type="button" key={c.sessionId} className="btn row between" onClick={() => { setFuzzy(c.sessionId); void find({ ticket: c.ticketCode }); }}>
              <PlateChip plate={c.plate} size="lg" /><span className="muted">{c.slot}</span>
            </Button>
          ))}
        </div>
      )}
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}{!navigator.onLine && (plate || ticket) && <div><Button type="button" className="btn" onClick={queueOffline}>{t('att.queued')}</Button></div>}</Alert>}
      <Link to={b}>{t('common.back')}</Link>
    </div>
  );
}

export { get };
