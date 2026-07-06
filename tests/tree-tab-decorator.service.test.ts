import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { FolderDeltaStatus } from '@/consts';
import { TreeTabDecoratorService } from '@/services/tree-tab-decorator.service';
import { TOKENS } from '@/services/tokens';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { TFile } from 'obsidian';

import { makeFile, makeInjectHost } from './helpers/builders';

/**
 * Drives a snapshot through a real one-line edit so `getChangesLinesCount()`
 * reports a genuine modification, mirroring the session-status helper tests.
 */
const makeModified = (file: TFile | null, carriedPath?: string): FileSnapshot => {
  const snapshot: FileSnapshot = new FileSnapshot('a\nb\nc', '\n', file);

  if (carriedPath !== undefined) {
    snapshot.path = carriedPath;
  }

  snapshot.trackers.findCurrentLine(1)?.change('B');
  snapshot.content.updateState(['a', 'B', 'c']);
  snapshot.updateChanges();

  return snapshot;
};

/**
 * Builds a snapshot as the persist restore path leaves it: the change map is
 * diff-seeded from the resolved origin (here `a\nb\nc`) against a diverging live
 * document, so it reports its changes-vs-origin and the decorator paints it after
 * a reload without the file ever being opened this session. Passing `origin`
 * equal to the current content yields a truly-unchanged restored file.
 */
const makeRestoredPersist = (
  file: TFile | null,
  carriedPath?: string,
  origin: string[] = ['a', 'b', 'c'],
): FileSnapshot => {
  const snapshot: FileSnapshot = new FileSnapshot('a\nb\nc', '\n', file);

  if (carriedPath !== undefined) {
    snapshot.path = carriedPath;
  }

  snapshot.content.updateState(['a', 'B', 'c']);
  snapshot.seedTrackerFromOrigin(origin);

  return snapshot;
};

/**
 * Exposes the protected `computeStatuses` on a real, fully-constructed service.
 * The `@Inject(TOKENS.snapshots)` field resolves lazily through `plugin.get`, so
 * the service is built over a container host that resolves the snapshots token to
 * a stub reporting the given list, session-created paths, and exclude decision.
 * The host also carries an `app.metadataCache.isUserIgnored` stub for the
 * Obsidian visibility filter. The method reads nothing else, so it runs on
 * genuine instance state instead of a prototype cast that bypassed construction.
 */
class TestTreeTabDecoratorService extends TreeTabDecoratorService {
  public statuses(): Map<string, FolderDeltaStatus> {
    return this.computeStatuses();
  }
}

interface ComputeOpts {
  /** Paths reported as created this session. */
  sessionCreated?: string[];
  /** Paths the snapshots service reports as excluded (our patterns). */
  excluded?: string[];
  /** Paths Obsidian's visibility filter hides (metadataCache.isUserIgnored). */
  ignored?: string[];
}

const computeStatuses = (snapshots: FileSnapshot[], opts: ComputeOpts = {}): Map<string, FolderDeltaStatus> => {
  const { sessionCreated = [], excluded = [], ignored = [] } = opts;

  const snapshotsService = {
    getList: (): FileSnapshot[] => snapshots,
    getSessionCreatedPaths: (): ReadonlySet<string> => new Set(sessionCreated),
    isPathExcluded: (path: string): boolean => excluded.includes(path),
  } as unknown as SnapshotsService;

  const host = {
    ...makeInjectHost((token: unknown): unknown => (token === TOKENS.snapshots ? snapshotsService : undefined)),
    app: { metadataCache: { isUserIgnored: (path: string): boolean => ignored.includes(path) } },
  } as unknown as ConstructorParameters<typeof TreeTabDecoratorService>[0];

  return new TestTreeTabDecoratorService(host).statuses();
};

