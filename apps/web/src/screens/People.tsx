import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, patch, post, request } from '../api.js';
import { ROLES, useApp, type Role } from '../app-context.js';
import { useApi, useSubmitKey } from '../components/hooks.js';
import { QueryState } from '../components/QueryState.js';
import { useT } from '../i18n.js';
import { errText } from '../errors.js';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';


interface UnitRow { code: string; name: string; site: string | null; floor: number | null; note: string | null; residents: { id: string; email: string; name: string | null }[]; pass_status: string | null }
interface Member { id: string; email: string; name: string | null; roles: Role[]; superadmin: boolean; unit: string | null; unit_verified: boolean }
interface Invite { email: string; roles: Role[]; superadmin: boolean; unit: string | null }

interface UDiff {
  added: { code: string; name: string }[]; changed: { before: { name: string }; after: { code: string; name: string } }[];
  removed: { code: string; name: string }[]; conflicts: { unit: { code: string }; reason: string }[];
  residentsToAdd: { unit: string; email: string }[]; errors: { path: string; message: string }[];
}
interface UPreview { job: string; dryRun: boolean; summary: Record<string, number>; diff: UDiff }
interface UApplied { added: number; changed: number; removed: number; residents: { added: number; invited: number; created: { email: string; temporaryPassword: string }[]; skipped: { email: string; reason: string }[] } }

