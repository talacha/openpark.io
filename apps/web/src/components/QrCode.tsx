import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code as inline SVG. Always dark on a white card with the 4-module quiet zone the spec requires (so it scans in dark mode
 * and next to other content), crisp edges at any zoom, and error correction M (a long pass token still fits a small screen).
 */
export function QrCode({ value, size = 260, label }: { value: string; size?: number; label?: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M'); q.addData(value, 'Byte'); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }).replace('<svg ', '<svg shape-rendering="crispEdges" style="display:block;inline-size:100%;block-size:auto" ');
  }, [value]);
  return <div className="qr" style={{ inlineSize: size, maxInlineSize: '100%', background: '#fff', borderRadius: 8, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label={label ?? value} />;
}
