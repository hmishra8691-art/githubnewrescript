"use client";
import React from "react";
import { designRowsFor } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * MENU-BASED CONJOINT — the renderer for `conjoint_task` questions whose
 * design is a MENU (`packages/designs/menu.ts`).
 *
 * Every task shows the whole menu at that task's prices; the respondent
 * ticks what they would buy. Required items (the configurator's base) are
 * pre-selected and locked; a running total updates as items are ticked;
 * "I would buy nothing from this menu" is an exclusive choice when the design
 * offers it. The answer per task is the array of chosen item indices — or
 * `["none"]` — stored under the task number like every other design task,
 * so the same `{task: answer}` object the CBC renderer writes is what the
 * exporter expands (VAR_T<n>_<item>, VAR_T<n>_NONE, VAR_T<n>_TOTAL).
 *
 * Prices are read from the design rows of the version this respondent was
 * assigned (designRowsFor), never recomputed here: what they saw is what the
 * analysis sees.
 */

interface MenuRow { item: string; label: string; price: string; priceValue: number; required: boolean }

function menuOf(rows: Record<string, unknown>[], task: string): MenuRow[] {
  return rows
    .filter((r) => String(r.task) === task)
    .sort((a, b) => Number(a.item) - Number(b.item))
    .map((r) => ({
      item: String(r.item), label: String(r.item_label ?? r.item), price: String(r.price ?? ""),
      priceValue: Number(r.price_value), required: Number(r.required) === 1,
    }));
}

function fmtTotal(n: number, currency: string, sample: string): string {
  const decimals = /\.\d/.test(sample) ? 2 : 0;
  const s = n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: 2 });
  return currency ? `${currency}${s}` : s;
}

export function MenuTasks(p: QRProps) {
  const design = p.def.designs.find((d) => d.id === p.q.settings.designRef);
  if (!design?.file?.rows?.length) {
    return <div className="rs-error-msg">Design file “{p.q.settings.designRef ?? "(none)"}” not generated yet — create a Menu design in Design Generators and pick it here.</div>;
  }
  if (design.kind !== "menu") {
    return <div className="rs-error-msg">This question needs a Menu design; “{design.name}” is a {design.kind} design.</div>;
  }
  const rows = designRowsFor(p.q, design.file.rows as Record<string, unknown>[], p.state.seed);
  const tasks = [...new Set(rows.map((r) => String(r.task)))];
  const cfg = (design.config ?? {}) as { noneOption?: boolean; minSelections?: number; maxSelections?: number; currency?: string };
  const summary = (design.file as { summary?: { currency?: string } }).summary;
  const currency = cfg.currency ?? summary?.currency ?? "";
  const noneOption = cfg.noneOption !== false;
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const readOnly = !!p.q.settings.readOnly;

  const chosenOf = (t: string): string[] => (Array.isArray(vals[t]) ? (vals[t] as unknown[]).map(String) : []);
  const setTask = (t: string, chosen: string[]) => p.onChange({ ...vals, [t]: chosen });

  return (
    <div className="rs-menu-tasks" data-testid="rs-menu-tasks" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {tasks.map((t) => {
        const menu = menuOf(rows, t);
        const chosen = chosenOf(t);
        const none = chosen.includes("none");
        const picked = new Set(chosen.filter((c) => c !== "none"));
        const total = none ? 0 : menu.reduce((sum, it) => (it.required || picked.has(it.item)) && Number.isFinite(it.priceValue) ? sum + it.priceValue : sum, 0);
        const optionalPicked = menu.filter((it) => !it.required && picked.has(it.item)).length;
        const atMax = !!cfg.maxSelections && menu.filter((it) => it.required || picked.has(it.item)).length >= cfg.maxSelections;
        const toggle = (it: MenuRow) => {
          if (readOnly || it.required) return;
          const next = new Set(picked);
          if (next.has(it.item)) next.delete(it.item);
          else { if (atMax) return; next.add(it.item); }
          setTask(t, [...next].sort((a, b) => Number(a) - Number(b)));
        };
        return (
          <div key={t} className="rs-card rs-menu-task" style={{ margin: 0 }} data-testid="rs-menu-task" data-task={t}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>Menu {t} of {tasks.length}</div>
            <div className="rs-menu-items" role="group" aria-label={`Menu ${t}`}>
              {menu.map((it) => {
                const on = !none && (it.required || picked.has(it.item));
                return (
                  <label key={it.item} className={`rs-menu-item${on ? " on" : ""}${it.required ? " required" : ""}${none ? " muted" : ""}`} data-testid="rs-menu-item" data-item={it.item}>
                    <input type="checkbox" checked={on} disabled={readOnly || it.required || none}
                      onChange={() => toggle(it)} aria-label={`${it.label}, ${it.price}`} />
                    <span className="rs-menu-label">{it.label}{it.required && <span className="rs-menu-req"> · included</span>}</span>
                    <span className="rs-menu-price" data-testid="rs-menu-price">{it.price}</span>
                  </label>
                );
              })}
              {noneOption && (
                <label className={`rs-menu-item rs-menu-none${none ? " on" : ""}`} data-testid="rs-menu-none">
                  <input type="checkbox" checked={none} disabled={readOnly}
                    onChange={() => setTask(t, none ? [] : ["none"])} />
                  <span className="rs-menu-label">I would buy nothing from this menu</span>
                  <span className="rs-menu-price" />
                </label>
              )}
            </div>
            <div className="rs-menu-total" data-testid="rs-menu-total" aria-live="polite">
              {none ? "Nothing selected" : (
                <>
                  <span>{optionalPicked} add-on{optionalPicked === 1 ? "" : "s"}{menu.some((i) => i.required) ? " + base" : ""}</span>
                  <strong>Total: {fmtTotal(total, currency, menu[0]?.price ?? "")}</strong>
                </>
              )}
              {cfg.minSelections ? <span className="rs-menu-hint">pick at least {cfg.minSelections}</span> : null}
              {cfg.maxSelections ? <span className="rs-menu-hint">at most {cfg.maxSelections}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

registerVariantRenderer("menutasks", MenuTasks);
