import * as Diff from 'diff';

import { VERSION_KEYFRAME_INTERVAL } from '@/consts';
import type { FileVersion } from '@/snapshots/file.version';
import type { SerializedFileVersion } from '@/types';

/**
 * Stateless codec that encodes a materialized `FileVersion[]` into a keyframe +
 * delta entry chain for on-disk persistence, and (T03) decodes that chain back
 * into full-text entries. It holds no state: every method takes the arrays and
 * the line break as explicit arguments, matching the ADR-08 facade-over-
 * stateless-operators rule.
 *
 * Chain shape: version `i` is a keyframe (full `lines`) when
 * `i % VERSION_KEYFRAME_INTERVAL === 0`, otherwise a delta (a unified-diff
 * string, context 0) transforming version `i - 1` into version `i`. Index 0 is
 * always a keyframe, so decode can self-anchor with no baseline argument. The
 * `label` and `external` flags are copied onto either form and omitted when
 * unset, preserving the round-trip parity of the original full-text format.
 *
 * Transport invariant: lines are joined with `\n` purely as patch transport,
 * never the file's real line break. A tracked line is the split product of the
 * file's line break (`\n` or `\r\n`) and so never contains a bare `\n`, which
 * makes the `\n`-join a lossless transport for the diff library (Epic 09).
 */
export class VersionCodec {
  /**
   * Encodes a materialized version timeline (oldest first) into a keyframe +
   * delta entry chain. Recomputed in full on every save: eviction already runs
   * in memory before serialization, so the codec always sees a clean, trimmed
   * array and never has to maintain an incremental on-disk chain.
   *
   * @param {FileVersion[]} versions - The materialized versions, oldest first
   * @param {string} _lineBreak - The file's line break (unused for the patch
   *   transport, which always joins on `\n`; kept for interface symmetry with
   *   decode and the serialization boundary)
   * @return {SerializedFileVersion[]} The keyframe + delta entry chain
   */
  public static encode(versions: FileVersion[], _lineBreak: string): SerializedFileVersion[] {
    if (!Array.isArray(versions) || versions.length === 0) {
      return [];
    }

    const entries: SerializedFileVersion[] = [];

    for (let i: number = 0; i < versions.length; i++) {
      const version: FileVersion = versions[i];
      const isKeyframe: boolean = i % VERSION_KEYFRAME_INTERVAL === 0;

      const entry: SerializedFileVersion = isKeyframe
        ? { timestamp: version.timestamp, lines: version.getLines() }
        : { timestamp: version.timestamp, delta: VersionCodec.diff(versions[i - 1], version) };

      if (version.isLabeled()) {
        entry.label = version.label;
      }

      if (version.isExternal()) {
        entry.external = true;
      }

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Computes the unified-diff string (context 0) transforming the previous
   * version's lines into the current version's lines. Lines are joined with the
   * `\n` transport (see the class transport invariant) so the patch is portable
   * across files regardless of their real line break.
   *
   * @param {FileVersion} previous - The version the delta is anchored against
   * @param {FileVersion} current - The version the delta reconstructs
   * @return {string} The unified-diff patch string
   */
  private static diff(previous: FileVersion, current: FileVersion): string {
    const before: string = previous.getLines().join('\n');
    const after: string = current.getLines().join('\n');

    return Diff.formatPatch(Diff.structuredPatch('', '', before, after, '', '', { context: 0 }));
  }
}
