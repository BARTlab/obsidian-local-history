/**
 * Minimal typings for hogan's render-only Template runtime. The package ships
 * no types; only the pieces the plugin touches are declared (see
 * hogan.stub.ts and diff2html-templates.gen.ts).
 */
declare module '@profoundlogic/hogan/lib/template.js' {
  /** The compiled payload hogan's compiler produces for a template. */
  export interface HoganCodeObj {
    code: (c: unknown, p: unknown, i?: string) => string;
    partials: Record<string, unknown>;
    subs: Record<string, unknown>;
  }

  /** Hogan's render-only template runtime; carries no compiler. */
  export class Template {
    public constructor(codeObj?: HoganCodeObj, text?: string, compiler?: unknown, options?: unknown);

    public render(context: unknown, partials?: unknown, indent?: string): string;
  }
}
