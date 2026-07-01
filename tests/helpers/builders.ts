import { TFile, TFolder } from 'obsidian';

/**
 * Shared object/data builders for the test suite. These replace the per-file
 * copies that re-declared the same fixtures across two dozen suites. The intent
 * is setup-only: nothing here changes what a test asserts, it only removes the
 * duplicated construction.
 */

/** Optional fields a {@link makeFile} caller may want on the POJO file. */
export interface MakeFileOptions {
  /**
   * The Obsidian `stat` block. Only the snapshots external-change suite reads
   * it (for the last-seen mtime/size precheck); it is omitted by default so the
   * built file matches the bare `{ path, name, extension }` shape every other
   * suite uses.
   */
  stat?: { mtime: number; size: number };
}

/**
 * Builds a lightweight POJO file cast to `TFile`. `name` is the path basename
 * and `extension` is derived from that basename (empty when the basename has no
 * dot). This is the richest superset of the variants the suites used: callers
 * that only need `{ path }` or `{ path, name }` are unaffected because the extra
 * fields are derived, not asserted.
 */
export const makeFile = (path: string, opts: MakeFileOptions = {}): TFile => {
  const name: string = path.split('/').pop() ?? path;
  const extension: string = name.includes('.') ? name.split('.').pop() ?? '' : '';

  const file: { path: string; name: string; extension: string; stat?: { mtime: number; size: number } } = {
    path,
    name,
    extension,
  };

  if (opts.stat !== undefined) {
    file.stat = opts.stat;
  }

  return file as unknown as TFile;
};

/**
 * Builds a real `TFile` instance (not a POJO) so `instanceof TFile` holds, for
 * the vault/menu event tests that branch on the abstract-file subtype. `path`,
 * `name` (basename) and `extension` (derived) are populated.
 */
export const makeTFile = (path: string): TFile => {
  const file = new TFile();
  const name: string = path.split('/').pop() ?? path;

  file.path = path;
  file.name = name;
  file.extension = name.includes('.') ? name.split('.').pop() ?? '' : '';

  return file;
};

/**
 * Builds a real `TFolder` instance (not a POJO) so `instanceof TFolder` holds,
 * for the menu event tests that branch on folders. `path` and `name` (basename)
 * are populated.
 */
export const makeFolder = (path: string): TFolder => {
  const folder = new TFolder();
  const name: string = path.split('/').pop() ?? path;

  folder.path = path;
  folder.name = name;

  return folder;
};

/**
 * Builds a minimal container-shaped plugin host for an `@Inject`-decorated
 * service under test. The decorator resolves each field through
 * `this.plugin.get(token)`, so `resolve` maps a requested token to the stub the
 * test wants injected; unmapped tokens resolve to undefined. This lets a test
 * construct a real service instance over a lightweight host and drive its public
 * seam, replacing the prototype-cast harnesses that bypassed construction.
 *
 * The token is typed `unknown` so this stays dependency-light; a caller compares
 * against the concrete tokens it imports and casts the host to the service's
 * constructor parameter at the call site.
 */
export const makeInjectHost = (
  resolve: (token: unknown) => unknown = (): undefined => undefined,
): { get: (token: unknown) => unknown } => ({
  get: resolve,
});
