import { useState } from 'react';
import { ApiError, patch } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';
import { useT } from '../i18n.js';

export function AiSettings() {
  const t = useT();
  const { me, site, reload } = useApp();
  const [mode, setMode] = useState(me!.tenant.ai_mode);
  const [threshold, setThreshold] = useState(site?.settings.aiThreshold ?? 0.95);
  // Initialise from what is saved, not from defaults, or the screen would show (and re-save) the wrong values.
  const [retention, setRetention] = useState(me!.tenant.retention_days);
  const [training, setTraining] = useState(me!.tenant.training_export);
  const [regions, setRegions] = useState<string[]>(me!.tenant.plate_regions);
  const known = useApi<{ region: string; name: string }[]>('/v1/plate-regions');
  const [msg, setMsg] = useState('');

  async function save() {
    try {
      if (site && mode === 'auto') await patch(`/v1/sites/${site.code}`, { aiThreshold: threshold });
      await patch('/v1/tenant', { aiMode: mode, retentionDays: retention, trainingExport: training, plateRegions: regions });
      await reload(); setMsg(t('common.saved'));
    } catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
  }
  return (
    <div className="stack">
      <h1>{t('ai.title')}</h1>
      <Alert className="banner">{t('ai.privacy')}</Alert>
      <Card className="card stack">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend>{t('ai.mode')}</legend>
          <RadioGroup value={mode} onValueChange={(value) => setMode(value as typeof mode)} className="stack">
            {(['off', 'assist', 'auto'] as const).map((m) => (
              <label key={m} className="row"><RadioGroupItem value={m} />
                <span><strong>{t(`ai.${m}`)}</strong><br /><span className="muted">{t(`ai.${m}Help`)}</span></span></label>
            ))}
          </RadioGroup>
        </fieldset>
        {mode === 'auto' && <label className="field">{t('ai.threshold')}: {Math.round(threshold * 100)}%
          <Slider min={0.8} max={0.99} step={0.01} value={[threshold]} onValueChange={(value) => setThreshold(Array.isArray(value) ? value[0] ?? threshold : value)} aria-label={t('ai.threshold')} /></label>}
        <fieldset className="roles"><legend>{t('ai.regions')}</legend>
          {known.data?.map((r) => (
            <div key={r.region} className="rolebox">
              <Checkbox id={`reg-${r.region}`} checked={regions.includes(r.region)}
                onCheckedChange={() => setRegions(regions.includes(r.region) ? regions.filter((x) => x !== r.region) : [...regions, r.region])} />
              <label htmlFor={`reg-${r.region}`}><strong>{r.name}</strong><small dir="ltr">{r.region}{regions[0] === r.region ? ` · ${t('ai.regionDefault')}` : ''}</small></label>
            </div>
          ))}
        </fieldset>
        <label className="field">{t('ai.retention')}<Input type="number" min="1" value={retention} onChange={(e) => setRetention(Number(e.target.value))} /></label>
        <label className="row"><Checkbox checked={training} onCheckedChange={(checked) => setTraining(checked === true)} />{t('ai.training')}</label>
        <div className="row"><Button className="btn primary" onClick={save}>{t('common.save')}</Button>{msg && <span className="muted">{msg}</span>}</div>
      </Card>
    </div>
  );
}
