import { useRef, useState } from 'react';
import { ApiError, get, request } from '../api.js';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';

interface Slot { site: string; zone: string; code: string; type: string; status: string }
interface Diff { added: Slot[]; changed: { before: Slot; after: Slot }[]; retired: Slot[]; conflicts: { slot: Slot; reason: string }[] }
interface Preview { job: string; mode: string; dryRun: boolean; summary: Record<string, number>; diff: Diff }

export function Inventory() {
  const t = useT();
  const { site } = useApp();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [dryRun, setDryRun] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<{ message: string; details?: unknown } | null>(null);
  const [status, setStatus] = useState('');
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function download() {
    const doc = await get<unknown>(`/v1/inventory/export${site ? `?site=${site.code}` : ''}`);
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `inventory-${site?.code ?? 'all'}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  }

  async function validate() {
    setErr(null); setPreview(null); setStatus('');
    try { setPreview(await request<Preview>('POST', `/v1/inventory/import?mode=${mode}&dryRun=${dryRun}`, { text })); }
    catch (e) { if (e instanceof ApiError) setErr({ message: e.message, details: e.details }); else throw e; }
  }

  async function act(kind: 'apply' | 'rollback', job: string) {
    setErr(null);
    try {
      await request('POST', `/v1/inventory/import/${job}/${kind}`);
      setStatus(kind === 'apply' ? t('inv.applied') : t('inv.rolledBack'));
      if (kind === 'apply') setLastApplied(job); else setLastApplied(null);
      setPreview(null);
    } catch (e) { if (e instanceof ApiError) setErr({ message: e.message, details: e.details }); }
  }

  const s = preview?.summary;
  const empty = s && !s.added && !s.changed && !s.retired && !s.conflicts;
  return (
    <div className="stack">
      <h1>{t('inv.title')}</h1>
      <div className="row"><button className="btn" onClick={download}>{t('inv.export')}</button></div>
      <section className="card stack">
        <h2>{t('inv.paste')}</h2>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} dir="ltr" aria-label={t('inv.paste')} />
        <div className="row">
          <input ref={file} type="file" accept="application/json,.json" aria-label={t('common.chooseFile')} hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
          <button className="btn" onClick={() => file.current?.click()}>{t('inv.upload')}</button>
          <label className="row"><span>{t('inv.mode')}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}><option value="merge">{t('inv.merge')}</option><option value="replace">{t('inv.replace')}</option></select>
          </label>
          <label className="row"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />{t('inv.dryRun')}</label>
          <button className="btn primary" disabled={!text.trim()} onClick={validate}>{t('inv.validate')}</button>
        </div>
        {err && (
          <div className="banner bad" role="alert">
            {err.message}
            {Array.isArray(err.details) && <ul>{(err.details as { path?: string; message?: string }[]).map((d, i) => <li key={i}><code>{d.path}</code> {d.message}</li>)}</ul>}
            {!!err.details && !Array.isArray(err.details) && 'line' in (err.details as object) && <div>{t('inv.line', err.details as Record<string, unknown>)}</div>}
          </div>
        )}
      </section>
      {status && <div className="banner">{status}</div>}
      {preview && s && (
        <section className="card stack">
          <div className="row">
            <span className="diff-added">+{s.added} {t('inv.added')}</span><span className="diff-changed">~{s.changed} {t('inv.changed')}</span>
            <span className="diff-retired">−{s.retired} {t('inv.retired')}</span><span className="diff-conflicts">!{s.conflicts} {t('inv.conflicts')}</span>
          </div>
          {empty && <div className="banner">{t('inv.empty')}</div>}
          <div className="tablewrap" style={{ maxBlockSize: 320, overflow: 'auto' }}><table><tbody>
            {preview.diff.added.slice(0, 200).map((x) => <tr key={`a${x.site}${x.code}`}><td className="diff-added">+</td><td>{x.site}</td><td>{x.code}</td><td>{x.type}</td></tr>)}
            {preview.diff.changed.slice(0, 200).map((x) => <tr key={`c${x.after.site}${x.after.code}`}><td className="diff-changed">~</td><td>{x.after.site}</td><td>{x.after.code}</td><td>{x.before.type} → {x.after.type}</td></tr>)}
            {preview.diff.retired.slice(0, 200).map((x) => <tr key={`r${x.site}${x.code}`}><td className="diff-retired">−</td><td>{x.site}</td><td>{x.code}</td><td>{x.type}</td></tr>)}
            {preview.diff.conflicts.map((x) => <tr key={`x${x.slot.site}${x.slot.code}`}><td className="diff-conflicts">!</td><td>{x.slot.site}</td><td>{x.slot.code}</td><td>{x.reason}</td></tr>)}
          </tbody></table></div>
          <div className="row">
            <button className="btn primary" disabled={preview.dryRun || !!s.conflicts || !!empty} onClick={() => act('apply', preview.job)}>{t('common.apply')}</button>
            <button className="btn" onClick={() => setPreview(null)}>{t('common.cancel')}</button>
          </div>
        </section>
      )}
      {lastApplied && <div className="row"><span className="muted">{t('inv.lastJob')}</span><button className="btn danger" onClick={() => act('rollback', lastApplied)}>{t('common.rollback')}</button></div>}
    </div>
  );
}
