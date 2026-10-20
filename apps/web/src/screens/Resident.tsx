import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, patch, post } from '../api.js';
import { useApp } from '../app-context.js';
import { QrCode } from '../components/QrCode.js';
import { useApi } from '../components/hooks.js';
import { useFormat, useT } from '../i18n.js';

export interface PassView {
  id: string; status: 'active' | 'checked_in' | 'completed' | 'cancelled'; displayStatus: string;
  unit: { code: string; name: string }; guestName: string; guestPhone: string | null; guestEmail: string | null; plateHint: string | null;
  expiresAt: string; createdAt: string; checkedInAt: string | null; completedAt: string | null; cancelledAt: string | null;
  overstayCharge: number | null; qr: string | null;
}
interface Active { pass: PassView | null; policy: { qrTtlMin: number; maxStayHours: number; overstayCharge: number; currency: string } }

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

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

  if (!me?.unit) return <div className="att"><div className="banner warn">{t('res.noUnit')}</div></div>;
  const expired = pass?.status === 'active' && (pass.displayStatus === 'expired' || countdown.done);
  const stayEnds = pass?.checkedInAt && policy ? new Date(new Date(pass.checkedInAt).getTime() + policy.maxStayHours * 3_600_000) : null;

  return (
    <div className="att">
      <div><h1>{t('res.title')}</h1><div className="muted">{t('res.unit', { unit: me.unit.name })}</div></div>

      {!me.user?.phone && <PhoneCard onSaved={reload} />}
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
              <QrCode value={pass.qr} size={260} label={pass.guestName} />
              <p className="muted">{t('res.qrHelp')}</p>
              <div className="feetotal num" aria-live="off">{t('res.expiresIn', { time: countdown.text })}</div>
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

function PhoneCard({ onSaved }: { onSaved: () => Promise<void> }) {
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
      <label className="field">{t('res.phone')}<input name="phone" type="tel" inputMode="tel" required placeholder="+52 55 1234 5678" dir="ltr" /></label>
      {err && <div className="banner bad" role="alert">{err}</div>}
      <button className="btn">{t('common.save')}</button>
    </form>
  );
}
