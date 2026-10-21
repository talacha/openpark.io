import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { patch, post } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { dataUrlToBlob, passShareMessage, passShareUrl, planPassShare, qrGifDataUrl, spaceCode } from '../pass.js';
import { useApi } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';
import { errText } from '../errors.js';

export interface PassView {
  id: string; status: 'active' | 'checked_in' | 'completed' | 'cancelled'; displayStatus: string;
  unit: { code: string; name: string }; guestName: string; guestPhone: string | null; guestEmail: string | null; plateHint: string | null;
  expiresAt: string; createdAt: string; checkedInAt: string | null; completedAt: string | null; cancelledAt: string | null;
  overstayCharge: number | null; qr: string | null; verifyCode?: string | null;
  /** Who issued the pass, for the resident-facing history label. Never carries staff identity. */
  issuedByRole?: 'host' | 'staff' | 'unknown';
}
interface Active { pass: PassView | null; policy: { qrTtlMin: number; maxStayHours: number; overstayCharge: number; currency: string } }

/** mm:ss or h:mm:ss until `to`. */
function useCountdown(to: string | null): { text: string; done: boolean } {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  if (!to) return { text: '', done: true };
  const ms = Math.max(0, new Date(to).getTime() - now);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return { text: h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`, done: ms === 0 };
}

/** The initials shown when there is no avatar: up to two letters from the name, else the email's local part. */
function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  const src = (name && name.trim()) || (email ? email.split('@')[0]! : '');
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : src.slice(0, 2);
  return letters.toUpperCase() || '?';
}

/**
 * A button-driven disclosure (not <details>) so its open state can be driven from the #new / ?edit=1 deep-links and
 * focus can be moved programmatically. Collapsed by default.
 */
function Collapsible({ title, open, onToggle, headingRef, children }:
  { title: string; open: boolean; onToggle: (next: boolean) => void; headingRef?: React.Ref<HTMLButtonElement>; children: ReactNode }) {
  const rid = useId();
  return (
    <section className="collapsible">
      <h2>
        <button type="button" ref={headingRef} className="collapsible-head" aria-expanded={open} aria-controls={rid} tabIndex={-1} onClick={() => onToggle(!open)}>
          <span className={`collapsible-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>{title}
        </button>
      </h2>
      <div id={rid} hidden={!open}>{open && children}</div>
    </section>
  );
}

