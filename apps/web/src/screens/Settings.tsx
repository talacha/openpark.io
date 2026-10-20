import { useEffect, useState } from 'react';
import { ApiError, patch } from '../api.js';
import { useApp } from '../app-context.js';
import { LOCALES, NAMES, translate, useI18n, useT, type Terminology } from '../i18n.js';

export function AiSettings() {
  const t = useT();
  const { me, site, reload } = useApp();
  const [mode, setMode] = useState(me!.tenant.ai_mode);
  const [threshold, setThreshold] = useState(site?.settings.aiThreshold ?? 0.95);
  const [retention, setRetention] = useState(30);
  const [training, setTraining] = useState(false);
  const [regions, setRegions] = useState(me!.tenant.plate_regions.join(', '));
  const [msg, setMsg] = useState('');

  async function save() {
    try {
      if (site && mode === 'auto') await patch(`/v1/sites/${site.code}`, { aiThreshold: threshold });
      await patch('/v1/tenant', { aiMode: mode, retentionDays: retention, trainingExport: training, plateRegions: regions.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) });
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
        <label className="field">{t('ai.regions')}<input value={regions} onChange={(e) => setRegions(e.target.value)} dir="ltr" /></label>
        <label className="field">{t('ai.retention')}<input type="number" min="1" value={retention} onChange={(e) => setRetention(Number(e.target.value))} /></label>
        <label className="row"><input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />{t('ai.training')}</label>
        <div className="row"><button className="btn primary" onClick={save}>{t('common.save')}</button>{msg && <span className="muted">{msg}</span>}</div>
      </section>
    </div>
  );
}

export function LocaleSettings() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { me, reload } = useApp();
  const [def, setDef] = useState(me!.tenant.default_locale);
  const [enabled, setEnabled] = useState<string[]>(me!.tenant.locales);
  const [terms, setTerms] = useState<Terminology>(me!.tenant.terminology);
  const [lang, setLang] = useState(def);
  const [msg, setMsg] = useState('');
  useEffect(() => { setLang(def); }, [def]);

  const cur = terms[lang]?.['term.slot'] ?? '';
  const setTerm = (v: string) => setTerms({ ...terms, [lang]: { ...(terms[lang] ?? {}), 'term.slot': v } });
  const preview = (n: number) => translate(lang, 'term.slot', { count: n }, terms);

  async function save() {
    try { await patch('/v1/tenant', { defaultLocale: def, locales: enabled, terminology: terms }); await reload(); setMsg(t('common.saved')); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : String(e)); }
  }
  return (
    <div className="stack">
      <h1>{t('loc.title')}</h1>
      <section className="card stack">
        <label className="field">{t('loc.default')}
          <select value={def} onChange={(e) => setDef(e.target.value)}>{LOCALES.map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}</select></label>
        <fieldset style={{ border: 0, padding: 0 }}><legend>{t('loc.enabled')}</legend>
          <div className="row">{LOCALES.map((l) => (
            <label key={l} className="row"><input type="checkbox" checked={enabled.includes(l)} disabled={l === def}
              onChange={(e) => setEnabled(e.target.checked ? [...enabled, l] : enabled.filter((x) => x !== l))} />{NAMES[l]}</label>
          ))}</div></fieldset>
        <button className="btn" onClick={() => setLocale(locale === 'en-XA' ? def : 'en-XA')}>{t('loc.pseudo')}</button>
      </section>
      <section className="card stack">
        <h2>{t('loc.overrides')}</h2>
        <p className="muted">{t('loc.overridesHelp')}</p>
        <label className="field">{NAMES[lang] ?? lang}
          <select value={lang} onChange={(e) => setLang(e.target.value)}>{enabled.map((l) => <option key={l} value={l}>{NAMES[l] ?? l}</option>)}</select></label>
        <label className="field">term.slot<input dir="ltr" value={cur} placeholder={translate(lang, 'term.slot', { count: 1 })} onChange={(e) => setTerm(e.target.value)} /></label>
        <div className="row">{t('loc.preview')}: <strong>{preview(1)}</strong> / <strong>{preview(5)}</strong></div>
        <div className="row"><button className="btn primary" onClick={save}>{t('common.save')}</button>{msg && <span className="muted">{msg}</span>}</div>
      </section>
    </div>
  );
}