export function Units() {
  const t = useT();
  const units = useApi<UnitRow[]>('/v1/units');
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [dryRun, setDryRun] = useState(false);
  const [preview, setPreview] = useState<UPreview | null>(null);
  const [applied, setApplied] = useState<UApplied | null>(null);
  const [ierr, setIerr] = useState<{ message: string; details?: unknown } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { sites, me } = useApp();
  const canEdit = !!me && (me.superadmin || me.roles.includes('admin'));
  const [editing, setEditing] = useState<UnitRow | null>(null);
  const [busy, setBusy] = useState(false);
  const addKey = useSubmitKey();
  // A payload-scoped key for the import preview (rotates when the document/mode/dry-run changes) so a lost-response
  // retry replays the stored job instead of creating a duplicate one; apply/rollback use a stable per-job key.
  const importKey = useSubmitKey();
  const body = (f: Record<string, string>) => ({ name: f.name, site: f.site || null, floor: f.floor === '' || f.floor === undefined ? null : Number(f.floor), note: f.note || null });

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return; // block a double submit; the pending button is also disabled
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    // The submission-scoped Idempotency-Key is reused on every retry, so a lost-response retry replays the original
    // create instead of a false "unit exists". It rotates only after a success, so the NEXT create is a distinct
    // request; a definitive error stores nothing, so a corrected resubmit with the same key simply proceeds.
    const payload = { code: f.code, ...body(f), site: f.site || undefined };
    try { await post('/v1/units', payload, addKey.key(`POST /v1/units ${JSON.stringify(payload)}`)); addKey.rotate(); form.reset(); setErr(''); await units.reload(); }
    catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  }
  async function saveUnit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try { await patch(`/v1/units/${encodeURIComponent(editing!.code)}`, body(f)); setEditing(null); setErr(''); await units.reload(); } catch (x) { setErr(errText(x)); }
  }
  async function removeUnit(code: string) { try { await del(`/v1/units/${encodeURIComponent(code)}`); setErr(''); await units.reload(); } catch (x) { setErr(errText(x)); } }
  const siteSelect = (value: string) => sites.length > 0 && (
    <label className="field">{t('units.site')}
      <NativeSelect name="site" defaultValue={value}><option value="">–</option>{sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</NativeSelect></label>
  );

  async function download() {
    const doc = await request<unknown>('GET', '/v1/units/export');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })), download: 'units.json' });
    a.click(); URL.revokeObjectURL(a.href);
  }

  async function validate() {
    setIerr(null); setPreview(null); setApplied(null);
    const url = '/v1/units/import?mode=' + mode + '&dryRun=' + dryRun;
    try { setPreview(await post<UPreview>(url, { text }, importKey.key(`${url}\n${text}`))); }
    catch (x) { if (x instanceof ApiError) setIerr({ message: x.message, details: x.details }); else throw x; }
  }

  async function applyImport() {
    if (!preview) return;
    setIerr(null);
    try { setApplied((await post<{ applied: UApplied }>(`/v1/units/import/${preview.job}/apply`, undefined, `units-apply-${preview.job}`)).applied); setPreview(null); await units.reload(); }
    catch (x) { if (x instanceof ApiError) setIerr({ message: x.message, details: x.details }); }
  }

  const s = preview?.summary;
  const nothing = s && !s.added && !s.changed && !s.removed && !s.conflicts && !s.residents;
  return (
    <div className="stack">
      <div className="row between"><h1>{t('units.title')}</h1><Button className="btn" onClick={download}>{t('inv.export')}</Button></div>
      {canEdit && (
        <Card render={<form className="card stack" onSubmit={add} />}>
          <div className="row">
            <label className="field">{t('units.code')}<Input name="code" required maxLength={30} dir="ltr" /></label>
            <label className="field grow">{t('units.name')}<Input name="name" required maxLength={100} /></label>
            {siteSelect('')}
            <label className="field">{t('units.floor')}<Input name="floor" type="number" step={1} min={-20} max={300} dir="ltr" /></label>
          </div>
          <label className="field">{t('units.note')}<Input name="note" maxLength={500} /></label>
          <div><Button type="submit" className="btn primary" disabled={busy}>{t('units.add')}</Button></div>
        </Card>
      )}
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}
      {editing && (
        <Card key={editing.code} render={<form className="card stack" onSubmit={saveUnit} aria-label={t('users.editing', { who: editing.code })} />}>
          <h2>{t('users.editing', { who: editing.code })}</h2>
          <div className="row">
            <label className="field grow">{t('units.name')}<Input name="name" required defaultValue={editing.name} maxLength={100} /></label>
            {siteSelect(editing.site ?? '')}
            <label className="field">{t('units.floor')}<Input name="floor" type="number" step={1} min={-20} max={300} defaultValue={editing.floor ?? ''} dir="ltr" /></label>
          </div>
          <label className="field">{t('units.note')}<Input name="note" defaultValue={editing.note ?? ''} maxLength={500} /></label>
          <div className="row"><Button type="submit" className="btn primary">{t('common.save')}</Button><Button type="button" className="btn" onClick={() => setEditing(null)}>{t('common.cancel')}</Button></div>
        </Card>
      )}
      <div className="tablewrap"><Table>
        <TableHeader><TableRow><TableHead>{t('units.code')}</TableHead><TableHead>{t('units.name')}</TableHead><TableHead>{t('units.site')}</TableHead><TableHead className="num">{t('units.floor')}</TableHead><TableHead>{t('units.residents')}</TableHead><TableHead>{t('units.pass')}</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>{units.data?.map((u) => (
          <TableRow key={u.code}>
            <TableCell dir="ltr">{u.code}</TableCell><TableCell>{u.name}{u.note ? <div className="muted">{u.note}</div> : null}</TableCell><TableCell>{u.site ?? '–'}</TableCell><TableCell className="num">{u.floor ?? '–'}</TableCell>
            <TableCell>{u.residents.length ? u.residents.map((r, i) => <span key={r.id}>{i > 0 && ', '}<Link to="../users">{r.name || r.email}</Link></span>) : '–'}</TableCell>
            <TableCell>{u.pass_status ? <Badge className={`pill ${u.pass_status === 'checked_in' ? 'info' : 'ok'}`}>{t(`res.status_${u.pass_status}`)}</Badge> : '–'}</TableCell>
            <TableCell>{canEdit && <div className="row">
              <Button type="button" className="btn" onClick={() => setEditing(u)}>{t('users.edit')}</Button>
              <Button type="button" className="btn danger" disabled={u.residents.length > 0 || !!u.pass_status} title={u.residents.length || u.pass_status ? t('units.inUse') : undefined} onClick={() => void removeUnit(u.code)}>{t('common.remove')}</Button>
            </div>}</TableCell>
          </TableRow>
        ))}</TableBody>
      </Table></div>

      <Card className="card stack">
        <h2>{t('units.importTitle')}</h2>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} dir="ltr" aria-label={t('inv.paste')} placeholder={t('inv.paste')} />
        <div className="row">
          <Input ref={file} type="file" accept="application/json,.json" aria-label={t('common.chooseFile')} hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
          <Button type="button" className="btn" onClick={() => file.current?.click()}>{t('inv.upload')}</Button>
          <label className="row"><span>{t('inv.mode')}</span>
            <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}><option value="merge">{t('inv.merge')}</option><option value="replace">{t('inv.replace')}</option></NativeSelect></label>
          <label className="row"><Checkbox checked={dryRun} onCheckedChange={(checked) => setDryRun(checked === true)} />{t('inv.dryRun')}</label>
          <Button type="button" className="btn primary" disabled={!text.trim()} onClick={validate}>{t('inv.validate')}</Button>
        </div>
        {ierr && (
          <Alert variant="destructive" className="banner bad" role="alert">
            {ierr.message}
            {Array.isArray(ierr.details) && <ul>{(ierr.details as { path?: string; message?: string; reason?: string; unit?: { code: string } }[]).map((d, i) => <li key={i}><code>{d.path ?? d.unit?.code}</code> {d.message ?? d.reason}</li>)}</ul>}
            {!!ierr.details && !Array.isArray(ierr.details) && 'line' in (ierr.details as object) && <div>{t('inv.line', ierr.details as Record<string, unknown>)}</div>}
          </Alert>
        )}
      </Card>

      {preview && s && (
        <Card className="card stack">
          <div className="row">
            <span className="diff-added">+{s.added} {t('units.added')}</span><span className="diff-changed">~{s.changed} {t('units.changed')}</span>
            <span className="diff-retired">−{s.removed} {t('units.removed')}</span><span className="diff-conflicts">!{s.conflicts} {t('inv.conflicts')}</span>
            <span className="diff-added">+{s.residents} {t('units.residentsAdd')}</span>
          </div>
          {nothing && <Alert className="banner">{t('inv.empty')}</Alert>}
          {preview.diff.errors.length > 0 && <Alert variant="destructive" className="banner bad">{preview.diff.errors.map((e) => e.message).join(', ')}</Alert>}
          <div className="tablewrap" style={{ maxBlockSize: 280, overflow: 'auto' }}><Table><TableBody>
            {preview.diff.added.map((u) => <TableRow key={`a${u.code}`}><TableCell className="diff-added">+</TableCell><TableCell>{u.code}</TableCell><TableCell>{u.name}</TableCell></TableRow>)}
            {preview.diff.changed.map((c) => <TableRow key={`c${c.after.code}`}><TableCell className="diff-changed">~</TableCell><TableCell>{c.after.code}</TableCell><TableCell>{c.before.name} → {c.after.name}</TableCell></TableRow>)}
            {preview.diff.removed.map((u) => <TableRow key={`r${u.code}`}><TableCell className="diff-retired">−</TableCell><TableCell>{u.code}</TableCell><TableCell>{u.name}</TableCell></TableRow>)}
            {preview.diff.conflicts.map((c) => <TableRow key={`x${c.unit.code}`}><TableCell className="diff-conflicts">!</TableCell><TableCell>{c.unit.code}</TableCell><TableCell>{c.reason}</TableCell></TableRow>)}
            {preview.diff.residentsToAdd.map((r) => <TableRow key={`u${r.unit}${r.email}`}><TableCell className="diff-added">+</TableCell><TableCell>{r.unit}</TableCell><TableCell>{r.email}</TableCell></TableRow>)}
          </TableBody></Table></div>
          <div className="row">
            <Button type="button" className="btn primary" disabled={preview.dryRun || !!s.conflicts || !!s.errors || !!nothing} onClick={applyImport}>{t('common.apply')}</Button>
            <Button type="button" className="btn" onClick={() => setPreview(null)}>{t('common.cancel')}</Button>
          </div>
        </Card>
      )}

      {applied && (
        <Alert className="banner stack" role="status">
          <strong>{t('units.importDone')}</strong>
          <div>+{applied.added} {t('units.added')} · ~{applied.changed} {t('units.changed')} · −{applied.removed} {t('units.removed')} · +{applied.residents.added} {t('units.residents')}</div>
          {applied.residents.created.map((c) => <div key={c.email} dir="ltr">{c.email}: {c.temporaryPassword ? t('users.tempPassword', { password: c.temporaryPassword }) : t('users.tempPasswordLost')}</div>)}
          {applied.residents.skipped.map((c) => <div key={c.email}>{t('units.skipped')}: {c.email} ({c.reason})</div>)}
        </Alert>
      )}
    </div>
  );
}

