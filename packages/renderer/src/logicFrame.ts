import { LOGIC_SHIM, type LogicScriptOutcome, type LogicSnapshot, type LogicStatics, type PreparedLogicScript } from "@rescript/engine";

/**
 * S1b — THE LOGIC FRAME: where a survey's Scripts-panel scripts run.
 *
 * One hidden iframe per page, created by the host (the Runner) only when the page has logic scripts to run, with
 * the same isolation as the UX frames: `sandbox="allow-scripts"` (an opaque origin — no cookies, storage, page or
 * session) and a CSP of `default-src 'none'` (no request of any kind). It holds no DOM mirror: a logic script reads
 * the response through `ctx`, built in the frame by `LOGIC_SHIM` over the snapshot the host sends with each run,
 * and its writes come back as a list the host applies through the engine (`applyScriptWrite`).
 *
 * The host bounds every run: a frame that does not answer within the run's time is disposed (and the next run
 * gets a fresh frame) and the run is reported as timed out. A script never holds the respondent.
 */

const FRAME_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"></head><body><script>
(function () {
  var host = window.parent;
__SHIM__
  var compile = function (params, body) { return Function.apply(null, params.concat([body])); };
  window.addEventListener("message", function (e) {
    if (e.source !== host) return;
    var m = e.data; if (!m || m.__rslogic !== 1) return;
    if (m.type === "statics") { __rsLogic.statics(m.statics); return; }
    if (m.type === "run") {
      var results;
      try { results = __rsLogic.run(m, compile); }
      catch (err) { results = (m.scripts || []).map(function (s) { return { name: s.name, writes: [], logs: [], errors: [], failed: String(err && err.message || err) }; }); }
      try { host.postMessage({ __rslogic: 1, type: "done", id: m.id, results: results }, "*"); }
      catch (err) { host.postMessage({ __rslogic: 1, type: "done", id: m.id, results: (m.scripts || []).map(function (s) { return { name: s.name, writes: [], logs: [], errors: [], failed: "the script's result could not be sent back" }; }) }, "*"); }
    }
  });
  host.postMessage({ __rslogic: 1, type: "ready" }, "*");
})();
</script></body></html>`;

export function logicFrameDoc(): string {
  return FRAME_HTML.replace("__SHIM__", () => LOGIC_SHIM);
}

export interface LogicRunRequest { scripts: PreparedLogicScript[]; snap: LogicSnapshot }
/**
 * `null`: the frame did not answer in time (it was then removed) or could not be created. `"closed"`: the frame was
 * disposed while the run waited — the page was left, or React mounted the Runner twice (StrictMode, dev) — which is
 * not a timeout and is logged as such.
 */
export type LogicRunAnswer = LogicScriptOutcome[] | null | "closed";

let doc: string | null = null;
let runN = 0;

/**
 * The host side of one logic frame. `run` queues behind the previous run (one at a time, in order), so the
 * writes of an on_change are applied before the next event's snapshot is taken.
 */
export class LogicFrameHost {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<boolean> | null = null;
  private waiting = new Map<number, (r: LogicRunAnswer) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private onMessage = (ev: MessageEvent) => {
    if (!this.frame || ev.source !== this.frame.contentWindow) return;
    const m = ev.data as { __rslogic?: number; type?: string; id?: number; results?: unknown };
    if (!m || m.__rslogic !== 1) return;
    if (m.type === "done" && typeof m.id === "number") {
      const f = this.waiting.get(m.id);
      if (f) { this.waiting.delete(m.id); f(Array.isArray(m.results) ? (m.results as LogicScriptOutcome[]) : null); }
    }
  };

  constructor(private container: HTMLElement, private statics: LogicStatics) {}

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    if (typeof document === "undefined" || this.disposed) return Promise.resolve(false);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("data-rs-logic-sandbox", "");
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = doc ??= logicFrameDoc();
    this.frame = frame;
    window.addEventListener("message", this.onMessage);
    this.ready = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => { window.removeEventListener("message", onReady); clearTimeout(t); resolve(ok); };
      const onReady = (ev: MessageEvent) => {
        if (ev.source !== frame.contentWindow) return;
        const m = ev.data as { __rslogic?: number; type?: string };
        if (m?.__rslogic === 1 && m.type === "ready") { frame.contentWindow?.postMessage({ __rslogic: 1, type: "statics", statics: this.statics }, "*"); done(true); }
      };
      const t = setTimeout(() => done(false), 5000);
      window.addEventListener("message", onReady);
    });
    this.container.appendChild(frame);
    return this.ready;
  }

  /** run a batch of scripts; resolves with one outcome per script, or null when the frame did not answer within `timeoutMs` */
  run(req: LogicRunRequest, timeoutMs: number): Promise<LogicRunAnswer> {
    const next = this.queue.then(() => this.runNow(req, timeoutMs));
    this.queue = next.catch(() => null);
    return next;
  }

  private async runNow(req: LogicRunRequest, timeoutMs: number): Promise<LogicRunAnswer> {
    if (!req.scripts.length) return [];
    if (this.disposed) return "closed";
    const began = Date.now();
    const ok = await this.start();
    if (this.disposed) return "closed";
    if (!ok || !this.frame?.contentWindow) { this.reset(); return null; }
    const id = ++runN;
    return new Promise<LogicRunAnswer>((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(id); this.reset(); resolve(null); }, Math.max(50, timeoutMs - (Date.now() - began)));
      this.waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
      let payload: unknown;
      try { payload = JSON.parse(JSON.stringify({ __rslogic: 1, type: "run", id, scripts: req.scripts, snap: req.snap })); }
      catch { clearTimeout(t); this.waiting.delete(id); resolve(null); return; }
      this.frame!.contentWindow!.postMessage(payload, "*");
    });
  }

  /** a frame that did not answer is removed; the next run starts a fresh one */
  private reset(answer: null | "closed" = null) {
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
    for (const f of this.waiting.values()) f(answer);
    this.waiting.clear();
  }

  /** the page was left: runs already asked for still finish (an on_complete, a Next's on_submit), then the frame goes */
  retire() {
    const q = this.queue;
    void q.then(() => this.dispose(), () => this.dispose());
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.reset("closed");
  }
}
