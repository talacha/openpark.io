/**
 * Response classification for sync engine.
 * Maps HTTP status and error code to sync action.
 */

export type Classification = 'done' | 'retry' | 'conflict' | 'auth' | 'failed';

export interface ClassifyInput {
  status: number;
  code?: string;
  details?: unknown;
}

/**
 * Classification table per PLAN.md + round-2 amendments.
 * - 2xx → done
 * - 401 → auth (pause until engine.resume())
 * - status 0/408/425/429/5xx/409 request_in_progress → retry (with backoff)
 * - 403/404/409 (other)/412/422 → conflict (store details, show in UI)
 * - all other 4xx → conflict
 */
export function classify(input: ClassifyInput): Classification {
  const {status, code} = input;

  // Network error (status 0) is retryable
  if (status === 0 || status === undefined) {
    return 'retry';
  }

  // Success
  if (status >= 200 && status < 300) {
    return 'done';
  }

  // Authentication required
  if (status === 401) {
    return 'auth';
  }

  // Retryable errors
  // 408 Request Timeout
  if (status === 408) {
    return 'retry';
  }

  // 425 Too Early (IDempotency-Key collision, retry with same key)
  if (status === 425) {
    return 'retry';
  }

  // 429 Too Many Requests
  if (status === 429) {
    return 'retry';
  }

  // 5xx server errors
  if (status >= 500 && status < 600) {
    return 'retry';
  }

  // 409 with code 'request_in_progress' is retryable (duplicate in-flight request)
  if (status === 409 && code === 'request_in_progress') {
    return 'retry';
  }

  // Conflict/errors that should not auto-retry
  // 403 Forbidden (permission expired, etc.)
  if (status === 403) {
    return 'conflict';
  }

  // 404 Not Found (no_open_session, session_not_found, etc.)
  if (status === 404) {
    return 'conflict';
  }

  // 409 Conflict (business conflict, version_mismatch, etc.)
  if (status === 409) {
    return 'conflict';
  }

  // 412 Precondition Failed (version mismatch)
  if (status === 412) {
    return 'conflict';
  }

  // 422 Unprocessable Entity (idempotency_key_reuse, validation, etc.)
  if (status === 422) {
    return 'conflict';
  }

  // All other 4xx are treated as conflicts (not retryable)
  if (status >= 400 && status < 500) {
    return 'conflict';
  }

  // Fallback for unexpected statuses
  return 'failed';
}
