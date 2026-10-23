import { useEffect, useMemo, useState } from 'react';
import { QrCode } from '../components/QrCode.js';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { isPassExpired, parseGuestPassToken, parsePassQr, spaceCode } from '../pass.js';
import { useT } from '../i18n.js';

/** mm:ss or h:mm:ss until the pass expires, recomputed every second. */
function countdown(expiresMs: number, now: number): string {
  const s = Math.max(0, Math.floor((expiresMs - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

/**
 * Public, unauthenticated page a guest opens from a shared link. The signed pass token arrives in the URL fragment
 * (`#t=…`), never touching the server, and the QR is rendered here on the guest's own device for the attendant to scan.
 * Nothing is trusted from the token beyond display: the attendant's scan is re-verified by the server at check-in.
 */
export function GuestPass() {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);

  const token = useMemo(() => parseGuestPassToken(typeof location !== 'undefined' ? location.hash : ''), []);
  const pass = useMemo(() => (token ? parsePassQr(token) : null), [token]);
  const expired = pass ? isPassExpired(pass, now) : false;

  if (!token || !pass) return (
    <div className="att"><h1>{t('guest.heading')}</h1><Alert variant="destructive" className="banner warn" role="alert">{t('guest.invalid')}</Alert></div>
  );

  return (
    <div className="att">
      <h1>{t('guest.heading')}</h1>
      <div className="muted">{t('guest.for', { guest: pass.guest, unit: pass.unit })}</div>
      {expired ? (
        <Alert variant="destructive" className="banner warn" role="alert">{t('res.expired')}</Alert>
      ) : (
        <Card className="card stack">
          <QrCode value={token} size={280} label={pass.guest} />
          {pass.code && <div className="verify"><span className="muted">{t('res.verifyCode')}</span><strong className="num" dir="ltr">{spaceCode(pass.code)}</strong></div>}
          <p className="muted">{t('res.qrHelp')}</p>
          <div className="feetotal num" aria-live="off">{t('res.expiresIn', { time: countdown(pass.expires * (pass.expires < 1e12 ? 1000 : 1), now) })}</div>
        </Card>
      )}
    </div>
  );
}
