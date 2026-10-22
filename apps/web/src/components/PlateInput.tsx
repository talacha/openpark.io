import { useEffect, useState, forwardRef } from 'react';
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
  // Use the prop value as the source of truth, not internal state
  const [display, setDisplay] = useState(value ?? '');

  // Sync display when the external value changes (e.g., when a pass with plate hint is accepted)
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

  // The input should use the prop value directly for controlled behavior
  return (
    <input
      ref={ref}
      {...props}
      type="text"
      value={value ?? display}
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
