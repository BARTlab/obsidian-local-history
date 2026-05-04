import { StateEffect } from '@codemirror/state';

/**
 * State effect dispatched when the snapshot or settings change while the
 * document itself stays the same. It lets decoration-providing extensions
 * rebuild only when the underlying change data actually changed, instead of
 * on every cursor move or selection update.
 */
export const refreshDecorationsEffect = StateEffect.define();
