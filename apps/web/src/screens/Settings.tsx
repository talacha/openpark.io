import { useState } from 'react';
import { ApiError, patch } from '../api.js';
import { useApp } from '../app-context.js';
import { useApi } from '../components/hooks.js';
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
      <div className="banner">{t('ai.privacy')}</div>
      <section className="card stack">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend>{t('ai.mode')}</legend>
          {(['off', 'assist', 'auto'] as const).map((m) => (
            <label key={m} className="row"><input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
              <span><strong>{t(`ai.${m}`)}</strong><br /><span className="muted">{t(`ai.${m}Help`)}</span></span></label>
          ))}
        </fieldset>
        {mode === 'auto' && <label className="field">{t('ai.threshold')}: {Math.round(threshold * 100)}%
          <input type="range" min="0.8" max="0.99" step="0.01" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>}
        <fieldset className="roles"><legend>{t('ai.regions')}</legend>
          {known.data?.map((r) => (
            <div key={r.region} className="rolebox">
              <input id={`reg-${r.region}`} type="checkbox" checked={regions.includes(r.region)}
                onChange={() => setRegions(regions.includes(r.region) ? regions.filter((x) => x !== r.region) : [...regions, r.region])} />
              <label htmlFor={`reg-${r.region}`}><strong>{r.name}</strong><small dir="ltr">{r.region}{regions[0] === r.region ? ` · ${t('ai.regionDefault')}` : ''}</small></label>
            </div>
          ))}
        </fieldset>
        <label className="field">{t('ai.retention')}<input type="number" min="1" value={retention} onChange={(e) => setRetention(Number(e.target.value))} /></label>
        <label className="row"><input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />{t('ai.training')}</label>
        <div className="row"><button className="btn primary" onClick={save}>{t('common.save')}</button>{msg && <span className="muted">{msg}</span>}</div>
      </section>
    </div>
  );
}
