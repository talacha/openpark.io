import { useEffect, useState, forwardRef, useRef } from 'react';
import { useT } from '../i18n.js';
import type { InputHTMLAttributes, ChangeEvent } from 'react';

/**
 * A plate input that normalizes user input to uppercase, for consistent plate entry across the app.
 * Used in check-in and check-out forms.
 */
interface PlateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value?: string;
  onChange?: (value: string) => void;
}

const PlateInputBase = (
  { value, onChange, placeholder, required, disabled, autoFocus, ...props }: PlateInputProps,
  ref: React.ForwardedRef<HTMLInputElement>
) => {
  const t = useT();
  const [display, setDisplay] = useState(value ?? '');

  // Sync display when the external value changes (e.g., after save or reset)
  useEffect(() => {
    setDisplay(value ?? '');
  }, [value]);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.currentTarget.value;
    // Normalize to uppercase for plate input
    const normalized = raw.toUpperCase();
    setDisplay(raw); // Keep display as user typed it
    onChange?.(normalized);
  }

  return (
    <input
      ref={ref}
      {...props}
      type="text"
      value={display}
      onChange={handleChange}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      autoFocus={autoFocus}
      dir="ltr"
      autoCapitalize="characters"
    />
  );
};

export const PlateInput = forwardRef<HTMLInputElement, PlateInputProps>(PlateInputBase);
