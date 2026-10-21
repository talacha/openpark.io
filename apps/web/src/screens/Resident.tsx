import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, patch, post } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { dataUrlToBlob, passShareMessage, planPassShare, qrGifDataUrl, spaceCode } from '../pass.js';
import { useApi } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';
import { errText } from '../errors.js';
import { Link } from 'react-router-dom';

export interface PassView {
  id: string; status: 'active' | 'checked_in' | 'completed' | 'cancelled'; displayStatus: string;
  unit: { code: string; name: string }; guestName: string; guestPhone: string | null; guestEmail: string | null; plateHint: string | null;
  expiresAt: string; createdAt: string; checkedInAt: string | null; completedAt: string | null; cancelledAt: string | null;
  overstayCharge: number | null; qr: string | null; verifyCode?: string | null;
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

export function ResidentHome() {
  const t = useT();
  const { me, reload } = useApp();
  const fmt = useFormat(undefined, me?.tenant.currency);
  const active = useApi<Active>('/v1/passes/active');
  const history = useApi<PassView[]>('/v1/passes?limit=10');
  const [err, setErr] = useState('');
  const [editPhone, setEditPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const pass = active.data?.pass ?? null;
  const policy = active.data?.policy;
  const countdown = useCountdown(pass && pass.status === 'active' ? pass.expiresAt : null);

  // Residents cannot subscribe to live events, so poll while a pass is open: this is how check-in shows up.
  useEffect(() => {
    const i = setInterval(() => { if (!document.hidden) { void active.reload(); void history.reload(); } }, 10_000);
    return () => clearInterval(i);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const expired = pass?.status === 'active' && (pass.displayStatus === 'expired' || countdown.done);
  const stayEnds = pass?.checkedInAt && policy ? new Date(new Date(pass.checkedInAt).getTime() + policy.maxStayHours * 3_600_000) : null;

  return (
    <div className="att">
      <div><h1>{t('res.title')}</h1><div className="muted">{t('res.unit', { unit: me.unit.name })}</div></div>

      {(!me.user?.phone || editPhone)
        ? <PhoneCard phone={me.user?.phone ?? ''} onSaved={async () => { setEditPhone(false); await reload(); }} onCancel={me.user?.phone ? () => setEditPhone(false) : undefined} />
        : <div className="row between muted"><span dir="ltr">{t('res.phone')}: {me.user.phone}</span><button type="button" className="btn" onClick={() => setEditPhone(true)}>{t('users.edit')}</button></div>}
      {err && <div className="banner bad" role="alert">{err}</div>}

      {!pass && (
        <form className="card stack" onSubmit={create}>
          <h2>{t('res.new')}</h2>
          <label className="field">{t('res.guestName')}<input name="guestName" required maxLength={80} /></label>
          <label className="field">{t('res.guestPhone')}<input name="guestPhone" type="tel" inputMode="tel" placeholder="+52 55 1234 5678" pattern="\+[1-9][0-9]{7,14}" dir="ltr" /></label>
          <label className="field">{t('res.guestEmail')}<input name="guestEmail" type="email" dir="ltr" /></label>
          <label className="field">{t('res.plateHint')}<input name="plateHint" maxLength={20} dir="ltr" autoCapitalize="characters" /></label>
          {policy && <p className="muted">{t('res.rules', { hours: policy.maxStayHours, amount: fmt.money(policy.overstayCharge) })}</p>}
          <p className="muted">{t('res.onlyOne')}</p>
          <button className="btn primary big" disabled={busy}>{t('res.create')}</button>
        </form>
      )}

      {pass && (
        <section className="card stack">
          <div className="row between"><h2>{pass.guestName}</h2><span className={`pill ${expired ? 'warn' : pass.status === 'checked_in' ? 'info' : 'ok'}`}>{t(`res.status_${expired ? 'expired' : pass.status}`)}</span></div>

          {pass.status === 'active' && !expired && pass.qr && (
            <>
              <QrCode value={pass.qr} size={280} label={pass.guestName} />
              {pass.verifyCode && <div className="verify"><span className="muted">{t('res.verifyCode')}</span><strong className="num" dir="ltr">{spaceCode(pass.verifyCode)}</strong></div>}
              <p className="muted">{t('res.qrHelp')}</p>
              <div className="feetotal num" aria-live="off">{t('res.expiresIn', { time: countdown.text })}</div>
              <SharePass qr={pass.qr} guest={pass.guestName} property={me.tenant.name} unit={me.unit.name} code={pass.verifyCode ?? ''}
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

      {!!history.data?.length && (
        <section>
          <h2>{t('res.history')}</h2>
          <div className="stack">{history.data.map((p) => (
            <div key={p.id} className="card row between">
              <span><strong>{p.guestName}</strong><br /><span className="muted">{fmt.dateTime(p.createdAt)}</span></span>
              <span className="pill">{t(`res.status_${p.displayStatus}`)}</span>
            </div>
          ))}</div>
        </section>
      )}
    </div>
  );
}

/**
 * Send the live pass to the guest. Prefers the Web Share API with the QR as an image file; degrades to text-only
 * share, then to copying the message and downloading the QR image. Never throws on an unsupported browser.
 */
function SharePass({ qr, guest, property, unit, code, expiresMinutes }: { qr: string; guest: string; property: string; unit: string; code: string; expiresMinutes: number }) {
  const t = useT();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true); setStatus('');
    // The signed token rides along in the text so a text-only share or a copy still leaves the guest a redeemable pass.
    const { title, text } = passShareMessage(t, { guest, unit, property, code, expiresMinutes, token: qr });
    const nav = navigator as Navigator & { canShare?: (d?: { files?: File[] }) => boolean };
    try {
      const dataUrl = qrGifDataUrl(qr);
      const file = new File([dataUrlToBlob(dataUrl)], 'parking-pass.gif', { type: 'image/gif' });
      const canShare = typeof nav.share === 'function';
      const canShareFiles = canShare && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
      const plan = planPassShare({ canShare, canShareFiles, canCopy: typeof navigator.clipboard?.writeText === 'function' });
      if (plan.method === 'file') { await nav.share({ title, text, files: [file] }); return; }
      if (plan.method === 'text') { await nav.share({ title, text }); return; }
      // No Web Share API (most desktops): download the QR image, and copy the message only when the Clipboard API exists.
      if (plan.copies) await navigator.clipboard.writeText(text);
      const a = document.createElement('a');
      a.href = dataUrl; a.download = 'parking-pass.gif'; a.rel = 'noopener';
      a.click();
      setStatus(t(plan.statusKey || 'res.shareDownloaded'));
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return; // guest dismissed the share sheet: not an error
      setStatus(t('res.shareFailed'));
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <button type="button" className="btn primary grow" disabled={busy} onClick={() => void share()}>{t('res.share')}</button>
      <p className="muted" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

function PhoneCard({ phone, onSaved, onCancel }: { phone: string; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const t = useT();
  const [err, setErr] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const phone = String(new FormData(e.currentTarget).get('phone') ?? '').replace(/[\s()-]/g, '');
    try { await patch('/v1/me/profile', { phone }); await onSaved(); } catch (x) { setErr(errText(x)); }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>{t('res.phoneTitle')}</h2>
      <p className="muted">{t('res.phoneHelp')}</p>
      <label className="field">{t('res.phone')}<input name="phone" type="tel" inputMode="tel" required defaultValue={phone} placeholder="+52 55 1234 5678" dir="ltr" /></label>
      {err && <div className="banner bad" role="alert">{err}</div>}
      <div className="row"><button className="btn primary">{t('common.save')}</button>{onCancel && <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>}</div>
    </form>
  );
}
