import { CMV_LIMITES } from "./config.js";

const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const el = (sel, root = document) => root.querySelector(sel);
export const els = (sel, root = document) => [...root.querySelectorAll(sel)];

export const temValor = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(v);

export const fmtMoeda = (v) => (temValor(v) && !Number.isNaN(Number(v)) ? brlFmt.format(Number(v)) : "—");
export const fmtPct = (v) => (temValor(v) && !Number.isNaN(Number(v)) ? Number(v).toFixed(1) + "%" : "—");
export const fmtTexto = (v) => (temValor(v) ? String(v) : "—");
export const fmtHora = (ts) => (ts ? new Date(ts).toLocaleTimeString("pt-BR") : "—");

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Classifica o status de CMV a partir do percentual
export function statusCmv(pct) {
  if (!temValor(pct)) return { chave: "sem", label: "Sem dados", classe: "muted" };
  const p = Number(pct);
  if (p <= CMV_LIMITES.saudavel) return { chave: "saudavel", label: "Saudável", classe: "ok" };
  if (p <= CMV_LIMITES.atencao) return { chave: "atencao", label: "Atenção", classe: "warn" };
  return { chave: "critico", label: "Crítico", classe: "bad" };
}

// Toast simples reutilizável
let toastTimer;
export function toast(msg) {
  const t = el("#toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => (t.hidden = true), 250);
  }, 2800);
}
