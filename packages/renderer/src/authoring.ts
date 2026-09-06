/**
 * AUTHORING ANCHORS — how a rendered element is traced back to the schema.
 *
 * The Studio's Live Question Canvas renders questions with the *respondent*
 * renderer, then lets the programmer click any part of the result and program
 * exactly that part. To do that it has to answer one question about any node
 * under the cursor: which piece of the question definition drew this?
 *
 * The answer is a pair of data attributes stamped by the renderers themselves:
 *
 *     data-rs-el="option" data-rs-id="3"
 *     data-rs-el="row"    data-rs-id="prod_a"
 *     data-rs-el="column" data-rs-id="col_2"
 *     data-rs-el="cell"   data-rs-id="prod_a::col_2"
 *
 * They are inert markup: no behaviour, no styling, no bearing on the response
 * model, and the respondent runtime carries them too — which is the point.
 * Both surfaces run the same renderer, so the canvas cannot drift away from
 * what a respondent sees, and the anchors are exercised by every runtime test
 * rather than only by the editor.
 *
 * Renderers that predate this convention already spoke local dialects
 * (`data-code`, `data-row`, `data-col`, `data-rowfor`…). Those are left alone —
 * tests and drag handlers read them — and the anchors are added alongside.
 */

export type AuthoringElementKind =
  | "question"
  | "text"
  | "instruction"
  | "media"
  | "option"
  | "row"
  | "column"
  | "cell"
  | "input"
  | "scalepoint";

/** Attribute bag for one addressable element. Spread onto the JSX node. */
export interface AuthoringAnchor {
  "data-rs-el": AuthoringElementKind;
  "data-rs-id"?: string;
}

/** `data-rs-el="option" data-rs-id="3"` — spread onto the element that draws it. */
export function anchor(kind: AuthoringElementKind, id?: string | number | null): AuthoringAnchor {
  return id == null || id === ""
    ? { "data-rs-el": kind }
    : { "data-rs-el": kind, "data-rs-id": String(id) };
}

/** A matrix cell is addressed by both of its coordinates. */
export const CELL_SEP = "::";
export function cellAnchor(rowCode: string | number, columnId: string | number): AuthoringAnchor {
  return { "data-rs-el": "cell", "data-rs-id": `${rowCode}${CELL_SEP}${columnId}` };
}

/** Split a cell id back into its coordinates; null when it is not one. */
export function parseCellId(id: string): { rowCode: string; columnId: string } | null {
  const i = id.indexOf(CELL_SEP);
  if (i < 0) return null;
  return { rowCode: id.slice(0, i), columnId: id.slice(i + CELL_SEP.length) };
}
