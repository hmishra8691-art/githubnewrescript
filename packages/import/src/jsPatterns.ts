/**
 * QUALTRICS QUESTION JAVASCRIPT, RECOGNISED BY SHAPE (2026-11-11).
 *
 * Nothing here runs the code. A script is compared, whole, with the handful of things survey programmers write
 * again and again; when ALL of it is one of them, the importer rebuilds the behaviour with native features
 * (jsMigrate.ts says what each other call would become; this file is for the scripts that need no person at all).
 *
 * "Whole" is the rule that keeps this honest: after the recognised statements are taken out, nothing may be left
 * but the hook wrappers. A script that selects the displayed choices AND does one other thing is not recognised.
 *
 *   select_displayed   tick every choice the question shows, hide the question, press Next
 *                      → a hidden question whose answers are coded by auto-punch rules
 *   recode_union       for each listed question, tick here the choice whose recode is a function of each of its
 *                      selected recodes (the same value, value + N, or value followed by a suffix), hide, press Next
 *                      → a hidden question with one auto-punch rule per source answer
 *   only_shown         when exactly one choice is shown: choose it (or rank it first), hide, press Next
 *   css_only           adds a <style> to the page and nothing else
 *   input_prefix       writes a fixed text before the text inputs ("$")
 *   video_gate         hides Next until the question's video has played to the end, and stops seeking ahead
 */
export type RecodeTransform = { type: "same" } | { type: "add"; n: number } | { type: "suffix"; s: string };

export type JsPattern =
  | { kind: "select_displayed" }
  | { kind: "recode_union"; sources: { qid: string; transform: RecodeTransform }[] }
  | { kind: "only_shown"; rank: boolean }
  | { kind: "css_only"; css: string }
  | { kind: "input_prefix"; text: string }
  | { kind: "video_gate" };

