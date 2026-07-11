/**
 * Bundle-time replacement for the `@profoundlogic/hogan` package, wired in
 * esbuild.config.mjs. diff2html imports hogan for two things: the Template
 * render runtime (its precompiled default templates are Template instances)
 * and the `compile` function (used only when `rawTemplates` are passed). The
 * compiler builds templates through `new Function`, which the Obsidian plugin
 * scan flags as dynamic code execution, so the bundle carries only the
 * runtime and the plugin passes precompiled templates instead (see
 * diff2html-templates.gen.ts).
 */
export { Template } from '@profoundlogic/hogan/lib/template.js';

/**
 * Replaces hogan's runtime compiler. Never reached: nothing in the bundle
 * passes `rawTemplates` to diff2html, so no template is compiled at runtime.
 *
 * @return {never} Always throws
 */
export function compile(): never {
  throw new Error('hogan compile() is excluded from this bundle; pass precompiled templates instead of rawTemplates');
}
