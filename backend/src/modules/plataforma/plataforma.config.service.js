// Configurações globais do SaaS.
//
// SEGREDOS NUNCA SAEM DAQUI. Chaves marcadas com `secreto` (senha de SMTP,
// chaves de OpenAI/Claude/Cloudflare) são devolvidas apenas como
// `{ preenchido: true|false }`. Nem para o SuperAdmin o valor volta: uma tela
// que exibe a chave a expõe a qualquer captura, extensão de navegador ou
// screenshot de suporte — e quem pode gravar uma chave nova não precisa ler a
// antiga.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as v from "../../shared/validar.js";

/** Agrupamento das chaves nas abas do painel. */
const GRUPOS = [
  { chave: "saas", titulo: "Identidade da plataforma", prefixo: "saas." },
  { chave: "smtp", titulo: "E-mail (SMTP)", prefixo: "smtp." },
  { chave: "api", titulo: "APIs e integrações", prefixo: "api." },
  { chave: "backup", titulo: "Backups", prefixo: "backup." },
];

/** Chaves internas que não devem aparecer no painel de configuração. */
const OCULTAS = new Set(["migracao_020_reset_acessos"]);

/**
 * @typedef {object} ItemConfig
 * @property {string} chave
 * @property {unknown} valor          ausente quando secreto
 * @property {boolean} secreto
 * @property {boolean} [preenchido]   presente quando secreto
 * @property {string|null} descricao
 * @property {string|null} atualizadoEm
 */

export async function listarConfiguracoes() {
  const { data, error } = await supabase.from("plataforma_config")
    .select("chave, valor, secreto, descricao, updated_at").order("chave");
  if (error) throw ApiError.internal(error.message);

  /** @type {ItemConfig[]} */
  const itens = (data ?? [])
    .filter((c) => !OCULTAS.has(c.chave))
    .map((c) => c.secreto
      // O valor não vai; só se existe algo gravado.
      ? { chave: c.chave, secreto: true, preenchido: c.valor !== null && c.valor !== "", descricao: c.descricao, atualizadoEm: c.updated_at }
      : { chave: c.chave, secreto: false, valor: c.valor, descricao: c.descricao, atualizadoEm: c.updated_at });

  return {
    grupos: GRUPOS.map((g) => ({
      ...g,
      itens: itens.filter((i) => i.chave.startsWith(g.prefixo)),
    })),
    // Chaves fora dos grupos conhecidos ainda aparecem — uma config nova não
    // deve ficar invisível só porque o agrupamento não foi atualizado.
    outros: itens.filter((i) => !GRUPOS.some((g) => i.chave.startsWith(g.prefixo))),
  };
}

/**
 * Grava configurações. Aceita um lote: `{ "saas.nome": "X", "smtp.porta": 465 }`.
 * Só chaves JÁ EXISTENTES são aceitas — o painel configura o que o sistema
 * conhece, e permitir chaves arbitrárias transformaria a tabela num depósito
 * sem contrato.
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} body
 */
export async function salvarConfiguracoes(req, body) {
  const entradas = Object.entries(v.corpo(body));
  if (!entradas.length) throw ApiError.badRequest("Nada para salvar.");
  if (entradas.length > 50) throw ApiError.badRequest("Máximo de 50 chaves por requisição.");

  const chaves = entradas.map(([k]) => k);
  const { data: existentes, error } = await supabase.from("plataforma_config")
    .select("chave, secreto").in("chave", chaves);
  if (error) throw ApiError.internal(error.message);

  const conhecidas = new Map((existentes ?? []).map((c) => [c.chave, c]));
  const desconhecidas = chaves.filter((k) => !conhecidas.has(k) || OCULTAS.has(k));
  if (desconhecidas.length) {
    throw ApiError.badRequest(`Chave de configuração desconhecida: ${desconhecidas.join(", ")}.`);
  }

  const alteradas = [];
  for (const [chave, valorBruto] of entradas) {
    const meta = conhecidas.get(chave);
    const valor = normalizarValor(chave, valorBruto, meta.secreto);
    // Segredo com string vazia = "não mexer". Sem isso, salvar o formulário com
    // o campo de senha em branco (o normal, já que ele nunca é preenchido de
    // volta) apagaria a chave gravada.
    if (valor === SEM_ALTERACAO) continue;

    const { error: e } = await supabase.from("plataforma_config")
      .update({ valor, updated_by: req.user.id }).eq("chave", chave);
    if (e) throw ApiError.internal(`Falha ao salvar ${chave}: ${e.message}`);
    alteradas.push(chave);
  }

  if (alteradas.length) {
    await auditar({
      atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
      acao: ACOES.CONFIG_ALTERADA, entidade: "plataforma_config",
      // Somente os NOMES das chaves. Gravar os valores colocaria segredos na
      // auditoria — que é imutável, ou seja, sem como remover depois.
      detalhes: { chaves: alteradas },
      ...origemDe(req),
    });
  }

  return { alteradas };
}

