import { forwardRef, useEffect, useState, type ChangeEvent, type InputHTMLAttributes } from 'react';
import { Input } from './ui/input.js';

interface PlateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value?: string;
  onChange?: (value: string) => void;
}

const PlateInputBase = (
  { value, onChange, placeholder, required, disabled, autoFocus, ...props }: PlateInputProps,
  ref: React.ForwardedRef<HTMLInputElement>,
) => {
  const [display, setDisplay] = useState(value ?? '');

  useEffect(() => { setDisplay(value ?? ''); }, [value]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.currentTarget.value;
    setDisplay(raw);
    onChange?.(raw.toUpperCase());
  }

  return (
    <Input
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