/** Role checkboxes, least to most access, each with what it allows. Super Admin is shown only to Super Admins. */
function RoleBoxes({ roles, superadmin, canSuper, onChange, idPrefix }: {
  roles: Role[]; superadmin: boolean; canSuper: boolean; idPrefix: string;
  onChange: (next: { roles: Role[]; superadmin: boolean }) => void;
}) {
  const t = useT();
  const toggle = (r: Role) => onChange({ superadmin, roles: ROLES.filter((x) => (x === r ? !roles.includes(x) : roles.includes(x))) });
  return (
    <fieldset className="roles">
      <legend>{t('users.roles')}</legend>
      {ROLES.map((r) => (
        <div key={r} className="rolebox">
          <Checkbox id={`${idPrefix}-${r}`} checked={roles.includes(r)} onCheckedChange={() => toggle(r)} />
          <label htmlFor={`${idPrefix}-${r}`}><strong>{t(`role.${r}`)}</strong><small>{t(`roledesc.${r}`)}</small></label>
        </div>
      ))}
      {canSuper && (
        <div className="rolebox">
          <Checkbox id={`${idPrefix}-superadmin`} checked={superadmin} onCheckedChange={(checked) => onChange({ roles, superadmin: checked === true })} />
          <label htmlFor={`${idPrefix}-superadmin`}><strong>{t('role.superadmin')}</strong><small>{t('roledesc.superadmin')}</small></label>
        </div>
      )}
    </fieldset>
  );
}

