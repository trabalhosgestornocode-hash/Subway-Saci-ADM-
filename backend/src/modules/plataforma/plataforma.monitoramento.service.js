// Monitoramento dos subsistemas da plataforma.
//
// PRINCÍPIO: cada item declara o que ele É — um teste real, uma leitura de
// estado, ou um espaço reservado ainda sem sonda. O campo `verificacao` diz
// qual dos três, e `disponivel` nunca é "ok" por otimismo. Um painel de
// monitoramento que mostra verde sem ter medido nada é pior que não ter painel:
// ele cria confiança onde não há informação.
//
// Estados possíveis em `situacao`:
//   'operacional' | 'degradado' | 'falha' | 'desligado' | 'sem_sonda'

import { supabase } from "../../config/supabase.js";
import { config } from "../../config/env.js";
import { contar } from "./plataforma.repo.js";
import { PORTAL_MARTIN_BROWER } from "../../config/seguranca.js";

/**
 * @typedef {object} ItemMonitorado
 * @property {string} chave
 * @property {string} nome
 * @property {'operacional'|'degradado'|'falha'|'desligado'|'sem_sonda'} situacao
 * @property {'sonda'|'estado'|'reservado'} verificacao  como o dado foi obtido
 * @property {string} detalhe
 * @property {number|null} [latenciaMs]
 */

export async function obterMonitoramento() {
  const [banco, mb, sw] = await Promise.all([
    sondarBanco(),
    estadoMartinBrower(),
    estadoVendasSw(),
  ]);

  /** @type {ItemMonitorado[]} */
  const itens = [
    banco,
    {
      chave: "api",
      nome: "API (backend)",
      // Se este código está executando, a API respondeu. É o único item que
      // pode se declarar operacional sem sondar nada.
      situacao: "operacional",
      verificacao: "estado",
      detalhe: `Node ${process.version} · no ar há ${formatarUptime(process.uptime())} · ${process.env.NODE_ENV ?? "development"}`,
    },
    {
      chave: "hospedagem",
      nome: "Hospedagem (Render)",
      situacao: "sem_sonda",
      verificacao: "reservado",
      detalhe: "CPU, memória e reinícios vêm da API de métricas do Render (exige RENDER_API_KEY).",
    },
    {
      chave: "storage",
      nome: "Storage",
      situacao: "sem_sonda",
      verificacao: "reservado",
      detalhe: "Uso por bucket vem da Storage API do Supabase. Nenhum bucket em uso pelo sistema hoje.",
    },
    mb,
    sw,
    {
      chave: "ifood",
      nome: "iFood",
      situacao: "desligado",
      verificacao: "estado",
      detalhe: "Integração em planejamento — monitoramento de cardápio, sem recebimento de pedidos.",
    },
    {
      chave: "whatsapp",
      nome: "WhatsApp",
      situacao: "desligado",
      verificacao: "estado",
      detalhe: "Notificações via Evolution API — não configurado.",
    },
    {
      chave: "cron",
      nome: "Cron Jobs",
      situacao: "sem_sonda",
      verificacao: "reservado",
      detalhe: "Nenhum agendamento registrado no backend. Sincronizações são disparadas sob demanda.",
    },
    {
      chave: "filas",
      nome: "Filas",
      situacao: "sem_sonda",
      verificacao: "reservado",
      detalhe: "Sem broker de filas. O worker da Martin Brower é chamado de forma síncrona.",
    },
  ];

  return {
    itens,
    resumo: {
      operacional: itens.filter((i) => i.situacao === "operacional").length,
      degradado: itens.filter((i) => i.situacao === "degradado").length,
      falha: itens.filter((i) => i.situacao === "falha").length,
      semSonda: itens.filter((i) => i.situacao === "sem_sonda").length,
      desligado: itens.filter((i) => i.situacao === "desligado").length,
    },
    ambiente: {
      nodeEnv: process.env.NODE_ENV ?? "development",
      versaoNode: process.version,
      uptimeS: Math.floor(process.uptime()),
      memoriaMb: Math.round(process.memoryUsage().rss / 1048576),
      supabaseHost: hostDe(config.supabaseUrl),
      portalMartinBrower: PORTAL_MARTIN_BROWER,
    },
    verificadoEm: new Date().toISOString(),
  };
}

