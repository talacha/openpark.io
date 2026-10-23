import { Alert } from '@/components/ui/alert';
import { TableCell, TableRow } from '@/components/ui/table';
import { useT } from '../i18n.js';

interface QueryStateProps {
  loading: boolean;
  error: string;
  empty: boolean;
  emptyLabel?: string;
  table?: boolean;
  colSpan?: number;
}

export function QueryState({ loading, error, empty, emptyLabel, table = false, colSpan = 1 }: QueryStateProps) {
  const t = useT();
  if (!loading && !error && !empty) return null;
  const text = loading ? t('common.loading') : error || emptyLabel || t('common.none');
  const role = loading ? 'status' : error ? 'alert' : undefined;

  if (table) {
    return <TableRow><TableCell colSpan={colSpan}><span role={role}>{text}</span></TableCell></TableRow>;
  }
  if (error) return <Alert variant="destructive" className="banner bad" role="alert">{text}</Alert>;
  return <p className="muted" role={role}>{text}</p>;
}