function Avatar({ url, name, email, unit }: { url: string | null | undefined; name: string | null | undefined; email: string | null | undefined; unit: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const showImg = !!url && !failed;
  return (
    <div className="avatar">
      {showImg
        ? <img className="avatar-img" src={url!} alt={t('res.avatarAlt')} onError={() => setFailed(true)} />
        : <span className="avatar-initials" aria-hidden="true">{initialsOf(name, email)}</span>}
      <span className="avatar-pill" aria-label={t('res.unit', { unit })}>{unit}</span>
    </div>
  );
}

export function ResidentHome() {
  const t = useT();
  const { me, reload } = useApp();
  const fmt = useFormat(undefined, me?.tenant.currency);
  const active = useApi<Active>('/v1/passes/active');
  const history = useApi<PassView[]>('/v1/passes?limit=10');
  const [params] = useSearchParams();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Deep links: ?edit=1 wins over #new. edit opens the profile editor; #new opens the New Guest Parking Pass section.
  const wantEdit = params.get('edit') != null;
  const wantNew = !wantEdit && (typeof location !== 'undefined' && location.hash === '#new');
  const [editing, setEditing] = useState(wantEdit);
  const [newOpen, setNewOpen] = useState(wantNew);
  const [prevOpen, setPrevOpen] = useState(false);

  const pass = active.data?.pass ?? null;
  const policy = active.data?.policy;
  const countdown = useCountdown(pass && pass.status === 'active' ? pass.expiresAt : null);

  // Focus targets for the deterministic #new rule.
  const newHeadRef = useRef<HTMLButtonElement>(null);
  const guestNameRef = useRef<HTMLInputElement>(null);
  const shareBtnRef = useRef<HTMLButtonElement>(null);

  // Residents cannot subscribe to live events, so poll while a pass is open: this is how check-in shows up.
  useEffect(() => {
    const i = setInterval(() => { if (!document.hidden) { void active.reload(); void history.reload(); } }, 10_000);
    return () => clearInterval(i);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const expired = pass?.status === 'active' && (pass.displayStatus === 'expired' || countdown.done);

  // When #new resolves (and the section is open), move focus to the first real control, else the heading.
  useEffect(() => {
    if (!wantNew || !newOpen || active.loading) return;
    const target = !pass ? guestNameRef.current
      : (pass.status === 'active' && !expired && pass.qr) ? shareBtnRef.current
        : newHeadRef.current;
    (target ?? newHeadRef.current)?.focus();
  }, [wantNew, newOpen, active.loading, pass, expired]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => { await Promise.all([active.reload(), history.reload()]); };
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr('');
    try { await fn(); await refresh(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const form = e.currentTarget;
    await run(async () => {
      await post('/v1/passes', { guestName: f.guestName, guestPhone: f.guestPhone || undefined, guestEmail: f.guestEmail || undefined, plateHint: f.plateHint || undefined });
      form.reset();
    });
  }

  if (!me?.unit) {
    const staff = me?.superadmin || me?.roles.includes('admin');
    return <div className="att"><div className="banner warn">{t(staff ? 'res.noUnitAdmin' : 'res.noUnit')}{staff && <> <Link to="../users">{t('res.assignSelf')}</Link></>}</div></div>;
  }

  // Banner-vs-form precedence: unit==null handled above; here, a resident with an UNVERIFIED unit sees a pending
  // banner and no create form. me.unitVerified is finalized by FEAT-005; treat missing as verified so C builds green.
  const resident = me.roles.includes('resident');
  const pending = resident && me.unitVerified === false;

  const stayEnds = pass?.checkedInAt && policy ? new Date(new Date(pass.checkedInAt).getTime() + policy.maxStayHours * 3_600_000) : null;

  return (
    <div className="att">
      <header className="profile-head">
        <Avatar url={me.avatarUrl} name={me.user?.name} email={me.user?.email} unit={me.unit.code} />
        <div className="grow">
          <h1>{t(me.user?.name ? 'res.welcomeName' : 'res.title', { name: me.user?.name ?? '' })}</h1>
          <div className="muted">{t('res.unit', { unit: me.unit.name })}</div>
        </div>
        <button type="button" className="btn icon" aria-label={t('res.editProfile')} aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          <svg className="menu-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </button>
      </header>

      {editing && <EditProfile me={me} onDone={async () => { setEditing(false); await reload(); }} />}

      {err && <div className="banner bad" role="alert">{err}</div>}

      <Collapsible title={t('res.sectionNew')} open={newOpen} onToggle={setNewOpen} headingRef={newHeadRef}>
        {pending ? (
          <div className="banner warn">{t('res.pendingVerify')}</div>
        ) : !pass ? (
          <form className="card stack" onSubmit={create}>
            <label className="field">{t('res.guestName')}<input ref={guestNameRef} name="guestName" required maxLength={80} /></label>
            <label className="field">{t('res.guestPhone')}<input name="guestPhone" type="tel" inputMode="tel" placeholder="+52 55 1234 5678" pattern="\+[1-9][0-9]{7,14}" dir="ltr" /></label>
            <label className="field">{t('res.guestEmail')}<input name="guestEmail" type="email" dir="ltr" /></label>
            <label className="field">{t('res.plateHint')}<input name="plateHint" maxLength={20} dir="ltr" autoCapitalize="characters" /></label>
            {policy && <p className="muted">{t('res.rules', { hours: policy.maxStayHours, amount: fmt.money(policy.overstayCharge) })}</p>}
            <p className="muted">{t('res.onlyOne')}</p>
            <button className="btn primary big" disabled={busy}>{t('res.create')}</button>
          </form>
        ) : (
          <section className="card stack">
            <div className="row between"><h3>{pass.guestName}</h3><span className={`pill ${expired ? 'warn' : pass.status === 'checked_in' ? 'info' : 'ok'}`}>{t(`res.status_${expired ? 'expired' : pass.status}`)}</span></div>

            {pass.status === 'active' && !expired && pass.qr && (
              <>
                <QrCode value={pass.qr} size={280} label={pass.guestName} />
                {pass.verifyCode && <div className="verify"><span className="muted">{t('res.verifyCode')}</span><strong className="num" dir="ltr">{spaceCode(pass.verifyCode)}</strong></div>}
                <p className="muted">{t('res.qrHelp')}</p>
                <div className="feetotal num" aria-live="off">{t('res.expiresIn', { time: countdown.text })}</div>
                <SharePass shareRef={shareBtnRef} qr={pass.qr} guest={pass.guestName} property={me.tenant.name} unit={me.unit.name} code={pass.verifyCode ?? ''}
                  expiresMinutes={Math.max(0, Math.round((new Date(pass.expiresAt).getTime() - Date.now()) / 60000))} />
              </>
            )}
            {expired && <div className="banner warn">{t('res.expired')}</div>}
            {pass.status === 'checked_in' && pass.checkedInAt && (
              <>
                <div className="banner">{t('res.inside', { time: fmt.time(pass.checkedInAt) })}</div>
                {stayEnds && policy && <p className="muted">{t('res.mustLeave', { time: fmt.time(stayEnds), amount: fmt.money(policy.overstayCharge) })}</p>}
              </>
            )}
            {pass.status === 'active' && !expired && <p className="muted">{t('res.waiting')}</p>}

            {pass.status === 'active' && (
              <div className="row">
                <button className={`btn grow ${expired ? 'primary' : ''}`} disabled={busy} onClick={() => run(() => post(`/v1/passes/${pass.id}/regenerate`))}>{t('res.regenerate')}</button>
                <button className="btn danger grow" disabled={busy} onClick={() => { if (confirm(t('res.cancelConfirm'))) void run(() => post(`/v1/passes/${pass.id}/cancel`)); }}>{t('res.cancel')}</button>
              </div>
            )}
          </section>
        )}
      </Collapsible>

      <Collapsible title={t('res.sectionPrevious')} open={prevOpen} onToggle={setPrevOpen}>
        {history.data?.length ? (
          <div className="stack">{history.data.map((p) => (
            <div key={p.id} className="card row between">
              <span>
                <strong>{p.guestName}</strong><br />
                <span className="muted">{fmt.dateTime(p.createdAt)}</span>
                <span className="muted"> · {t(`res.issuedBy_${p.issuedByRole ?? 'unknown'}`)}</span>
              </span>
              <span className="pill">{t(`res.status_${p.displayStatus}`)}</span>
            </div>
          ))}</div>
        ) : <p className="muted">{t('res.noHistory')}</p>}
      </Collapsible>
    </div>
  );
}

/** Pencil edit form: Name + Phone (existing contract) + the guest-alert opt-in, and an optional avatar upload. */
function EditProfile({ me, onDone }: { me: NonNullable<ReturnType<typeof useApp>['me']>; onDone: () => Promise<void> }) {
  const t = useT();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(true); // the server default; the toggle reflects the resident's choice

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr('');
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const phone = String(data.get('phone') ?? '').replace(/[\s()-]/g, '');
    const file = data.get('avatar');
    try {
      await patch('/v1/me/profile', { name: name || undefined, phone: phone || null, notifyGuestEvents: notify });
      if (file instanceof File && file.size > 0) {
        if (file.size > 2_097_152) throw new Error('too_big');
        const buf = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        await post('/v1/me/avatar', { contentType: file.type, dataBase64: btoa(binary) });
      }
      await onDone();
    } catch (x) {
      setErr((x as Error).message === 'too_big' ? t('res.avatarTooBig') : errText(x));
    } finally { setBusy(false); }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>{t('res.editProfile')}</h2>
      <label className="field">{t('auth.name')}<input name="name" maxLength={100} defaultValue={me.user?.name ?? ''} /></label>
      <label className="field">{t('res.phone')}<input name="phone" type="tel" inputMode="tel" defaultValue={me.user?.phone ?? ''} placeholder="+52 55 1234 5678" dir="ltr" /></label>
      <label className="field">{t('res.avatarLabel')}<input name="avatar" type="file" accept="image/png,image/jpeg,image/webp" /></label>
      <label className="row gap"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />{t('res.notifyGuests')}</label>
      <p className="muted">{t('res.notifyHelp')}</p>
      {err && <div className="banner bad" role="alert">{err}</div>}
      <div className="row"><button className="btn primary" disabled={busy}>{t('common.save')}</button><button type="button" className="btn" disabled={busy} onClick={() => void onDone()}>{t('common.cancel')}</button></div>
    </form>
  );
}

/**
 * Send the live pass to the guest. Prefers the Web Share API with the QR as an image file; degrades to text-only
 * share, then to copying the message and downloading the QR image. Never throws on an unsupported browser.
 */
export function SharePass({ qr, guest, property, unit, code, expiresMinutes, shareRef }: { qr: string; guest: string; property: string; unit: string; code: string; expiresMinutes: number; shareRef?: React.Ref<HTMLButtonElement> }) {
  const t = useT();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true); setStatus('');
    // Share a guest-facing link that renders the QR client-side, so even a text-only share (no file support) leaves the
    // guest something scannable at the gate. The signed token also rides in the body as a redeemable fallback.
    const url = passShareUrl(location.origin, qr);
    const { title, text } = passShareMessage(t, { guest, unit, property, code, expiresMinutes, token: qr });
    const nav = navigator as Navigator & { canShare?: (d?: { files?: File[] }) => boolean };
    try {
      const dataUrl = qrGifDataUrl(qr);
      const file = new File([dataUrlToBlob(dataUrl)], 'parking-pass.gif', { type: 'image/gif' });
      const canShare = typeof nav.share === 'function';
      const canShareFiles = canShare && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
      const plan = planPassShare({ canShare, canShareFiles, canCopy: typeof navigator.clipboard?.writeText === 'function' });
      // Every Web Share carries the guest link, so the guest can open it and present a scannable QR on their own device.
      if (plan.method === 'file') { await nav.share({ title, text, url, files: [file] }); return; }
      if (plan.method === 'text') { await nav.share({ title, text, url }); return; }
      // No Web Share API (most desktops): the QR download is the actual share artifact and must ALWAYS happen. Copying
      // the message is a best-effort extra, so a Clipboard that exists but rejects (permission policy, NotAllowedError)
      // must NOT skip the download. Catch it on its own and report honestly whether the copy also succeeded.
      let copied = false;
      if (plan.copies) {
        try { await navigator.clipboard.writeText(`${text}\n${url}`); copied = true; } catch { /* clipboard denied: download still proceeds */ }
      }
      const a = document.createElement('a');
      a.href = dataUrl; a.download = 'parking-pass.gif'; a.rel = 'noopener';
      a.click();
      setStatus(t(copied ? 'res.shareCopied' : 'res.shareDownloaded'));
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return; // guest dismissed the share sheet: not an error
      setStatus(t('res.shareFailed'));
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <button type="button" ref={shareRef} className="btn primary grow" disabled={busy} onClick={() => void share()}>{t('res.share')}</button>
      <p className="muted" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
