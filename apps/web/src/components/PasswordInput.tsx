import { useState, type InputHTMLAttributes } from 'react';
import { useT } from '../i18n.js';

/** Password field with a show/hide toggle (keyboard and screen-reader friendly). */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <span className="pwd">
      <input {...props} type={shown ? 'text' : 'password'} dir="ltr" />
      <button type="button" className="pwd-toggle" aria-pressed={shown} aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')} title={shown ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShown(!shown)}>
        {shown ? '🙈' : '👁'}
      </button>
    </span>
  );
}
