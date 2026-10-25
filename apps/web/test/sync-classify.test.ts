import {describe, it, expect} from 'vitest';
import {classify, Classification} from '../src/sync/classify.js';

describe('classify', () => {
  const tests: Array<{name: string; input: Parameters<typeof classify>[0]; expected: Classification}> = [
    // Success cases
    {name: '200 OK', input: {status: 200}, expected: 'done'},
    {name: '201 Created', input: {status: 201}, expected: 'done'},
    {name: '204 No Content', input: {status: 204}, expected: 'done'},

    // Authentication
    {name: '401 Unauthorized', input: {status: 401}, expected: 'auth'},

    // Retryable errors
    {name: 'network error (status 0)', input: {status: 0}, expected: 'retry'},
    {name: '408 Request Timeout', input: {status: 408}, expected: 'retry'},
    {name: '425 Too Early', input: {status: 425}, expected: 'retry'},
    {name: '429 Too Many Requests', input: {status: 429}, expected: 'retry'},
    {name: '500 Internal Server Error', input: {status: 500}, expected: 'retry'},
    {name: '502 Bad Gateway', input: {status: 502}, expected: 'retry'},
    {name: '503 Service Unavailable', input: {status: 503}, expected: 'retry'},
    {name: '599 Network Connect Timeout', input: {status: 599}, expected: 'retry'},

    // 409 with code 'request_in_progress' is retryable
    {name: '409 request_in_progress (retryable)', input: {status: 409, code: 'request_in_progress'}, expected: 'retry'},

    // Conflict cases (terminal, no auto-retry)
    {name: '403 Forbidden', input: {status: 403}, expected: 'conflict'},
    {name: '404 Not Found', input: {status: 404}, expected: 'conflict'},
    {name: '409 Conflict (other)', input: {status: 409, code: 'slot_unavailable'}, expected: 'conflict'},
    {name: '412 Precondition Failed (version mismatch)', input: {status: 412}, expected: 'conflict'},
    {name: '422 Unprocessable Entity', input: {status: 422}, expected: 'conflict'},

    // Other 4xx (should be conflict, not retry)
    {name: '400 Bad Request', input: {status: 400}, expected: 'conflict'},
    {name: '405 Method Not Allowed', input: {status: 405}, expected: 'conflict'},
    {name: '428 Precondition Required', input: {status: 428}, expected: 'conflict'},

    // Details should not affect classification
    {name: '409 with details', input: {status: 409, code: 'version_mismatch', details: {current: {version: 5}}}, expected: 'conflict'},
  ];

  for (const t of tests) {
    it(t.name, () => {
      expect(classify(t.input)).toBe(t.expected);
    });
  }
});
