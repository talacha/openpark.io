import { useId, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useT } from '../i18n.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';

/** The eye button and checkbox intentionally share one visibility state. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const id = useId();
  const label = shown ? t('auth.hidePassword') : t('auth.showPassword');
  return (
    <>
      <div className="pwd">
        <Input {...props} type={shown ? 'text' : 'password'} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="pwd-eye"
          aria-pressed={shown}
          aria-controls={props.id}
          aria-label={label}
          title={label}
          onClick={() => setShown(!shown)}
        >
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
      <label className="showpw" htmlFor={id}>
        <Checkbox id={id} checked={shown} onCheckedChange={(checked) => setShown(checked)} />
        {t('auth.showPassword')}
      </label>
    </>
  );
}
