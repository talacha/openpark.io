import { type ReactNode } from 'react';

interface ViewStateProps<T> {
  loading: boolean;
  error?: Error | string;
  onRetry?: () => void;
  empty?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: ReactNode;
  children: T;
}

export function ViewState<T extends ReactNode>({
  loading,
  error,
  onRetry,
  empty,
  emptyTitle = 'No results',
  emptyBody = 'Try adjusting your filters or add a new item.',
  emptyAction,
  children,
}: ViewStateProps<T>) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    const message = typeof error === 'string' ? error : error.message;
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-center">
        <h3 className="font-semibold text-destructive">An error occurred</h3>
        <p className="text-sm text-muted-foreground mt-1">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-4 inline-flex items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-4 rounded-full bg-muted p-4">
          <div className="h-8 w-8 text-muted-foreground">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
          </div>
        </div>
        <h3 className="font-semibold text-foreground">{emptyTitle}</h3>
        {emptyBody && <p className="text-muted-foreground mt-1">{emptyBody}</p>}
        {emptyAction && <div className="mt-4">{emptyAction}</div>}
      </div>
    );
  }

  return <>{children}</>;
}
