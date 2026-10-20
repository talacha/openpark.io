import { useId, useState, type InputHTMLAttributes } from 'react';
import { useT } from '../i18n.js';

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/**
 * Password field with two controls that share one state: an eye button inside the end edge of the field and a
 * "Show password" checkbox underneath. Either one switches the input between type=password and type=text.
 * Render it inside a `div.field` with its own `<label htmlFor>`; labels cannot nest.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <>
      <div className="pwd">
        <input {...props} type={shown ? 'text' : 'password'} />
        <button type="button" className="pwd-eye" aria-pressed={shown} aria-controls={props.id}
          aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')} title={shown ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShown(!shown)}>
          {shown ? <Svg><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></Svg> : <Svg><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></Svg>}
        </button>
      </div>
      <label className="showpw" htmlFor={id}>
        <input id={id} type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
        {t('auth.showPassword')}
      </label>
    </>
  );
}
