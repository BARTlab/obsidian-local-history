import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { IgnoreListManager } from '@/snapshots/ignore-list';
import type { IgnoreListHost } from '@/snapshots/ignore-list';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';

/**
 * Focused unit tests for {@link IgnoreListManager} (T03).
 *
 * The manager is a plain collaborator (not a DI service) that owns two
 * concerns for {@link SnapshotsService}: the per-file ignore set (add /
 * remove / isIgnored / clear / list) and the exclude-pattern decision
 * (isExcluded), including the warn-once guard that surfaces an invalid
 * regexp to the user exactly once per distinct bad value.
 *
 * Every test drives the manager directly through a minimal
 * {@link IgnoreListHost} stub so the service is never in the loop.
 */

/** Builds a minimal {@link IgnoreListHost} stub backed by jest.fn(). */
const makeHost = (pattern: string = '', caseSensitive: boolean = false): {
  host: IgnoreListHost;
  getExcludePattern: jest.Mock<() => string>;
  getExcludePathsCaseSensitive: jest.Mock<() => boolean>;
  notifyInvalidPattern: jest.Mock<() => void>;
} => {
  const getExcludePattern = jest.fn<() => string>(() => pattern);
  const getExcludePathsCaseSensitive = jest.fn<() => boolean>(() => caseSensitive);
  const notifyInvalidPattern = jest.fn<() => void>();

  const host: IgnoreListHost = {
    getExcludePattern,
    getExcludePathsCaseSensitive,
    notifyInvalidPattern,
  };

  return { host, getExcludePattern, getExcludePathsCaseSensitive, notifyInvalidPattern };
};

// ---------------------------------------------------------------------------
// AC #1 - ignore-set CRUD (add / remove / isIgnored / clear / list)
// ---------------------------------------------------------------------------

