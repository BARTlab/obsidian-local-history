/**
 * Global test setup. Obsidian exposes `activeDocument`/`activeWindow` globals
 * and guarantees a `window`, so for popout-window compatibility the src code
 * calls `window.setTimeout`/`activeDocument` instead of the bare globals.
 * Under jsdom suites these alias the test DOM; node-environment suites get a
 * minimal `window` shim over globalThis so timer calls keep working.
 */
type ObsidianGlobals = {
  activeDocument?: Document;
  activeWindow?: Window;
  window?: typeof globalThis;
};

const g: ObsidianGlobals = globalThis as ObsidianGlobals;

if (typeof document !== 'undefined') {
  g.activeDocument ??= document;
  g.activeWindow ??= window;
} else {
  g.window ??= globalThis;
  g.activeWindow ??= globalThis as unknown as Window;
}
