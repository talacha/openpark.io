import { useEffect, useState } from 'react';
import { useT } from '../i18n.js';

/**
 * A phone input that strips spaces and dashes as the user types, keeping only the + sign for international format.
 * The value passed to onChange/onBlur handlers is the formatted string.
 */
export function PhoneInput({ value, onChange, onBlur, placeholder, required, disabled }: {
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  const [display, setDisplay] = useState(value ?? '');

  // Sync display when the external value changes (e.g., after save or reset)
  useEffect(() => {
    setDisplay(value ?? '');
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.currentTarget.value;
    // Strip spaces and dashes, keep + sign for international format
    const formatted = raw.replace(/[\s()-]/g, '');
    setDisplay(raw); // Keep display as user typed it
    onChange?.(formatted);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = e.currentTarget.value;
    const formatted = raw.replace(/[\s()-]/g, '');
    onBlur?.(formatted);
  }

  return (
    <input
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