/** Sonda real: mede uma consulta trivial no Postgres. @returns {Promise<ItemMonitorado>} */
async function sondarBanco() {
  const t0 = Date.now();
  const { error } = await supabase.from("organizacoes").select("id", { count: "exact", head: true });
  const latenciaMs = Date.now() - t0;

  if (error) {
    return {
      chave: "banco", nome: "Banco de dados (Supabase)", situacao: "falha",
      verificacao: "sonda", detalhe: `Consulta falhou: ${error.message}`, latenciaMs,
    };
  }
  // 1,5 s é o limite a partir do qual o app fica perceptivelmente lento para o
  // usuário, já que quase toda tela faz mais de uma consulta.
  return {
    chave: "banco", nome: "Banco de dados (Supabase)",
    situacao: latenciaMs > 1500 ? "degradado" : "operacional",
    verificacao: "sonda",
    detalhe: `Consulta respondeu em ${latenciaMs} ms · ${hostDe(config.supabaseUrl)}`,
    latenciaMs,
  };
}

/** @returns {Promise<ItemMonitorado>} */
async function estadoMartinBrower() {
  const habilitado = process.env.MB_PLAYWRIGHT_ENABLED === "true";
  const configuracoes = await contar("mb_configuracoes", (q) => q.eq("ativo", true));

  if (configuracoes === null) {
    return {
      chave: "martinbrower", nome: "Martin Brower", situacao: "sem_sonda", verificacao: "reservado",
      detalhe: "Tabelas da integração não encontradas — a migration 017 provavelmente não foi aplicada.",
    };
  }
  if (!habilitado) {
    return {
      chave: "martinbrower", nome: "Martin Brower", situacao: "desligado", verificacao: "estado",
      detalhe: `Sincronização automatizada desligada (MB_PLAYWRIGHT_ENABLED). ${configuracoes} configuração(ões) ativa(s).`,
    };
  }
  const ultima = await ultimaSincronizacaoMb();
  return {
    chave: "martinbrower", nome: "Martin Brower",
    situacao: ultima?.falhou ? "degradado" : "operacional",
    verificacao: "estado",
    detalhe: ultima
      ? `Worker habilitado · última sincronização ${ultima.status} em ${ultima.em}`
      : `Worker habilitado · ${configuracoes} configuração(ões) ativa(s) · nenhuma sincronização ainda`,
  };
}

async function ultimaSincronizacaoMb() {
  try {
    // Tabela real é martin_brower_sincronizacoes — a antiga referência (mb_
    // seguido de sincronizacoes, junto) nunca existiu; a consulta sempre
    // errava e o monitor nunca via a sincronização de verdade. iniciado_em é
    // a coluna de data — não há created_at nesta tabela (mesma convenção de
    // martinbrower.repository.js).
    const { data, error } = await supabase.from("martin_brower_sincronizacoes")
      .select("status, iniciado_em").order("iniciado_em", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return { status: data.status, em: data.iniciado_em, falhou: String(data.status).includes("erro") };
  } catch {
    return null;
  }
}

/** @returns {Promise<ItemMonitorado>} */
async function estadoVendasSw() {
  const importacoes = await contar("vendas_importacoes");
  if (importacoes === null) {
    return {
      chave: "swfast", nome: "SWFast / PDV", situacao: "sem_sonda", verificacao: "reservado",
      detalhe: "Tabelas de vendas não encontradas — migration 013 provavelmente não aplicada.",
    };
  }
  return {
    chave: "swfast", nome: "SWFast / PDV",
    situacao: importacoes > 0 ? "operacional" : "desligado",
    verificacao: "estado",
    detalhe: importacoes > 0
      ? `${importacoes} importação(ões) de fechamento registradas. Importação é manual (upload do relatório).`
      : "Nenhuma importação registrada. A entrada de dados é o upload manual do relatório.",
  };
}

function formatarUptime(segundos) {
  const s = Math.floor(segundos);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}min`;
  return `${m}min`;
}

function hostDe(url) {
  try { return new URL(url).host; } catch { return "—"; }
}
