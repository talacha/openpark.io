import { ApiError } from './api.js';
import { currentLocale, translate } from './i18n.js';

/** A message for any error: the API's error code translated into the current language, else the server's own text. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const key = `err.${e.code}`;
    const msg = translate(currentLocale(), key);
    return msg !== key ? msg : e.message;
  }
  return (e as Error)?.message ?? String(e);
}
