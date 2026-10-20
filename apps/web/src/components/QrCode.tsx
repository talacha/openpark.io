import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** A QR code as inline SVG (white background so it scans in dark mode too). */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label?: string }) {
  const svg = useMemo(() => { const q = qrcode(0, 'M'); q.addData(value); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }, [value]);
  return <div style={{ inlineSize: size, maxInlineSize: '100%', background: '#fff', padding: 8, borderRadius: 8 }} dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label={label ?? value} />;
}
