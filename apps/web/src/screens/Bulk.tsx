import { useRef, useState } from 'react';
import { ApiError, get, request } from '../api.js';
import { useApp } from '../app-context.js';
import { useSubmitKey } from '../components/hooks.js';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '../i18n.js';

/** The four bulk entities, each mapping to its export + import pipeline. Every tab reuses the same validate -> preview
 * -> apply -> rollback UI; only the endpoints and the download file name differ. */
type Entity = 'community' | 'sites' | 'inventory' | 'units' | 'users';
interface Spec { tab: string; exportUrl: string; importUrl: (opts: { mode: string; dryRun: boolean }) => string; file: string; modes: boolean }

const SPECS: Record<Entity, Spec> = {
  // The Community itself (the tenant's surfaced identity: name, address, notes). A tenant-scoped export is one row;
  // it never renames tables or touches tenancy — only the editable scalar fields — satisfying AC-5.2's Community bulk.
  community: { tab: 'bulk.community', exportUrl: '/v1/community/export', importUrl: (o) => `/v1/community/import?dryRun=${o.dryRun}`, file: 'community.json', modes: false },
  // A community's parking facilities (operates on /v1/sites).
  sites: { tab: 'bulk.sites', exportUrl: '/v1/sites/export', importUrl: (o) => `/v1/sites/import?mode=${o.mode}&dryRun=${o.dryRun}`, file: 'sites.json', modes: true },
  inventory: { tab: 'bulk.slots', exportUrl: '/v1/inventory/export', importUrl: (o) => `/v1/inventory/import?mode=${o.mode}&dryRun=${o.dryRun}`, file: 'inventory.json', modes: true },
  units: { tab: 'bulk.units', exportUrl: '/v1/units/export', importUrl: (o) => `/v1/units/import?mode=${o.mode}&dryRun=${o.dryRun}`, file: 'units.json', modes: true },
  users: { tab: 'bulk.users', exportUrl: '/v1/users/export', importUrl: (o) => `/v1/users/import?dryRun=${o.dryRun}`, file: 'users.json', modes: false },
};
const ENTITIES: Entity[] = ['community', 'sites', 'inventory', 'units', 'users'];

interface Preview { job: string; dryRun: boolean; summary: Record<string, number>; diff: Record<string, unknown[]> }

/** One Bulk import/export admin screen with entity tabs. Reuses the shipped import pipeline for each entity. */
export function Bulk() {
  const t = useT();
  const [entity, setEntity] = useState<Entity>('community');
  const spec = SPECS[entity];
  return (
    <div className="stack">
      <h1>{t('bulk.title')}</h1>
      {/* An ordinary toggle-button group (aria-pressed), not an ARIA tabs widget — each entity button is a normal
          tab-stop, so there is no roving-focus / Left-Right contract to half-implement. */}
      <div className="row" role="group" aria-label={t('bulk.title')}>
        {ENTITIES.map((e) => (
          <Button key={e} type="button" variant={entity === e ? 'default' : 'outline'} aria-pressed={entity === e} className={`btn${entity === e ? ' primary' : ''}`} onClick={() => setEntity(e)}>{t(SPECS[e].tab)}</Button>
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
    <Card className="card stack">
      <div className="row"><Button variant="outline" className="btn" onClick={download}>{t('inv.export')}</Button></div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} dir="ltr" aria-label={t('inv.paste')} placeholder={t('inv.paste')} />
      <div className="row">
        <Input ref={file} type="file" accept="application/json,.json" aria-label={t('common.chooseFile')} hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <Button variant="outline" className="btn" onClick={() => file.current?.click()}>{t('inv.upload')}</Button>
        {spec.modes && (
          <label className="row"><span>{t('inv.mode')}</span>
            <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}><option value="merge">{t('inv.merge')}</option><option value="replace">{t('inv.replace')}</option></NativeSelect></label>
        )}
        <label className="row"><Checkbox checked={dryRun} onCheckedChange={(checked) => setDryRun(checked === true)} />{t('inv.dryRun')}</label>
        <Button className="btn primary" disabled={!text.trim()} onClick={validate}>{t('inv.validate')}</Button>
      </div>
      {err && (
        <Alert variant="destructive" className="banner bad" role="alert">
          {err.message}
          {Array.isArray(err.details) && <ul>{(err.details as { path?: string; message?: string }[]).map((d, i) => <li key={i}><code>{d.path}</code> {d.message}</li>)}</ul>}
          {!!err.details && !Array.isArray(err.details) && 'line' in (err.details as object) && <div>{t('inv.line', err.details as Record<string, unknown>)}</div>}
        </Alert>
      )}
      {status && <Alert className="banner" role="status">{status}</Alert>}
      {preview && s && (
        <section className="stack">
          <div className="row">{Object.entries(s).map(([k, n]) => <span key={k} className="muted">{k}: {n}</span>)}</div>
          {empty && <Alert className="banner">{t('inv.empty')}</Alert>}
          <div className="tablewrap" style={{ maxBlockSize: 320, overflow: 'auto' }}><Table><TableBody>
            {rows.flatMap(([k, list]) => (list).slice(0, 200).map((item, i) => (
              <TableRow key={`${k}${i}`}><TableCell className="muted">{k}</TableCell><TableCell dir="ltr"><code>{JSON.stringify(item)}</code></TableCell></TableRow>
            )))}
          </TableBody></Table></div>
          <div className="row">
            <Button className="btn primary" disabled={preview.dryRun || !!s.conflicts || !!s.errors || !!empty} onClick={() => act('apply', preview.job)}>{t('common.apply')}</Button>
            <Button variant="outline" className="btn" onClick={() => setPreview(null)}>{t('common.cancel')}</Button>
          </div>
        </section>
      )}
      {lastApplied && <div className="row"><span className="muted">{t('inv.lastJob')}</span><Button variant="destructive" className="btn danger" onClick={() => { if (confirm(t('inv.rollbackConfirm'))) void act('rollback', lastApplied); }}>{t('common.rollback')}</Button></div>}
    </Card>
  );
}
