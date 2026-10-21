import { useEffect, useState } from 'react';
import { useT } from '../i18n.js';
import { changes, dismissConflict, listConflicts, listQueue, retryConflict, type Conflict, type QueuedWrite } from '../offline.js';

/** Supervisor queue: actions made offline that the server rejected (slot taken, already inside, ...). */
export function Queue() {
  const t = useT();
  const [queue, setQueue] = useState<QueuedWrite[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  useEffect(() => {
    const load = async () => { setQueue(await listQueue()); setConflicts(await listConflicts()); };
    void load(); changes.addEventListener('change', load);
    return () => changes.removeEventListener('change', load);
  }, []);
  const label = (w: QueuedWrite) => {
    const b = w.body as { plate?: { display?: string } | string; site?: string };
    const plate = typeof b.plate === 'string' ? b.plate : b.plate?.display;
    return `${w.method} ${w.path}${plate ? ` · ${plate}` : ''}`;
  };
  return (
    <div className="stack">
      <h1>{t('nav.queue')}</h1>
      <section className="card stack">
        <h2>↻ {queue.length}</h2>
        {queue.map((w) => <div key={w.id} className="row between"><span>{label(w)}</span><span className="muted">{new Date(w.at).toLocaleString()}</span></div>)}
        {!queue.length && <span className="muted">{t('common.none')}</span>}
      </section>
      <section className="card stack">
        <h2>⚠ {conflicts.length}</h2>
        {conflicts.map((c) => (
          <div key={c.id} className="row between">
            <span><strong>{c.code}</strong> {label(c)}<br /><span className="muted">{c.reason}</span></span>
            <div className="row"><button className="btn" onClick={() => retryConflict(c.id!)}>{t('queue.retry')}</button><button className="btn" onClick={() => dismissConflict(c.id!)}>{t('att.done')}</button></div>
          </div>
        ))}
        {!conflicts.length && <span className="muted">{t('common.none')}</span>}
      </section>
    </div>
  );
}
