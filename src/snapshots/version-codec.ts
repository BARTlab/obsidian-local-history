import * as Diff from 'diff';

import { VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { FileVersion } from '@/snapshots/file.version';
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
      // VERSION_KEYFRAME_INTERVAL is the accepted blast-radius bound: a corrupt
      // delta only invalidates entries between two keyframes (up to interval - 1
      // versions). Decode skips bad entries and re-anchors on the next keyframe
      // (degrade-never-throw, ADR-08-B). Accepted trade-off: ADR-18-17.
      const isKeyframe: boolean = i % VERSION_KEYFRAME_INTERVAL === 0;

      let entry: SerializedFileVersion;

      if (isKeyframe) {
        entry = { timestamp: version.timestamp, lines: version.getLines() };
      } else {
        const delta: string = VersionCodec.diff(versions[i - 1], version);
        const fullText: string = version.getLines().join('\n');

        entry = delta.length >= fullText.length
          ? { timestamp: version.timestamp, lines: version.getLines() }
          : { timestamp: version.timestamp, delta };
      }

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
   * Decodes a keyframe + delta entry chain (oldest first) back into a fully
   * materialized `FileVersion[]`. Walks the entries holding the previous
   * materialized lines (`prev`): a keyframe entry resets `prev` to its own
   * `lines`, a delta entry applies its patch to `prev.join('\n')` and splits the
   * result back into lines on the same `\n` transport used by encode.
   *
   * Resilient by design (ADR-08-B): a delta with no preceding keyframe (`prev`
   * is still null) or one whose patch fails to apply is skipped (its version is
   * dropped) and decoding continues; the next keyframe resyncs `prev`. A null or
   * non-object entry is skipped likewise. Decode never throws on a malformed
   * chain, it returns whatever decoded cleanly. A version-1 entry
   * (`{ timestamp, lines }` with no `delta`) decodes natively as a keyframe with
   * no special-casing, which is the superset property.
   *
   * @param {SerializedFileVersion[]} entries - The encoded chain, oldest first
   * @param {string} _lineBreak - The file's line break (unused for the patch
   *   transport, which always splits on `\n`; kept for interface symmetry with
   *   encode and the serialization boundary)
   * @return {FileVersion[]} The materialized versions that decoded cleanly
   */
  public static decode(entries: SerializedFileVersion[], _lineBreak: string): FileVersion[] {
    if (!Array.isArray(entries) || entries.length === 0) {
      return [];
    }

    const versions: FileVersion[] = [];
    let prev: string[] | null = null;

    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }

      const lines: string[] | null = VersionCodec.materialize(entry, prev);

      if (lines === null) {
        continue;
      }

      prev = lines;

      versions.push(
        new FileVersion(
          lines,
          entry.timestamp,
          typeof entry.label === 'string' ? entry.label : undefined,
          entry.external === true,
        ),
      );
    }

    return versions;
  }

  /**
   * Materializes one entry into its full lines, or returns null when the entry
   * cannot be reconstructed (an unanchored or unappliable delta) and must be
   * skipped. A keyframe (`lines` present) yields its own lines and re-anchors the
   * chain; a delta (`delta` present) is patched onto `prev` over the `\n`
   * transport, with both a `false` result and a thrown parse error treated as an
   * unappliable delta so a corrupt string never crashes the decode.
   *
   * @param {SerializedFileVersion} entry - The chain entry to materialize
   * @param {string[] | null} prev - The previous materialized lines, or null
   *   when no keyframe has anchored the chain yet
   * @return {string[] | null} The materialized lines, or null to skip the entry
   */
  private static materialize(entry: SerializedFileVersion, prev: string[] | null): string[] | null {
    if (Array.isArray(entry.lines)) {
      return [...entry.lines];
    }

    if (typeof entry.delta !== 'string' || prev === null) {
      return null;
    }

    let patched: string | false;

    try {
      patched = Diff.applyPatch(prev.join('\n'), entry.delta);
    } catch {
      return null;
    }

    return patched === false ? null : patched.split('\n');
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
