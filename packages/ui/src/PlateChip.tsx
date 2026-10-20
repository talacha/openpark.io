import type { CSSProperties } from 'react';

export interface PlateChipProps {
  plate: string;
  region?: string;
  size?: 'md' | 'lg' | 'xl';
  style?: CSSProperties;
}

/** Plate as printed (native script, separators kept). Pair with `plate.css`. */
export function PlateChip({ plate, region, size = 'md', style }: PlateChipProps) {
  return (
    <span className={`plate${size === 'md' ? '' : ` plate--${size}`}`} data-region={region} dir="ltr" style={style}>
      {plate}
    </span>
  );
}
