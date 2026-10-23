import { useRef, useState } from 'react';
import { ApiError, get, request } from '../api.js';
import { useApp } from '../app-context.js';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
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
      <div className="row"><Button variant="outline" className="btn" onClick={download}>{t('inv.export')}</Button></div>
      <Card className="card stack">
        <h2>{t('inv.paste')}</h2>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} dir="ltr" aria-label={t('inv.paste')} />
        <div className="row">
          <Input ref={file} type="file" accept="application/json,.json" aria-label={t('common.chooseFile')} hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
          <Button variant="outline" className="btn" onClick={() => file.current?.click()}>{t('inv.upload')}</Button>
          <label className="row"><span>{t('inv.mode')}</span>
            <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}><option value="merge">{t('inv.merge')}</option><option value="replace">{t('inv.replace')}</option></NativeSelect>
          </label>
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
      </Card>
      {status && <Alert className="banner">{status}</Alert>}
      {preview && s && (
        <Card className="card stack">
          <div className="row">
            <span className="diff-added">+{s.added} {t('inv.added')}</span><span className="diff-changed">~{s.changed} {t('inv.changed')}</span>
            <span className="diff-retired">−{s.retired} {t('inv.retired')}</span><span className="diff-conflicts">!{s.conflicts} {t('inv.conflicts')}</span>
          </div>
          {empty && <Alert className="banner">{t('inv.empty')}</Alert>}
          <div className="tablewrap" style={{ maxBlockSize: 320, overflow: 'auto' }}><Table><TableBody>
            {preview.diff.added.slice(0, 200).map((x) => <TableRow key={`a${x.site}${x.code}`}><TableCell className="diff-added">+</TableCell><TableCell>{x.site}</TableCell><TableCell>{x.code}</TableCell><TableCell>{x.type}</TableCell></TableRow>)}
            {preview.diff.changed.slice(0, 200).map((x) => <TableRow key={`c${x.after.site}${x.after.code}`}><TableCell className="diff-changed">~</TableCell><TableCell>{x.after.site}</TableCell><TableCell>{x.after.code}</TableCell><TableCell>{x.before.type} → {x.after.type}</TableCell></TableRow>)}
            {preview.diff.retired.slice(0, 200).map((x) => <TableRow key={`r${x.site}${x.code}`}><TableCell className="diff-retired">−</TableCell><TableCell>{x.site}</TableCell><TableCell>{x.code}</TableCell><TableCell>{x.type}</TableCell></TableRow>)}
            {preview.diff.conflicts.map((x) => <TableRow key={`x${x.slot.site}${x.slot.code}`}><TableCell className="diff-conflicts">!</TableCell><TableCell>{x.slot.site}</TableCell><TableCell>{x.slot.code}</TableCell><TableCell>{x.reason}</TableCell></TableRow>)}
          </TableBody></Table></div>
          <div className="row">
            <Button className="btn primary" disabled={preview.dryRun || !!s.conflicts || !!empty} onClick={() => act('apply', preview.job)}>{t('common.apply')}</Button>
            <Button variant="outline" className="btn" onClick={() => setPreview(null)}>{t('common.cancel')}</Button>
          </div>
        </Card>
      )}
      {lastApplied && <div className="row"><span className="muted">{t('inv.lastJob')}</span><Button variant="destructive" className="btn danger" onClick={() => act('rollback', lastApplied)}>{t('common.rollback')}</Button></div>}
    </div>
  );
}
