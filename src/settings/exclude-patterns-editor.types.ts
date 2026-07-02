/**
 * The three operations the exclude-patterns editor cannot own itself: reading
 * the current pattern list, persisting a replacement list (which also syncs any
 * dependent tab state, such as the purge button), and translation.
 */
export interface ExcludePatternsEditorHost {
  getPatterns(): string[];
  persist(patterns: string[]): void;
  t(key: string): string;
}
