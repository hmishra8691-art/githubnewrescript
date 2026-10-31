/** Shared shapes of the Studio code editor (S3a): the completion source and the lint mapping are pure, tested here. */

/** what a field's code is: a behaviour script (rs api), a logic script (ctx helpers), a component (el / api), CSS, HTML */
export type CodeKind = "ux" | "logic" | "component" | "css" | "html";

export interface CodeCompletion {
  label: string;
  type: "function" | "method" | "variable" | "property" | "constant" | "keyword" | "text" | "enum" | "class" | "snippet";
  /** the signature, or the question's code / type */
  detail?: string;
  /** one line: the registry's effect, or the question's text */
  info?: string;
  /** what is inserted when it differs from the label */
  apply?: string;
  boost?: number;
}

export interface CompletionAt {
  /** where the replaced text starts */
  from: number;
  options: CodeCompletion[];
  /** the cursor is inside a string literal (a name, an event, a selector) */
  inString: boolean;
}

/** a gate's verdict: errors refuse the save, warnings are shown */
export interface GateVerdict { errors: string[]; warnings: string[] }

export interface CodeDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
  /** false: the gate gave no position and no token of the message was found — attached to line 1 */
  located: boolean;
}
