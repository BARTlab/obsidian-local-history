/**
 * 32-bit FNV-1a offset basis and prime, applied to two interleaved lanes to
 * synthesize a 64-bit digest without relying on BigInt or 53-bit-unsafe integer
 * multiplication. Each lane is a standard 32-bit FNV-1a hash; mixing the byte
 * index into the second lane decorrelates the two halves so the combined 64-bit
 * space is exercised (a naive "same hash twice" would only give 32 bits of
 * entropy).
 */
const FNV_OFFSET_BASIS: number = 0x811c9dc5;
const FNV_PRIME: number = 0x01000193;

/**
 * Multiplies a 32-bit hash accumulator by the FNV prime using 16-bit limbs so
 * the intermediate products stay inside the 53-bit safe-integer range, then
 * folds the result back to an unsigned 32-bit value. Equivalent to
 * `(hash * FNV_PRIME) >>> 0` but without the precision loss that a direct
 * multiply of two 32-bit operands would incur.
 *
 * @param {number} hash - The current 32-bit accumulator (unsigned).
 * @return {number} The accumulator multiplied by the FNV prime, mod 2^32.
 */
function multiplyFnvPrime(hash: number): number {
  const lo: number = (hash & 0xffff) * FNV_PRIME;
  const hi: number = ((hash >>> 16) * FNV_PRIME) & 0xffff;

  return (((hi << 16) >>> 0) + lo) >>> 0;
}

/**
 * Renders an unsigned 32-bit number as exactly 8 lowercase hex characters,
 * left-padded with zeros so every lane contributes a fixed width and the
 * concatenated digest is always 16 chars regardless of the input.
 *
 * @param {number} value - The unsigned 32-bit value to render.
 * @return {string} An 8-character zero-padded lowercase hex string.
 */
function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * Maps a vault-relative note path to its on-disk history shard filename
 *. A path contains `/` and may exceed the 255-byte filename limit, so
 * the file cannot be named by the path directly; instead the name is a
 * deterministic, synchronous 64-bit hash of the path rendered as fixed-width
 * hex plus `.json`. The path itself is stored inside the shard and is the
 * read-time identity, so this hash only needs to be deterministic and collision
 * resistant, not reversible.
 *
 * The hash is intentionally separate from {@link TextHelper.hash}: that 32-bit
 * hash is load-bearing for change detection and is too narrow for filenames
 * (collision-prone across thousands of files), and widening it in place would
 * risk that hot path. A synchronous hash (rather than async WebCrypto) keeps
 * the helper trivially testable and free of any runtime-environment dependency.
 */
export class ShardNameHelper {
  /**
   * Width in hex characters of the digest emitted by {@link forPath} (two
   * 32-bit lanes, 8 chars each). Exposed so callers and tests can assert the
   * fixed length without hardcoding the magic number.
   */
  public static readonly DIGEST_LENGTH: number = 16;

  /**
   * Computes the deterministic shard filename for a vault-relative path.
   *
   * @param {string} path - The vault-relative note path (the snapshot identity).
   * @return {string} A stable `<hex>.json` filename, 16 hex chars + `.json`,
   *   identical across calls for the same input.
   */
  public static forPath(path: string): string {
    return `${this.digest(path)}.json`;
  }

  /**
   * Allocates a collision-free shard filename for a path against an arbitrary set
   * of already-claimed names. The base name is {@link forPath}'s path hash; if it
   * is taken, a numeric suffix is linear-probed before the `.json` extension so
   * two distinct paths never share a filename. Keeps allocation next to the
   * naming it probes: the live save path builds `taken` from its in-memory index,
   * the migration pass builds it from the names claimed so far.
   *
   * @param {string} path - The vault-relative note path to name a shard for.
   * @param {Set<string>} taken - Names already claimed (must not be reused).
   * @return {string} A shard filename not present in `taken`.
   */
  public static allocate(path: string, taken: Set<string>): string {
    const base: string = this.forPath(path);

    if (!taken.has(base)) {
      return base;
    }

    /**
     * Probe `<hash>.json`, `<hash>-1.json`, `<hash>-2.json`, ... by splitting the
     * base into its hash and extension so the suffix lands before `.json` and the
     * file keeps a recognizable shard extension.
     */
    const dot: number = base.lastIndexOf('.');
    const stem: string = dot === -1 ? base : base.slice(0, dot);
    const ext: string = dot === -1 ? '' : base.slice(dot);

    let suffix: number = 1;
    let candidate: string = `${stem}-${suffix}${ext}`;

    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${stem}-${suffix}${ext}`;
    }

    return candidate;
  }

  /**
   * Computes the raw 64-bit hex digest for a path (without the `.json`
   * extension). Two independent 32-bit FNV-1a lanes are run over the UTF-16 code
   * units, the second lane mixing in the byte index so the lanes decorrelate,
   * and the lanes are concatenated into a fixed-width 16-char hex string.
   *
   * @param {string} path - The string to hash.
   * @return {string} A 16-character lowercase hex digest.
   */
  private static digest(path: string): string {
    let lo: number = FNV_OFFSET_BASIS;
    let hi: number = FNV_OFFSET_BASIS ^ 0x9e3779b9;

    for (let i: number = 0; i < path.length; i++) {
      const code: number = path.charCodeAt(i);

      lo = multiplyFnvPrime((lo ^ code) >>> 0);
      hi = multiplyFnvPrime((hi ^ (code + i)) >>> 0);
    }

    return `${toHex32(hi)}${toHex32(lo)}`;
  }
}
