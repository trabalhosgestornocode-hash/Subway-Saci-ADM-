// Consumo do Agente Crescer, visto pelo Painel SuperAdmin.
//
// Camada fina sobre agente.uso.service.js (que fica no módulo do agente,
// tenant-agnóstico e reutilizável) — aqui só entra o que é específico do
// painel: nome de empresa, paginação, agrupamento por modelo.
import { supabase } from "../../config/supabase.js";
import { buscarUsoNoPeriodo, agregarResumo, agregarPorOrganizacao, agregarPorModelo } from "../agente/agente.uso.service.js";

/** @param {{periodo?: string, desde?: string, ate?: string}} filtro */
export async function resumoConsumoAgente(filtro) {
  const { linhas, intervalo } = await buscarUsoNoPeriodo(filtro);
  return { ...agregarResumo(linhas), periodo: intervalo };
}

/** @param {{periodo?: string, desde?: string, ate?: string, pagina?: number, porPagina?: number}} filtro */
export async function consumoAgentePorOrganizacao({ pagina = 1, porPagina = 20, ...filtro }) {
  const { linhas, intervalo } = await buscarUsoNoPeriodo(filtro);
  const agregado = agregarPorOrganizacao(linhas);

  const nomes = await nomesDasOrganizacoes(agregado.map((a) => a.organizacaoId));
  const comNome = agregado.map((a) => ({ ...a, organizacaoNome: nomes.get(a.organizacaoId) ?? "—" }));

  const p = Math.max(1, Number(pagina) || 1);
  const porPag = Math.min(100, Math.max(1, Number(porPagina) || 20));
  const inicio = (p - 1) * porPag;

  return {
    itens: comNome.slice(inicio, inicio + porPag),
    total: comNome.length,
    pagina: p,
    porPagina: porPag,
    periodo: intervalo,
  };
}

/** @param {{periodo?: string, desde?: string, ate?: string}} filtro */
export async function consumoAgentePorModelo(filtro) {
  const { linhas, intervalo } = await buscarUsoNoPeriodo(filtro);
  return { itens: agregarPorModelo(linhas), periodo: intervalo };
}

/** @param {string[]} ids */
async function nomesDasOrganizacoes(ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  if (!unicos.length) return new Map();
  const { data, error } = await supabase.from("organizacoes").select("id, nome").in("id", unicos);
  if (error) return new Map();
  return new Map((data ?? []).map((o) => [o.id, o.nome]));
}
