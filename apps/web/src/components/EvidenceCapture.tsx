import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n.js';
import { Input } from '@/components/ui/input';

/** Downscale a photo to a JPEG data URL the API accepts (max 1280 px, quality 0.82). */
export async function resizeEvidence(file: File): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('image_read_failed'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('image_invalid'));
    element.src = source;
  });
  const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas_unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/**
 * Photo capture shared by enforcement actions. The caller owns the data URL and decides whether a photo is
 * required; this component only handles choosing, resizing, and previewing it.
 */
export function EvidenceCapture({ value, onChange, required = false, disabled = false }: {
  value: string;
  onChange: (dataUrl: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  const helpId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!value && inputRef.current) inputRef.current.value = ''; }, [value]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError('');
    try { onChange(await resizeEvidence(file)); }
    catch { onChange(''); setError(t('enf.evidenceError')); }
    finally { setBusy(false); }
  }

  return (
    <>
      <label className="field">{t('enf.evidence')}
        <Input ref={inputRef} type="file" accept="image/*" capture="environment" required={required} disabled={disabled || busy}
          aria-describedby={helpId} onChange={(e) => { void choose(e.target.files?.[0]); }} />
      </label>
      <p className="muted" id={helpId}>{t('enf.evidenceHelp')}</p>
      {busy && <p className="muted" role="status">{t('common.loading')}</p>}
      {error && <p className="muted" role="alert">{error}</p>}
      {value && <img className="video" src={value} alt={t('enf.evidencePreview')} />}
    </>
  );
}
