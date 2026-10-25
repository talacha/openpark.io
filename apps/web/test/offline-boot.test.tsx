/** Offline boot snapshot tests */
import { describe, expect, it, vi } from 'vitest';
import { saveSnapshot, loadSnapshot, clearSnapshot, isSnapshotExpired } from '../src/offline-cache/indexeddb.js';

describe('isSnapshotExpired', () => {
  it('should return false for recent snapshot', () => {
    const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    expect(isSnapshotExpired(recentDate)).toBe(false);
  });

  it('should return true for snapshot older than 7 days', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    expect(isSnapshotExpired(oldDate)).toBe(true);
  });

  it('should return false for exactly 7 days', () => {
    const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSnapshotExpired(sevenDays)).toBe(false);
  });
});

describe('isSnapshotExpired edge cases', () => {
  it('should return false for 6.99 days', () => {
    const nearlySeven = new Date(Date.now() - 6.99 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSnapshotExpired(nearlySeven)).toBe(false);
  });

  it('should return true for 7.01 days', () => {
    const overSeven = new Date(Date.now() - 7.01 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSnapshotExpired(overSeven)).toBe(true);
  });
});
