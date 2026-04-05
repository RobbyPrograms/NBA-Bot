import type { HotPropParlay, RiskyPropParlay, RolibotReport, SafePropParlay } from "./types";

export function parlaySafeList(r: RolibotReport): SafePropParlay[] {
  const p = r.parlays;
  if (p.safe_props && p.safe_props.length > 0) return p.safe_props;
  return p.safe ?? [];
}

export function parlayRiskyList(r: RolibotReport): RiskyPropParlay[] {
  const p = r.parlays;
  if (p.risky_props && p.risky_props.length > 0) return p.risky_props;
  return p.risky ?? [];
}

export function parlaySgpList(r: RolibotReport): SafePropParlay[] {
  return r.parlays.sgp ?? [];
}

export function parlayHotList(r: RolibotReport): HotPropParlay[] {
  return r.parlays.hot ?? [];
}

export function modelEdgePp(r: RolibotReport): number {
  const m = r.model;
  if (typeof m.edge_vs_book_pp === "number") return m.edge_vs_book_pp;
  if (typeof m.edge_pp === "number") return m.edge_pp;
  return 0;
}

export function modelNTrain(r: RolibotReport): number {
  const m = r.model;
  if (typeof m.n_train_games === "number") return m.n_train_games;
  if (typeof m.n_train === "number") return m.n_train;
  return 0;
}

export function propsNSafe(r: RolibotReport): number {
  const s = r.props_summary;
  if (typeof s.n_safe === "number") return s.n_safe;
  if (typeof s.n_strong === "number") return s.n_strong;
  return 0;
}

export function slateDateDisplay(r: RolibotReport): string | undefined {
  if (r.slate_date) return r.slate_date;
  return r.pipeline?.slate_date;
}

export function injurySummary(r: RolibotReport) {
  return r.injury_report ?? r.pipeline?.injury_report;
}

export function firstSafeParlay(r: RolibotReport): SafePropParlay | null {
  const list = parlaySafeList(r);
  return list[0] ?? r.parlays.best_safe_prop ?? null;
}

export function firstRiskyParlay(r: RolibotReport): RiskyPropParlay | null {
  const list = parlayRiskyList(r);
  return list[0] ?? r.parlays.best_risky_prop ?? null;
}
