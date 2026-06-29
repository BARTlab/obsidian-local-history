import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ExternalChangeCapture } from '@/snapshots/external-change-capture';
import type { ExternalChangeHost } from '@/snapshots/external-change-capture';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotCaptureOptions } from '@/types';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';
import { flushMicrotasks } from './helpers/async-utils';

/**
 * Tests for {@link ExternalChangeCapture}, the off-editor change-capture
 * collaborator the snapshots service owns. Extracted from the 1103-LOC service,
 * where the debounce, in-flight guard, stat pre-check, and disk-read + hash
 * capture were tangled into one method; these cover the behaviour the
 * `vault.modify` handler relies on:
 *
 * - capture force-captures the new disk content as a `external = true`
 *   `FileVersion` on a hash divergence and brings the cached state in line,
 * - a hash-match disk read is a no-op (no phantom version), and so is an ignored
 *   / first-sight-only / tombstone path,
 * - a first-sight file (no snapshot) routes to the host's `captureFirstSight`,
 * - the stat pre-check short-circuits the disk read when mtime + size are
 *   unchanged from the last seen pass, and
 * - schedule debounces a burst of modify events for one path into a single
 *   trailing capture, and forget cancels a pending timer.
 *
 * A real {@link FileSnapshot} backs the host so the hash compare runs against the
 * genuine `isContentChanged`, not a mock that could mask a collision branch.
 */
describe('ExternalChangeCapture', () => {
  let snapshots: Map<string, FileSnapshot>;
  let vault: Record<string, string>;
  let capturable: boolean;
  let firstSight: jest.Mock<(file: TFile) => Promise<void>>;
  let forceUpdate: jest.Mock;
  let read: jest.Mock<(file: TFile) => Promise<string>>;

  const captureOptions: SnapshotCaptureOptions = {
    enabled: true,
    intervalMs: 0,
    editThreshold: 0,
    maxVersions: 0,
    maxVersionAgeDays: 0,
  };

  const makeHost = (): ExternalChangeHost => {
    const plugin = {
      app: {
        vault: {
          read: (file: TFile): Promise<string> => read(file),
        },
      },
    } as unknown as LineChangeTrackerPlugin;

    return {
      plugin,
      getSnapshot: (path: string): FileSnapshot | undefined => snapshots.get(path),
      isExternallyCapturable: (): boolean => capturable,
      captureFirstSight: (file: TFile): Promise<void> => firstSight(file),
      getCaptureOptions: (): SnapshotCaptureOptions => captureOptions,
      forceUpdate: (): void => {
        forceUpdate();
      },
    };
  };

  /**
   * Seeds a tracked snapshot for `path` whose known state is `content`, mirroring
   * what the service holds after an initial capture.
   *
   * @param {string} path - The vault-relative path
   * @param {string} content - The snapshot's known content
   * @return {FileSnapshot} The seeded snapshot
   */
  const track = (path: string, content: string): FileSnapshot => {
    const snapshot = new FileSnapshot(content);

    snapshots.set(path, snapshot);

    return snapshot;
  };

  beforeEach((): void => {
    snapshots = new Map();
    vault = {};
    capturable = true;
    firstSight = jest.fn(() => Promise.resolve());
    forceUpdate = jest.fn();
    read = jest.fn((file: TFile) => {
      if (!(file.path in vault)) {
        return Promise.reject(new Error(`No content for ${file.path}`));
      }

      return Promise.resolve(vault[file.path]);
    });
  });

  describe('capture', () => {
    it('force-captures the divergent disk content as an external version and syncs state', async () => {
      const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });
      const snapshot = track(file.path, 'one\ntwo\nthree');

      vault[file.path] = 'one\ntwo-external\nthree';

      const capture = new ExternalChangeCapture(makeHost());

      await capture.capture(file);

      expect(snapshot.timeline.getStoredVersions().length).toBe(1);
      expect(snapshot.timeline.getStoredVersions()[0].isExternal()).toBe(true);
      expect(snapshot.timeline.getStoredVersions()[0].getLines()).toEqual(['one', 'two-external', 'three']);
      expect(snapshot.content.getLastStateLines()).toEqual(['one', 'two-external', 'three']);
      expect(forceUpdate).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the disk content matches the known snapshot state', async () => {
      const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });
      const snapshot = track(file.path, 'one\ntwo\nthree');

      vault[file.path] = 'one\ntwo\nthree';

      const capture = new ExternalChangeCapture(makeHost());

      await capture.capture(file);

      expect(snapshot.timeline.getStoredVersions().length).toBe(0);
      expect(forceUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op when the path is not externally capturable', async () => {
      capturable = false;
      const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

      track(file.path, 'one');
      vault[file.path] = 'changed';

      const capture = new ExternalChangeCapture(makeHost());

      await capture.capture(file);

      expect(read).not.toHaveBeenCalled();
      expect(forceUpdate).not.toHaveBeenCalled();
    });

    it('routes a first-sight file (no snapshot) to the host capture and never reads itself', async () => {
      const file = makeFile('notes/new.md', { stat: { mtime: 1, size: 1 } });

      vault[file.path] = 'fresh';

      const capture = new ExternalChangeCapture(makeHost());

      await capture.capture(file);

      expect(firstSight).toHaveBeenCalledTimes(1);
      expect(firstSight).toHaveBeenCalledWith(file);
      expect(read).not.toHaveBeenCalled();
    });

    it('is a no-op for a tombstone path', async () => {
      const file = makeFile('notes/gone.md', { stat: { mtime: 1, size: 1 } });
      const snapshot = track(file.path, 'one');

      snapshot.deletedTimestamp = Date.now();
      expect(snapshot.isTombstone()).toBe(true);
      vault[file.path] = 'resurrected';

      const capture = new ExternalChangeCapture(makeHost());

      await capture.capture(file);

      expect(read).not.toHaveBeenCalled();
      expect(forceUpdate).not.toHaveBeenCalled();
    });

    it('short-circuits the disk read when mtime and size are unchanged from the last pass', async () => {
      const file = makeFile('notes/a.md', { stat: { mtime: 5, size: 9 } });

      track(file.path, 'one\ntwo');
      vault[file.path] = 'one\ntwo-external';

      const capture = new ExternalChangeCapture(makeHost());

      // First pass reads, captures, and records last-seen { mtime: 5, size: 9 }.
      await capture.capture(file);
      expect(read).toHaveBeenCalledTimes(1);

      // Second pass with an identical stat is short-circuited before the read.
      await capture.capture(file);
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('schedule (debounce)', () => {
    beforeEach((): void => {
      jest.useFakeTimers();
    });

    afterEach((): void => {
      jest.useRealTimers();
    });

    it('coalesces a burst of modify events for one path into a single trailing capture', async () => {
      const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

      track(file.path, 'one');
      vault[file.path] = 'one-external';

      const capture = new ExternalChangeCapture(makeHost());

      capture.schedule(file);
      capture.schedule(file);
      capture.schedule(file);

      // No disk read until the debounce window elapses.
      expect(read).not.toHaveBeenCalled();

      jest.advanceTimersByTime(150);
      await flushMicrotasks();

      // Only the trailing call ran the read despite three scheduled events.
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('forget cancels a pending debounce timer so no capture fires', async () => {
      const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

      track(file.path, 'one');
      vault[file.path] = 'one-external';

      const capture = new ExternalChangeCapture(makeHost());

      capture.schedule(file);
      capture.forget(file.path);

      jest.advanceTimersByTime(150);
      await flushMicrotasks();

      expect(read).not.toHaveBeenCalled();
    });
  });
});