describe('IgnoreListManager - ignore-set CRUD', () => {
  let manager: IgnoreListManager;
  let fileA: TFile;
  let fileB: TFile;

  beforeEach(() => {
    const { host } = makeHost();
    manager = new IgnoreListManager(host);
    fileA = makeFile('notes/a.md');
    fileB = makeFile('notes/b.md');
  });

  it('starts empty: isIgnored returns false for an un-added file', () => {
    expect(manager.isIgnored(fileA)).toBe(false);
  });

  it('add - added file is reported as ignored', () => {
    manager.add(fileA);
    expect(manager.isIgnored(fileA)).toBe(true);
  });

  it('add - only the added file is ignored; a different file is not', () => {
    manager.add(fileA);
    expect(manager.isIgnored(fileB)).toBe(false);
  });

  it('remove - removed file is no longer ignored', () => {
    manager.add(fileA);
    manager.remove(fileA);
    expect(manager.isIgnored(fileA)).toBe(false);
  });

  it('remove - removing a file that was never added is a no-op', () => {
    expect(() => manager.remove(fileA)).not.toThrow();
    expect(manager.isIgnored(fileA)).toBe(false);
  });

  it('clear - empties the ignore set', () => {
    manager.add(fileA);
    manager.add(fileB);
    manager.clear();
    expect(manager.isIgnored(fileA)).toBe(false);
    expect(manager.isIgnored(fileB)).toBe(false);
  });

  it('list - returns all currently ignored files', () => {
    manager.add(fileA);
    manager.add(fileB);
    const listed: TFile[] = manager.list();
    expect(listed).toHaveLength(2);
    expect(listed).toContain(fileA);
    expect(listed).toContain(fileB);
  });

  it('list - reflects contents after a remove', () => {
    manager.add(fileA);
    manager.add(fileB);
    manager.remove(fileA);
    const listed: TFile[] = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed).toContain(fileB);
    expect(listed).not.toContain(fileA);
  });

  it('list - returns an empty array after clear', () => {
    manager.add(fileA);
    manager.clear();
    expect(manager.list()).toHaveLength(0);
  });

  it('isIgnored - returns false for a falsy value (null guard)', () => {
    expect(manager.isIgnored(null as unknown as TFile)).toBe(false);
  });

  it('add - is a no-op for a falsy value (null guard)', () => {
    manager.add(null as unknown as TFile);
    expect(manager.list()).toHaveLength(0);
  });

  it('remove - is a no-op for a falsy value (null guard)', () => {
    manager.add(fileA);
    manager.remove(null as unknown as TFile);
    expect(manager.isIgnored(fileA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC #2 - isExcluded with a valid pattern
// ---------------------------------------------------------------------------

describe('IgnoreListManager - isExcluded valid pattern', () => {
  it('returns true for a path that matches the exclude pattern', () => {
    const { host } = makeHost('(^|/)Templates/');
    const manager = new IgnoreListManager(host);
    const file = makeFile('Templates/daily.md');
    expect(manager.isExcluded(file)).toBe(true);
  });

  it('returns false for a path that does not match the exclude pattern', () => {
    const { host } = makeHost('(^|/)Templates/');
    const manager = new IgnoreListManager(host);
    const file = makeFile('notes/daily.md');
    expect(manager.isExcluded(file)).toBe(false);
  });

  it('returns false when the exclude pattern is empty (nothing excluded)', () => {
    const { host } = makeHost('');
    const manager = new IgnoreListManager(host);
    const file = makeFile('Templates/daily.md');
    expect(manager.isExcluded(file)).toBe(false);
  });

  it('returns false for a falsy file (null guard)', () => {
    const { host } = makeHost('(^|/)Templates/');
    const manager = new IgnoreListManager(host);
    expect(manager.isExcluded(null as unknown as TFile)).toBe(false);
  });

  it('does not call notifyInvalidPattern for a valid pattern', () => {
    const { host, notifyInvalidPattern } = makeHost('(^|/)Templates/');
    const manager = new IgnoreListManager(host);
    manager.isExcluded(makeFile('Templates/daily.md'));
    expect(notifyInvalidPattern).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC #3 - warn-once guard for an invalid pattern
// ---------------------------------------------------------------------------

describe('IgnoreListManager - warn-once guard (invalid pattern)', () => {
  it('calls notifyInvalidPattern exactly once for the first bad-pattern call', () => {
    const { host, notifyInvalidPattern } = makeHost('[unclosed');
    const manager = new IgnoreListManager(host);
    manager.isExcluded(makeFile('notes/a.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(1);
  });

  it('does NOT call notifyInvalidPattern again on a second call with the same bad pattern', () => {
    const { host, notifyInvalidPattern } = makeHost('[unclosed');
    const manager = new IgnoreListManager(host);
    manager.isExcluded(makeFile('notes/a.md'));
    manager.isExcluded(makeFile('notes/b.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(1);
  });

  it('fires again when the bad pattern text changes to a new bad pattern', () => {
    let pattern: string = '[bad1';
    const getExcludePattern = jest.fn<() => string>(() => pattern);
    const getExcludePathsCaseSensitive = jest.fn<() => boolean>(() => false);
    const notifyInvalidPattern = jest.fn<() => void>();
    const host: IgnoreListHost = { getExcludePattern, getExcludePathsCaseSensitive, notifyInvalidPattern };
    const manager = new IgnoreListManager(host);

    manager.isExcluded(makeFile('notes/a.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(1);

    pattern = '[bad2';
    manager.isExcluded(makeFile('notes/a.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(2);
  });

  it('resets the guard when the pattern becomes valid after being bad', () => {
    let pattern: string = '[bad';
    const getExcludePattern = jest.fn<() => string>(() => pattern);
    const getExcludePathsCaseSensitive = jest.fn<() => boolean>(() => false);
    const notifyInvalidPattern = jest.fn<() => void>();
    const host: IgnoreListHost = { getExcludePattern, getExcludePathsCaseSensitive, notifyInvalidPattern };
    const manager = new IgnoreListManager(host);

    // First call: bad pattern - warns once.
    manager.isExcluded(makeFile('notes/a.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(1);

    // Switch to a valid pattern - guard is reset, no new warning.
    pattern = '(^|/)Templates/';
    manager.isExcluded(makeFile('notes/a.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(1);

    // Switch back to the same bad pattern - guard fires once more.
    pattern = '[bad';
    manager.isExcluded(makeFile('notes/a.md'));
    expect(notifyInvalidPattern).toHaveBeenCalledTimes(2);
  });

  it('isExcluded returns false (excludes nothing) for an invalid pattern', () => {
    const { host } = makeHost('[unclosed');
    const manager = new IgnoreListManager(host);
    expect(manager.isExcluded(makeFile('notes/a.md'))).toBe(false);
  });

  it('still reads getExcludePattern on every call (host is polled, not cached)', () => {
    const { host, getExcludePattern } = makeHost('(^|/)Templates/');
    const manager = new IgnoreListManager(host);
    manager.isExcluded(makeFile('a.md'));
    manager.isExcluded(makeFile('b.md'));
    expect(getExcludePattern).toHaveBeenCalledTimes(2);
  });
});