describe('TreeTabDecoratorService.computeStatuses - path resolution', () => {
  it('tints a live snapshot and its ancestor folders by file.path', () => {
    const statuses = computeStatuses([makeModified(makeFile('folder/sub/note.md'))]);

    expect(statuses.get('folder/sub/note.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder/sub')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder')).toBe(FolderDeltaStatus.modified);
  });

  it('tints a restored snapshot with file = null by its carried path', () => {
    // After a reload a restored snapshot keeps its `modified` status but has
    // file = null until re-captured this session. Reading `file?.path` alone
    // dropped it from the tint map, so the folder stopped painting; the carried
    // path mirrors the map key and must place the file and its folders.
    const statuses = computeStatuses([makeModified(null, 'folder/sub/note.md')]);

    expect(statuses.get('folder/sub/note.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder/sub')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder')).toBe(FolderDeltaStatus.modified);
  });

  it('omits a null-file snapshot that carries no path at all', () => {
    const statuses = computeStatuses([makeModified(null)]);

    expect(statuses.size).toBe(0);
  });

  it('prefers the live file.path over a stale carried path', () => {
    const statuses = computeStatuses([makeModified(makeFile('root/live.md'), 'stale/old.md')]);

    expect(statuses.get('root/live.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.has('stale/old.md')).toBe(false);
    expect(statuses.has('stale')).toBe(false);
  });

  it('paints a restored keep=persist snapshot with real diffs, root and nested alike', () => {
    // At keep=persist the restore path diff-seeds the change map from the resolved
    // origin, so a file whose live content diverges from its origin reports its
    // changes-vs-origin and survives the reload. The decorator must paint the file
    // rows AND their ancestor folders, consistently for a root file and a nested
    // one (the reported blank-tree bug is fixed).
    const rootRestored = makeRestoredPersist(makeFile('root-note.md'));
    const nestedRestored = makeRestoredPersist(makeFile('folder/sub/note.md'));

    const statuses = computeStatuses([rootRestored, nestedRestored]);

    expect(statuses.get('root-note.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder/sub/note.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder/sub')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder')).toBe(FolderDeltaStatus.modified);
  });

  it('paints nothing for a restored file whose content equals its resolved origin', () => {
    // When the live document matches the resolved origin the diff-seed yields no
    // changes, so a truly-unchanged restored file paints neither its row nor its
    // folders (no false positives), root and nested alike.
    const rootClean = makeRestoredPersist(makeFile('root-note.md'), undefined, ['a', 'B', 'c']);
    const nestedClean = makeRestoredPersist(makeFile('folder/sub/note.md'), undefined, ['a', 'B', 'c']);

    const statuses = computeStatuses([rootClean, nestedClean]);

    expect(statuses.size).toBe(0);
  });
});

describe('TreeTabDecoratorService.computeStatuses - visibility filters', () => {
  it('paints neither the file nor its folders when the path is excluded by our patterns', () => {
    const statuses = computeStatuses([makeModified(makeFile('Templates/note.md'))], {
      excluded: ['Templates/note.md'],
    });

    expect(statuses.size).toBe(0);
  });

  it('paints neither the file nor its folders when Obsidian hides the path', () => {
    const statuses = computeStatuses([makeModified(makeFile('folder/sub/note.md'))], {
      ignored: ['folder/sub/note.md'],
    });

    expect(statuses.size).toBe(0);
  });

  it('keeps a folder tinted when it still holds a visible changed file next to a hidden one', () => {
    // Two changed files share a folder; one is hidden by Obsidian. The folder
    // stays modified because the visible sibling still contributes, but the
    // hidden file row itself is not painted.
    const statuses = computeStatuses(
      [makeModified(makeFile('folder/visible.md')), makeModified(makeFile('folder/hidden.md'))],
      { ignored: ['folder/hidden.md'] },
    );

    expect(statuses.get('folder/visible.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.has('folder/hidden.md')).toBe(false);
    expect(statuses.get('folder')).toBe(FolderDeltaStatus.modified);
  });
});
