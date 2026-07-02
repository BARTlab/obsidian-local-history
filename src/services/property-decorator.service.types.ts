/** Decoration status a property row resolves to from the frontmatter diff. */
export type RowStatus = 'added' | 'modified' | 'clean';

/** Class and title plan applied to a property row for a given RowStatus. */
export type RowDecoration = {
  classToAdd: string | null;
  classToRemove: string[];
  title: string | null;
};