/** comments out, strings kept; then every space out — the shapes below are written without any */
function flatten(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 1; continue; }
    if (ch === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); i = e < 0 ? code.length : e - 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      for (; j < code.length && code[j] !== ch; j++) if (code[j] === "\\") j++;
      out += code.slice(i, j + 1); i = j; continue;
    }
    if (/\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

/** the bodies of the hooks that are not empty (Qualtrics' own template comment lines, even mistyped as /…/, are empty) */
function hookBodies(flat: string): string[] | null {
  const out: string[] = [];
  let rest = flat;
  const head = /^Qualtrics\.SurveyEngine\.addOn(?:load|Ready|Unload|PageSubmit)\(function\(\)\{/;
  while (rest) {
    const m = head.exec(rest);
    if (!m) return null;
    let depth = 1, i = m[0].length;
    for (; i < rest.length && depth; i++) {
      const ch = rest[i];
      if (ch === "{") depth++; else if (ch === "}") depth--;
      else if (ch === '"' || ch === "'" || ch === "`") { for (i++; i < rest.length && rest[i] !== ch; i++) if (rest[i] === "\\") i++; }
    }
    if (depth) return null;
    const body = rest.slice(m[0].length, i - 1).replace(/^\/Placeyour[^/]*\//, "");
    if (body) out.push(body);
    const tail = /^\);?/.exec(rest.slice(i));
    if (!tail) return null;
    rest = rest.slice(i + tail[0].length);
  }
  return out;
}

const HIDE = String.raw`jQuery\("#"\+(?:this|\w+)\.questionId\)\.hide\(\);?`;

export function recogniseQualtricsJs(code: string): JsPattern | null {
  const bodies = hookBodies(flatten(code));
  if (!bodies || bodies.length !== 1) return null;
  let b = bodies[0];

  /* tick every displayed choice, hide, Next */
  if (new RegExp(String.raw`^var(\w+)=this;var(\w+)=\[\];jQuery\.each\(\1\.getChoices\(\),function\(\w+,(\w+)\)\{if\(\1\.getChoiceDisplayed\(\3\)\)\{?\2\.push\(\3\);\}?\}\);for\(var(\w+)=0;\4<\2\.length;\4\+\+\)\{\1\.setChoiceValue\(\2\[\4\],true\);\}${HIDE}\1\.clickNextButton\(\);$`).test(b)) return { kind: "select_displayed" };

  /* exactly one displayed choice: rank it first, hide, Next */
  if (new RegExp(String.raw`^var(\w+)=this;var(\w+)=\[\];jQuery\.each\(\1\.getChoices\(\),function\(\w+,(\w+)\)\{if\(\1\.getChoiceDisplayed\(\3\)\)\{\2\.push\(\3\);\}\}\);if\(\2\.length===1\)\{var(\w+)=\2\[0\];\1\.setChoiceValue\(\4,"1"\);jQuery\("#"\+\1\.questionId\+" select"\)\.prop\("disabled",true\);jQuery\("#"\+\1\.questionId\)\.hide\(\);\1\.clickNextButton\(\);\}$`).test(b)) return { kind: "only_shown", rank: true };

  /* exactly one displayed radio: click it, hide, Next */
  if (/^var(\w+)=this;var(\w+)=\1\.getQuestionContainer\(\);if\(!\2\)\{return;\}var(\w+)=\2\.querySelectorAll\('input\[type="radio"\]'\);var(\w+)=\[\];for\(var(\w+)=0;\5<\3\.length;\5\+\+\)\{if\(\3\[\5\]\.offsetParent!==null\)\{\4\.push\(\3\[\5\]\);\}\}if\(\4\.length!==1\)\{return;\}var(\w+)=\4\[0\];try\{\6\.click\(\);\}catch\(\w+\)\{return;\}if\(!\6\.checked\)\{return;\}\2\.style\.display='none';setTimeout\(function\(\)\{try\{\1\.clickNextButton\(\);\}catch\(\w+\)\{\}\},0\);$/.test(b)) return { kind: "only_shown", rank: false };

  /* a stylesheet and nothing else */
  const css = /^varcss=`([^`]*)`;var(\w+)=document\.createElement\('style'\);\2\.type='text\/css';\2\.innerHTML=css;document\.head\.appendChild\(\2\);$/.exec(b);
  if (css) return { kind: "css_only", css: css[1] };

  /* a fixed text before the text inputs */
  const prefix = /^jQuery\("<span>([^<"]{1,12})<\/span>"\)\.insertBefore\("input\[type='text'\][.\w ]*"\);?$/.exec(b);
  if (prefix) return { kind: "input_prefix", text: prefix[1] };

  /* Next only when the video has ended; no seeking ahead; no video → Next at once */
  if (/^var(\w+)=this;\1\.hideNextButton\(\);var(\w+)=\1\.getQuestionContainer\(\)\.querySelector\("video"\);/.test(b) && /\w+\.addEventListener\("ended",function\(\)\{\w+\.showNextButton\(\);\}\);/.test(b) && /addEventListener\("seeking"/.test(b) && !/fetch|XMLHttpRequest|location|setEmbeddedData|setChoiceValue/.test(b)) return { kind: "video_gate" };

  /* tick here what was selected there, by recode */
  b = b.replace(/^var\w+=this;/, "").replace(new RegExp(`^${HIDE}`), "");
  const sources: { qid: string; transform: RecodeTransform }[] = [];
  const block = /^(\w+)="\$\{q:\/\/(QID\d+)\/SelectedChoicesRecode\}";var(\w+)=\1\.split\(","\)\.map\(item=>item\.trim\(\)\);var(\w+)=\3\.map\(item=>item\.replace\("x",""\)\);for\(var(\w+)=0;\5<\4\.length;\5\+\+\)\{(?:var(\w+)=parseInt\(\4\[\5\],10\)\+(\d+);|var(\w+)="";\8=\4\[\5\](?:\+0\+(\d+))?;)(?:this|\w+)\.setChoiceValueByRecodeValue\((\w+),true\);\}/;
  for (let m = block.exec(b); m; m = block.exec(b)) {
    if (m[10] !== (m[6] ?? m[8])) return null;
    sources.push({ qid: m[2], transform: m[7] !== undefined ? { type: "add", n: Number(m[7]) } : m[9] !== undefined ? { type: "suffix", s: `0${m[9]}` } : { type: "same" } });
    b = b.slice(m[0].length);
  }
  if (sources.length && /^(?:var(\w+)=this;\1|\w+)\.clickNextButton\(\);$/.test(b)) return { kind: "recode_union", sources };
  return null;
}

/** the recode a source answer becomes in the target, as the script computes it (JavaScript's `"3" + 0 + 1` is "301") */
export function applyRecode(code: string | number, t: RecodeTransform): string {
  if (t.type === "same") return String(code);
  if (t.type === "suffix") return `${code}${t.s}`;
  const n = parseInt(String(code), 10);
  return Number.isFinite(n) ? String(n + t.n) : "";
}
