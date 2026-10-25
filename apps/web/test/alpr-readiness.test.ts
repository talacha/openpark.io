/** ALPR reader readiness tests */
import { describe, expect, it, vi } from 'vitest';
import { subscribeReaderReadiness, readerReadiness, prefetchReader } from '../src/alpr/loader.js';

describe('readerReadiness', () => {
  it('should return initial state', () => {
    expect(readerReadiness()).toBe('unavailable');
  });
});

describe('subscribeReaderReadiness', () => {
  it('should call listener immediately with current state', () => {
    const mockFn = vi.fn();
    subscribeReaderReadiness(mockFn);
    expect(mockFn).toHaveBeenCalledWith('unavailable');
  });
});