/** Sentinela para "campo de segredo veio vazio, preserve o que está gravado". */
const SEM_ALTERACAO = Symbol("sem-alteracao");

/**
 * Valida/normaliza o valor conforme a chave. Cada regra existe porque o valor
 * errado ali causa um problema silencioso (URL de logo com `javascript:`,
 * porta de SMTP como texto, retenção de backup negativa).
 */
function normalizarValor(chave, valor, secreto) {
  if (secreto) {
    if (valor === "" || valor === null || valor === undefined) return SEM_ALTERACAO;
    return v.texto(valor, chave, { max: 500 });
  }

  switch (chave) {
    case "saas.nome":
      return v.texto(valor, "Nome da plataforma", { max: 80 });
    case "saas.logo_url":
      return v.urlOpcional(valor, "Logo");
    case "saas.politica_url":
      return v.urlOpcional(valor, "URL da política");
    case "saas.versao":
      return v.texto(valor, "Versão", { max: 20 });
    case "saas.modo_manutencao":
      return v.booleano(valor, false);
    case "smtp.porta":
      return v.numero(valor, "Porta SMTP", { min: 1, max: 65535 });
    case "smtp.host":
    case "smtp.usuario":
      return v.textoOpcional(valor, chave, { max: 200 });
    case "backup.frequencia":
      return v.umDe(valor, "Frequência do backup", ["horario", "diario", "semanal", "mensal"]);
    case "backup.retencao_dias":
      return v.numero(valor, "Retenção", { min: 1, max: 3650 });
    default:
      // Chave conhecida sem regra específica: aceita escalar simples.
      if (valor === null || typeof valor === "boolean" || typeof valor === "number") return valor;
      return v.textoOpcional(valor, chave, { max: 2000 });
  }
}

/**
 * Modo manutenção — leitura barata para o middleware consultar no futuro.
 * Ainda NÃO está ligado ao bloqueio de requisições: ligar isso muda o
 * comportamento de todo o sistema e merece ser uma mudança própria, com aviso
 * ao usuário logado e liberação explícita do superadmin.
 */
export async function emManutencao() {
  const { data } = await supabase.from("plataforma_config")
    .select("valor").eq("chave", "saas.modo_manutencao").maybeSingle();
  return data?.valor === true;
}

/** Identidade pública da plataforma (nome, logo, versão) — sem segredo algum. */
export async function identidadePublica() {
  const { data } = await supabase.from("plataforma_config")
    .select("chave, valor").in("chave", ["saas.nome", "saas.logo_url", "saas.versao", "saas.politica_url"]);
  const mapa = new Map((data ?? []).map((c) => [c.chave, c.valor]));
  return {
    nome: mapa.get("saas.nome") ?? "Crescer com Delivery",
    logoUrl: mapa.get("saas.logo_url") ?? null,
    versao: mapa.get("saas.versao") ?? null,
    politicaUrl: mapa.get("saas.politica_url") ?? null,
  };
}

/** @param {import('express').Request} req */
function origemDe(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}