const roleLabel = (t: (k: string) => string, roles: Role[], superadmin = false) =>
  [...ROLES.filter((r) => roles.includes(r)).map((r) => t(`role.${r}`)), ...(superadmin ? [t('role.superadmin')] : [])].join(' · ');

interface Editing { kind: 'member' | 'invite'; id: string; who: string; roles: Role[]; superadmin: boolean; unit: string }

export function People() {
  const t = useT();
  const { me } = useApp();
  const users = useApi<{ members: Member[]; invites: Invite[] }>('/v1/users');
  const units = useApi<UnitRow[]>('/v1/units');
  const [roles, setRoles] = useState<Role[]>(['attendant']);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [newUnit, setNewUnit] = useState('');
  const [newSuper, setNewSuper] = useState(false);
  // A Super Admin can place a person in any property, with a unit of that property.
  const [prop, setProp] = useState(me!.tenant.slug);
  const allProps = useApi<{ slug: string; name: string }[]>(me?.superadmin ? '/v1/platform/tenants' : null);
  const otherUnits = useApi<UnitRow[]>(me?.superadmin && prop !== me.tenant.slug ? `/v1/platform/tenants/${prop}/units` : null, [prop]);
  const propUnits = prop === me!.tenant.slug ? units.data : otherUnits.loading ? null : otherUnits.data;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const inviteKey = useSubmitKey();
  // Anyone who may edit people sees this screen; only a Super Admin may grant Super Admin.
  const canEdit = !!me && (me.superadmin || me.roles.includes('admin'));
  const canSuper = !!me?.superadmin;

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return; // block a double submit; the pending button is also disabled
    const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setErr(''); setMsg('');
    if (!roles.length) { setErr(t('users.noRole')); return; }
    if (roles.includes('resident') && !f.unit) { setErr(t('err.unit_required')); return; }
    setBusy(true);
    // The submission-scoped Idempotency-Key is reused on every retry so a lost-response retry replays the original
    // create (one account, one invite, one audit) instead of reaching a false "already belongs" conflict. It rotates
    // only after a success so the next person is a distinct request.
    const path = prop === me!.tenant.slug ? '/v1/users' : `/v1/platform/tenants/${prop}/members`;
    const payload = { email: f.email, name: f.name || undefined, roles, unit: roles.includes('resident') ? f.unit : undefined, superadmin: newSuper || undefined };
    try {
      const r = await post<{ temporaryPassword?: string; invited?: boolean }>(path, payload, inviteKey.key(`POST ${path} ${JSON.stringify(payload)}`));
      inviteKey.rotate();
      setMsg(r.temporaryPassword ? t('users.tempPassword', { password: r.temporaryPassword }) : t('users.invited'));
      form.reset(); setRoles(['attendant']); setNewUnit(''); setNewSuper(false); await users.reload();
    } catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) { try { await del(`/v1/users/${id}`); setErr(''); await users.reload(); } catch (x) { setErr(errText(x)); } }
  async function verify(id: string) { try { await request('PATCH', `/v1/users/${id}/verify`, undefined, { 'idempotency-key': `verify-${id}` }); setErr(''); await users.reload(); } catch (x) { setErr(errText(x)); } }
  async function removeInvite(email: string) { try { await del(`/v1/invites/${encodeURIComponent(email)}`); setErr(''); await users.reload(); } catch (x) { setErr(errText(x)); } }
  async function save() {
    if (!editing) return;
    if (!editing.roles.length) { setErr(t('users.noRole')); return; }
    const unit = editing.roles.includes('resident') ? editing.unit : null;
    try {
      if (editing.kind === 'member') await patch(`/v1/users/${editing.id}`, { roles: editing.roles, unit, ...(canSuper ? { superadmin: editing.superadmin } : {}) });
      else await patch(`/v1/invites/${encodeURIComponent(editing.id)}`, { roles: editing.roles, unit, ...(canSuper ? { superadmin: editing.superadmin } : {}) });
      setErr(''); setEditing(null); await users.reload();
    } catch (x) { setErr(errText(x)); }
  }
  /** The unit picker for a property. With no units it says so and links to where they are made, instead of asking for one that cannot exist. */
  const unitSelect = (value: string, onChange: (v: string) => void, list: UnitRow[] | null | undefined, slug: string, name?: string) => (
    list && list.length === 0 ? (
      <Alert className="banner warn" role="status">{t('users.noUnits')} <Link to={`/t/${slug}/units`}>{t('users.addUnits')}</Link></Alert>
    ) : (
      <label className="field">{t('users.unit')}
        <NativeSelect name={name} required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>–</option>
          {list?.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
        </NativeSelect></label>
    )
  );

  return (
    <div className="stack">
      <h1>{t('users.title')}</h1>
      {canEdit && (
        <Card render={<form className="card stack" onSubmit={invite} />}>
          <h2>{t('users.invite')}</h2>
          <div className="row">
            <label className="field grow">{t('auth.email')}<Input name="email" type="email" required dir="ltr" /></label>
            <label className="field">{t('auth.name')}<Input name="name" /></label>
            {me?.superadmin && !!allProps.data?.length && (
              <label className="field">{t('nav.property')}
                <NativeSelect value={prop} onChange={(e) => { setProp(e.target.value); setNewUnit(''); }}>
                  {allProps.data.map((x) => <option key={x.slug} value={x.slug}>{x.name}</option>)}</NativeSelect></label>
            )}
          </div>
          <RoleBoxes idPrefix="new" roles={roles} superadmin={newSuper} canSuper={canSuper} onChange={(n) => { setRoles(n.roles); setNewSuper(n.superadmin); }} />
          {roles.includes('resident') && unitSelect(newUnit, setNewUnit, propUnits, prop, 'unit')}
          <div><Button type="submit" className="btn primary" disabled={busy}>{t('users.invite')}</Button></div>
        </Card>
      )}
      {msg && <Alert className="banner" role="status">{msg}</Alert>}
      {err && <Alert variant="destructive" className="banner bad" role="alert">{err}</Alert>}

      {editing && (
        <Card render={<section className="card stack" aria-label={t(editing.kind === 'member' ? 'users.editing' : 'users.editInvite', { who: editing.who })} />}>
          <h2>{t(editing.kind === 'member' ? 'users.editing' : 'users.editInvite', { who: editing.who })}</h2>
          <RoleBoxes idPrefix="edit" roles={editing.roles} superadmin={editing.superadmin} canSuper={canSuper}
            onChange={(n) => setEditing({ ...editing, ...n })} />
          {editing.roles.includes('resident') && unitSelect(editing.unit, (v) => setEditing({ ...editing, unit: v }), units.data, me!.tenant.slug)}
          <div className="row">
            <Button type="button" className="btn primary" onClick={save}>{t('common.save')}</Button>
            <Button type="button" className="btn" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
          </div>
        </Card>
      )}

      <section><h2>{t('users.members')}</h2>
        <div className="tablewrap"><Table>
          <TableHeader><TableRow><TableHead>{t('auth.email')}</TableHead><TableHead>{t('users.roles')}</TableHead><TableHead>{t('users.unit')}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            <QueryState loading={users.loading} error={users.error} empty={!users.data?.members.length} table colSpan={4} />
            {!users.loading && !users.error && users.data?.members.map((m) => (
              <TableRow key={m.id} data-unverified={m.roles.includes('resident') && !m.unit_verified}>
                <TableCell>{m.name ? `${m.name} · ` : ''}{m.email}</TableCell>
                <TableCell>{roleLabel(t, m.roles, m.superadmin)}</TableCell>
                <TableCell>
                  {m.unit ? <Link to="../units" dir="ltr">{m.unit}</Link> : '–'}
                  {m.roles.includes('resident') && (m.unit_verified
                    ? <Badge className="pill ok">{t('users.verified')}</Badge>
                    : <Badge className="pill warn">{t('users.unverified')}</Badge>)}
                </TableCell>
                <TableCell>{canEdit && (
                  <div className="row">
                    {m.roles.includes('resident') && !m.unit_verified && <Button type="button" className="btn primary" onClick={() => verify(m.id)}>{t('users.verifyUnit')}</Button>}
                    <Button type="button" className="btn" onClick={() => setEditing({ kind: 'member', id: m.id, who: m.email, roles: m.roles, superadmin: m.superadmin, unit: m.unit ?? '' })}>{t('users.edit')}</Button>
                    <Button type="button" className="btn danger" onClick={() => remove(m.id)} disabled={m.email === me?.user?.email}>{t('common.remove')}</Button>
                  </div>
                )}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table></div>
      </section>

      {!!users.data?.invites.length && (
        <section><h2>{t('users.pending')}</h2>
          <div className="tablewrap"><Table><TableBody>{users.data.invites.map((i) => (
            <TableRow key={i.email}>
              <TableCell>{i.email}</TableCell><TableCell>{roleLabel(t, i.roles, i.superadmin)}</TableCell><TableCell>{i.unit ?? '–'}</TableCell>
              <TableCell>{canEdit && (
                <div className="row">
                  <Button type="button" className="btn" onClick={() => setEditing({ kind: 'invite', id: i.email, who: i.email, roles: i.roles, superadmin: i.superadmin, unit: i.unit ?? '' })}>{t('users.edit')}</Button>
                  <Button type="button" className="btn danger" onClick={() => removeInvite(i.email)}>{t('common.remove')}</Button>
                </div>
              )}</TableCell>
            </TableRow>
          ))}</TableBody></Table></div>
        </section>
      )}
    </div>
  );
}
