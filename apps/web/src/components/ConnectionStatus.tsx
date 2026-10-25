import { Link } from 'react-router-dom';
import { Badge } from './ui/badge.js';
import { useSync } from '../sync/useSync.js';
import { useT } from '../i18n.js';
import { cn } from 'cn';
import { Spinner } from './ui/spinner.js';

export function ConnectionStatus() {
  const t = useT();
  const sync = useSync();

  if (sync.status === 'online') {
    return (
      <Badge variant="outline" role="status" aria-live="polite" aria-label={t('sync.statusOnline')} className="min-w-[100px]">
        <span className="size-2 rounded-full bg-current opacity-70"></span>
        <span className="ms-2">{t('sync.statusOnline')}</span>
      </Badge>
    );
  }

  if (sync.status === 'offline') {
    return (
      <Badge variant="outline" role="status" aria-live="polite" aria-label={t('sync.statusOffline')} className="min-w-[100px]">
        <span className="size-2 rounded-full bg-current opacity-70"></span>
        <span className="ms-2">{t('sync.statusOffline')}</span>
      </Badge>
    );
  }

  if (sync.status === 'syncing') {
    return (
      <Badge variant="outline" role="status" aria-live="polite" aria-label={t('sync.statusSyncing', { count: sync.pending })} className="min-w-[120px]">
        <Spinner className="me-1 size-3" />
        <span>{t('sync.statusSyncing', { count: sync.pending })}</span>
      </Badge>
    );
  }

  // attention - conflicts or failed items exist
  const count = sync.conflicts + sync.failed;
  return (
    <Link
      to="/queue"
      className={cn(
        'inline-flex items-center gap-1 rounded-4xl border border-transparent bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 no-underline min-w-[140px]',
        'rtl:flex-row-reverse'
      )}
      role="status"
      aria-live="polite"
      aria-label={t('sync.statusNeedsAttention', { count })}
      title={t('sync.statusNeedsAttention', { count })}
    >
      <span className="size-2 rounded-full bg-current opacity-70"></span>
      <span>{t('sync.statusNeedsAttention', { count })}</span>
    </Link>
  );
}
