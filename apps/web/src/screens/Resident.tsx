import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { patch, post } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { PhoneInput } from '../components/PhoneInput.js';
import { PlateInput } from '../components/PlateInput.js';
import { dataUrlToBlob, passShareMessage, passShareUrl, planPassShare, qrGifDataUrl, spaceCode } from '../pass.js';
import { useApi, useSubmitKey } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { useFormat, useT } from '../i18n.js';
import { errText } from '../errors.js';
import { Alert } from '@/components/ui/alert';
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible as CollapsibleRoot, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';

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
 * A button-driven disclosure (not <details>) so its open state can be driven from the #new deep link and focus can be
 * moved programmatically. Collapsed by default; the active-pass section opens itself when a pass exists.
 */
function Collapsible({ title, open, onToggle, headingRef, children }:
  { title: string; open: boolean; onToggle: (next: boolean) => void; headingRef?: React.Ref<HTMLButtonElement>; children: ReactNode }) {
  const rid = useId();
  return (
    <CollapsibleRoot open={open} onOpenChange={onToggle} className="collapsible">
      <h2>
        <CollapsibleTrigger render={<Button type="button" ref={headingRef} variant="ghost" className="collapsible-head" aria-controls={rid} />}>
          <span className={`collapsible-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>{title}
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent id={rid}>{children}</CollapsibleContent>
    </CollapsibleRoot>
  );
}

function Avatar({ url, name, email, unit }: { url: string | null | undefined; name: string | null | undefined; email: string | null | undefined; unit: string }) {
  const t = useT();
  // Base UI decides between the image and the fallback: it preloads `src` and keeps the fallback while the
  // picture is missing or fails (an uploaded avatar with an expired link, or a Gravatar 404 for an address
  // with no profile). Rendering both is what makes that fallback work.
  return (
    <AvatarRoot className="avatar">
      {url ? <AvatarImage className="avatar-img" src={url} alt={t('res.avatarAlt')} referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className="avatar-initials" aria-hidden="true">{initialsOf(name, email)}</AvatarFallback>
      <Badge className="avatar-pill" aria-label={t('res.unit', { unit })}>{unit}</Badge>
    </AvatarRoot>
  );
}

export function ResidentHome() {
  const t = useT();
  const { me, reload } = useApp();
  const fmt = useFormat(undefined, me?.tenant.currency);
  const active = useApi<Active>('/v1/passes/active');
  const history = useApi<PassView[]>('/v1/passes?limit=10');
  const [params] = useSearchParams();
  const loc = useLocation();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Deep links: ?edit=1 wins over #new. edit opens the profile editor; #new opens the pass section.
  // ?edit=1 comes from the router (useSearchParams); #new is read from the router location OR the window hash (a hash
  // link to the same route updates window.location.hash but not always the router search). The effect below re-runs on
  // loc.key so a deep link followed WHILE already on /r still opens/focuses the destination, not just on mount.
  const windowHash = typeof location !== 'undefined' ? location.hash : '';
  const wantEdit = params.get('edit') != null;
  const wantNew = !wantEdit && (loc.hash === '#new' || windowHash === '#new');
  const [editing, setEditing] = useState(wantEdit);
  const [newOpen, setNewOpen] = useState(wantNew);
  const [prevOpen, setPrevOpen] = useState(false);
  const profileHeadRef = useRef<HTMLButtonElement>(null);

  const pass = active.data?.pass ?? null;
  const policy = active.data?.policy;
  const countdown = useCountdown(pass && pass.status === 'active' ? pass.expiresAt : null);

  // Focus targets for the deterministic #new rule.
  const newHeadRef = useRef<HTMLButtonElement>(null);
  const guestNameRef = useRef<HTMLInputElement>(null);
  const shareBtnRef = useRef<HTMLButtonElement>(null);

  // Keep the open sections in step with the router location, so a deep link (?edit=1 or #new) followed WHILE
  // already on /r opens and focuses the right section. edit wins over new (matching the mount-time precedence); #new
  // opens the pass section. Navigating to plain /r (no query, no hash) leaves whatever the resident has toggled.
  useEffect(() => {
    if (wantEdit) { setEditing(true); profileHeadRef.current?.focus(); }
    else if (wantNew) setNewOpen(true);
  }, [wantEdit, wantNew, loc.key]); // loc.key changes on every navigation, even to the same path with the same hash

  // The active pass is the screen's primary content, so open its section once per pass. A manual collapse stays
  // collapsed until a different pass arrives; polling the same pass must not re-open it.
  const autoOpenedPass = useRef<string | null>(null);
  useEffect(() => {
    if (!pass || wantEdit) return;
    if (autoOpenedPass.current === pass.id) return;
    autoOpenedPass.current = pass.id;
    setNewOpen(true);
  }, [pass, wantEdit]);

  // Strip spaces and dashes, keep + sign for guest phone input
  const [guestPhone, setGuestPhone] = useState('');
  function formatGuestPhone(raw: string): string {
    return raw.replace(/[\s()-]/g, '');
  }

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
      const rawPhone = String(f.guestPhone ?? '');
      await post('/v1/passes', { guestName: f.guestName, guestPhone: formatGuestPhone(rawPhone) || undefined, guestEmail: f.guestEmail || undefined, plateHint: f.plateHint || undefined });
      form.reset();
      setGuestPhone('');
    });
  }

  if (!me?.unit) {
    const staff = me?.superadmin || me?.roles.includes('admin');
    return <div className="att"><Alert className="banner warn">{t(staff ? 'res.noUnitAdmin' : 'res.noUnit')}{staff && <> <Link to="../users">{t('res.assignSelf')}</Link></>}</Alert></div>;
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
        <Button type="button" ref={profileHeadRef} className="btn icon" aria-label={t('res.editProfile')} aria-expanded={editing} aria-controls={editing ? 'resident-profile-editor' : undefined} onClick={() => setEditing((v) => !v)}>
          <svg className="menu-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </Button>
      </header>

      {editing && <EditProfile id="resident-profile-editor" me={me} onDone={async () => { setEditing(false); profileHeadRef.current?.focus(); await reload(); }} />}

      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      {!active.error && active.loading && !active.data && <p className="muted" role="status">{t('common.loading')}</p>}
      {active.error && <Alert variant="destructive" className="banner bad" role="alert">{active.error}</Alert>}
      {history.error && history.error !== active.error && <Alert variant="destructive" className="banner bad" role="alert">{history.error}</Alert>}

      <Collapsible title={t(pass ? 'res.sectionCurrent' : 'res.sectionNew')} open={newOpen} onToggle={setNewOpen} headingRef={newHeadRef}>
        {active.loading ? (
          <QueryState loading error="" empty={false} />
        ) : active.error ? null : pending ? (
          <Alert className="banner warn">{t('res.pendingVerify')}</Alert>
        ) : !pass ? (
          <Card render={<form className="card stack" onSubmit={create} />}>
            <label className="field">{t('res.guestName')}<Input ref={guestNameRef} name="guestName" required maxLength={80} /></label>
            <label className="field">{t('res.guestPhone')}
              <Input
                name="guestPhone"
                type="tel"
                inputMode="tel"
                placeholder="+52 55 1234 5678"
                pattern="\+[1-9][0-9]{7,14}"
                dir="ltr"
                onChange={(e) => setGuestPhone(formatGuestPhone(e.currentTarget.value))}
              />
            </label>
            <label className="field">{t('res.guestEmail')}<Input name="guestEmail" type="email" dir="ltr" /></label>
            <label className="field">{t('res.plateHint')}<PlateInput name="plateHint" maxLength={20} /></label>
            {policy && <p className="muted">{t('res.rules', { hours: policy.maxStayHours, amount: fmt.money(policy.overstayCharge) })}</p>}
            <p className="muted">{t('res.onlyOne')}</p>
            <Button type="submit" className="btn primary big" disabled={busy}>{t('res.create')}</Button>
          </Card>
        ) : (
          <Card render={<section className="card stack" />}>
            <div className="row between"><h3>{pass.guestName}</h3><Badge className={`pill ${expired ? 'warn' : pass.status === 'checked_in' ? 'info' : 'ok'}`}>{t(`res.status_${expired ? 'expired' : pass.status}`)}</Badge></div>

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
            {expired && <Alert className="banner warn">{t('res.expired')}</Alert>}
            {pass.status === 'checked_in' && pass.checkedInAt && (
              <>
                <Alert className="banner">{t('res.inside', { time: fmt.time(pass.checkedInAt) })}</Alert>
                {stayEnds && policy && <p className="muted">{t('res.mustLeave', { time: fmt.time(stayEnds), amount: fmt.money(policy.overstayCharge) })}</p>}
              </>
            )}
            {pass.status === 'active' && !expired && <p className="muted">{t('res.waiting')}</p>}

            {pass.status === 'active' && (
              <div className="row">
                <Button type="button" className={`btn grow ${expired ? 'primary' : ''}`} disabled={busy} onClick={() => run(() => post(`/v1/passes/${pass.id}/regenerate`))}>{t('res.regenerate')}</Button>
                <Button type="button" className="btn danger grow" disabled={busy} onClick={() => { if (confirm(t('res.cancelConfirm'))) void run(() => post(`/v1/passes/${pass.id}/cancel`)); }}>{t('res.cancel')}</Button>
              </div>
            )}
          </Card>
        )}
      </Collapsible>

      <Collapsible title={t('res.sectionPrevious')} open={prevOpen} onToggle={setPrevOpen}>
        <QueryState loading={history.loading} error="" empty={!history.error && !history.data?.length} emptyLabel={t('res.noHistory')} />
        {!history.loading && !history.error && !!history.data?.length && (
          <div className="stack">{history.data.map((p) => (
            <Card key={p.id} className="card row between">
              <span>
                <strong>{p.guestName}</strong><br />
                <span className="muted">{fmt.dateTime(p.createdAt)}</span>
                <span className="muted"> · {t(`res.issuedBy_${p.issuedByRole ?? 'unknown'}`)}</span>
              </span>
              <Badge className="pill">{t(`res.status_${p.displayStatus}`)}</Badge>
            </Card>
          ))}</div>
        )}
      </Collapsible>
    </div>
  );
}

/** Resize an image file to 256×256 WebP with the given quality (0-100). */
async function resizeToWebP(file: File, quality: number = 80): Promise<{ data: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 256;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas_unavailable'));
          return;
        }
        // Draw the image centered and cropped to fill the 256×256 square
        const scale = Math.max(size / img.width, size / img.height);
        const x = (size / 2) - (img.width / 2) * scale;
        const y = (size / 2) - (img.height / 2) * scale;
        ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
        // Export as WebP with the specified quality
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('webp_export_failed'));
            return;
          }
          const reader2 = new FileReader();
          reader2.onload = () => {
            const data = reader2.result as string;
            // Remove the data:image/webp;base64, prefix
            const base64 = data.split(',', 2)[1];
            if (base64) {
              resolve({ data: base64, width: size, height: size });
            } else {
              reject(new Error('webp_encode_failed'));
            }
          };
          reader2.onerror = () => reject(reader2.error);
          reader2.readAsDataURL(blob);
        }, 'image/webp', quality / 100);
      };
      img.onerror = () => reject(new Error('image_load_failed'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Pencil edit form: Name + Phone (existing contract) + the guest-alert opt-in, and an optional avatar upload. */
function EditProfile({ me, id, onDone }: { me: NonNullable<ReturnType<typeof useApp>['me']>; id?: string; onDone: () => Promise<void> }) {
  const t = useT();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Rehydrate the saved opt-in (GET /v1/me returns it); missing folds to the server default (true) only for a brand-new
  // account. An opted-out resident sees the toggle unchecked, so editing name/phone/avatar never re-enables alerts.
  const [notify, setNotify] = useState(me.user?.notifyGuestEvents ?? true);
  // A payload-scoped idempotency key so a lost-response retry of the avatar upload replays the stored write rather than
  // storing the image twice (the route is replaySafe). It rotates automatically when a different file is chosen.
  const avatarKey = useSubmitKey();
  // Strip spaces and dashes, keep + sign as the number is being entered
  function formatPhone(raw: string): string {
    return raw.replace(/[\s()-]/g, '');
  }
  const [phone, setPhone] = useState(me.user?.phone ?? '');

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr('');
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const phone = String(data.get('phone') ?? '');
    const file = data.get('avatar');
    try {
      await patch('/v1/me/profile', { name: name || undefined, phone: phone || null, notifyGuestEvents: notify });
      if (file instanceof File && file.size > 0) {
        if (file.size > 2_097_152) throw new Error('too_big');
        // Resize image to 256×256 WebP at quality 80 (aiming for ~10-20KB)
        const resized = await resizeToWebP(file, 80);
        await post('/v1/me/avatar', { contentType: 'image/webp', dataBase64: resized.data }, avatarKey.key(`${file.name}:${file.size}:${file.lastModified}`));
      }
      await onDone();
    } catch (x) {
      setErr((x as Error).message === 'too_big' ? t('res.avatarTooBig') : errText(x));
    } finally { setBusy(false); }
  }

  return (
    <Card render={<form id={id} className="card stack" onSubmit={save} />}>
      <h2>{t('res.editProfile')}</h2>
      <label className="field">{t('auth.name')}<Input name="name" maxLength={100} defaultValue={me.user?.name ?? ''} /></label>
      <label className="field">{t('res.phone')}
        <PhoneInput value={phone} onChange={setPhone} placeholder="+52 55 1234 5678" />
      </label>
      <label className="field">{t('res.avatarLabel')}<Input name="avatar" type="file" accept="image/png,image/jpeg,image/webp" /></label>
      <label className="row gap"><Checkbox checked={notify} onCheckedChange={(checked) => setNotify(checked === true)} />{t('res.notifyGuests')}</label>
      <p className="muted">{t('res.notifyHelp')}</p>
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      <div className="row"><Button type="submit" className="btn primary" disabled={busy}>{t('common.save')}</Button><Button type="button" className="btn" disabled={busy} onClick={() => void onDone()}>{t('common.cancel')}</Button></div>
    </Card>
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
      <Button type="button" ref={shareRef} className="btn primary grow" disabled={busy} onClick={() => void share()}>{t('res.share')}</Button>
      <p className="muted" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
