import { useRef, useState } from 'react';
import { ApiError, get, request } from '../api.js';
import { useApp } from '../app-context.js';
import { useSubmitKey } from '../components/hooks.js';
import { useT } from '../i18n.js';

/** The four bulk entities, each mapping to its export + import pipeline. Every tab reuses the same validate -> preview
 * -> apply -> rollback UI; only the endpoints and the download file name differ. */
type Entity = 'sites' | 'inventory' | 'units' | 'users';
interface Spec { tab: string; exportUrl: string; importUrl: (opts: { mode: string; dryRun: boolean }) => string; file: string; modes: boolean }

const SPECS: Record<Entity, Spec> = {
  // Labelled "Sites" (not "Communities"): this pipeline operates on /v1/sites — a community's parking facilities.
  // Community identity (a tenant's address/notes) is edited in the Community settings panel on the Communities & parking
  // screen, not bulk-imported here (one community per admin session, so there is nothing to bulk-import at that level).
  sites: { tab: 'bulk.sites', exportUrl: '/v1/sites/export', importUrl: (o) => `/v1/sites/import?mode=${o.mode}&dryRun=${o.dryRun}`, file: 'sites.json', modes: true },
  inventory: { tab: 'bulk.slots', exportUrl: '/v1/inventory/export', importUrl: (o) => `/v1/inventory/import?mode=${o.mode}&dryRun=${o.dryRun}`, file: 'inventory.json', modes: true },
  units: { tab: 'bulk.units', exportUrl: '/v1/units/export', importUrl: (o) => `/v1/units/import?mode=${o.mode}&dryRun=${o.dryRun}`, file: 'units.json', modes: true },
  users: { tab: 'bulk.users', exportUrl: '/v1/users/export', importUrl: (o) => `/v1/users/import?dryRun=${o.dryRun}`, file: 'users.json', modes: false },
};
const ENTITIES: Entity[] = ['sites', 'inventory', 'units', 'users'];

interface Preview { job: string; dryRun: boolean; summary: Record<string, number>; diff: Record<string, unknown[]> }

/** One Bulk import/export admin screen with entity tabs. Reuses the shipped import pipeline for each entity. */
export function Bulk() {
  const t = useT();
  const [entity, setEntity] = useState<Entity>('sites');
  const spec = SPECS[entity];
  return (
    <div className="stack">
      <h1>{t('bulk.title')}</h1>
      {/* An ordinary toggle-button group (aria-pressed), not an ARIA tabs widget — each entity button is a normal
          tab-stop, so there is no roving-focus / Left-Right contract to half-implement. */}
      <div className="row" role="group" aria-label={t('bulk.title')}>
        {ENTITIES.map((e) => (
          <button key={e} type="button" aria-pressed={entity === e} className={`btn${entity === e ? ' primary' : ''}`} onClick={() => setEntity(e)}>{t(SPECS[e].tab)}</button>
        ))}
      </div>
      <ImportExport key={entity} spec={spec} />
    </div>
  );
}

/** The shared import/export panel: download JSON, paste/upload, validate+preview, then apply or roll back. */
export function ImportExport({ spec }: { spec: Spec }) {
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
  // A payload-scoped submission key so a lost-response retry of the preview replays the stored job instead of
  // creating a duplicate; it rotates automatically when the document, mode or dry-run flag changes.
  const previewKey = useSubmitKey();

  async function download() {
    const url = spec.exportUrl + (spec.exportUrl.startsWith('/v1/inventory') && site ? `?site=${site.code}` : '');
    const doc = await get<unknown>(url);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })), download: spec.file });
    a.click(); URL.revokeObjectURL(a.href);
  }

  async function validate() {
    setErr(null); setPreview(null); setStatus('');
    try {
      const url = spec.importUrl({ mode, dryRun });
      const key = previewKey.key(`${url}\n${text}`);
      setPreview(await request<Preview>('POST', url, { text }, { 'idempotency-key': key }));
    }
    catch (e) { if (e instanceof ApiError) setErr({ message: e.message, details: e.details }); else throw e; }
  }

  async function act(kind: 'apply' | 'rollback', job: string) {
    setErr(null);
    try {
      // apply/rollback are idempotent routes (Idempotency-Key required); a per-job key makes a lost-response retry safe.
      await request('POST', `${spec.importUrl({ mode, dryRun }).split('?')[0]}/${job}/${kind}`, undefined, { 'idempotency-key': `bulk-${kind}-${job}` });
      setStatus(kind === 'apply' ? t('inv.applied') : t('inv.rolledBack'));
      setLastApplied(kind === 'apply' ? job : null);
      setPreview(null);
    } catch (e) { if (e instanceof ApiError) setErr({ message: e.message, details: e.details }); }
  }

  const s = preview?.summary;
  const empty = s && Object.values(s).every((n) => !n);
  const rows = preview ? Object.entries(preview.diff).filter(([, v]) => Array.isArray(v)) : [];
  return (
    <section className="card stack">
      <div className="row"><button className="btn" onClick={download}>{t('inv.export')}</button></div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} dir="ltr" aria-label={t('inv.paste')} placeholder={t('inv.paste')} />
      <div className="row">
        <input ref={file} type="file" accept="application/json,.json" aria-label={t('common.chooseFile')} hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <button className="btn" onClick={() => file.current?.click()}>{t('inv.upload')}</button>
        {spec.modes && (
          <label className="row"><span>{t('inv.mode')}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}><option value="merge">{t('inv.merge')}</option><option value="replace">{t('inv.replace')}</option></select></label>
        )}
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
      {status && <div className="banner" role="status">{status}</div>}
      {preview && s && (
        <section className="stack">
          <div className="row">{Object.entries(s).map(([k, n]) => <span key={k} className="muted">{k}: {n}</span>)}</div>
          {empty && <div className="banner">{t('inv.empty')}</div>}
          <div className="tablewrap" style={{ maxBlockSize: 320, overflow: 'auto' }}><table><tbody>
            {rows.flatMap(([k, list]) => (list).slice(0, 200).map((item, i) => (
              <tr key={`${k}${i}`}><td className="muted">{k}</td><td dir="ltr"><code>{JSON.stringify(item)}</code></td></tr>
            )))}
          </tbody></table></div>
          <div className="row">
            <button className="btn primary" disabled={preview.dryRun || !!s.conflicts || !!s.errors || !!empty} onClick={() => act('apply', preview.job)}>{t('common.apply')}</button>
            <button className="btn" onClick={() => setPreview(null)}>{t('common.cancel')}</button>
          </div>
        </section>
      )}
      {lastApplied && <div className="row"><span className="muted">{t('inv.lastJob')}</span><button className="btn danger" onClick={() => { if (confirm(t('inv.rollbackConfirm'))) void act('rollback', lastApplied); }}>{t('common.rollback')}</button></div>}
    </section>
  );
}
