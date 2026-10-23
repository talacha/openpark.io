import { useEffect, useState } from 'react';
import { Input } from './ui/input.js';

export function PhoneInput({ value, onChange, onBlur, placeholder, required, disabled }: {
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const [display, setDisplay] = useState(value ?? '');

  useEffect(() => { setDisplay(value ?? ''); }, [value]);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const raw = event.currentTarget.value;
    setDisplay(raw);
    onChange?.(raw.replace(/[\s()-]/g, ''));
  }

  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    onBlur?.(event.currentTarget.value.replace(/[\s()-]/g, ''));
  }

  return (
    <Input
      name="phone"
      type="tel"
      inputMode="tel"
      value={display}
      onChange={handleChange}
      onBlur={handleBlur}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      dir="ltr"
    />
  );
}
