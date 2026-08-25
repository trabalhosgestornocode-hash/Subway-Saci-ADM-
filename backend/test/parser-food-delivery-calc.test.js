import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classificarPedido, resumoConciliacao, agruparPorEntregador, validarCodigo, extrairCodigos, temEntregador, ehCancelado, STATUS_CONCILIACAO,
  resolverStatusConciliacao, somarResumosPeriodo, limitesDoMes, inicioMesSeguinte, resolverCandidatoPedido, explicarCancelamento,
} from "../src/modules/parser-food-delivery/parserFoodDelivery.calc.js";
import { CLASSIFICACAO_CANCELAMENTO } from "../src/modules/parser-food-delivery/parserFoodDelivery.classificacao.js";
import { OPERACAO } from "../src/modules/parser-food-delivery/parserFoodDelivery.operacao.js";

// ---------- a regra de conciliação (item 3 do pedido) ----------
test("classificarPedido: não cancelado é sempre incluído", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "Finalizado" }, new Set()), STATUS_CONCILIACAO.INCLUIDO);
});
test("classificarPedido: cancelado, COM entregador, sem código informado mantém a taxa válida", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "Cancelado", entregador: "Ana" }, new Set(["2"])), STATUS_CONCILIACAO.CANCELADO_COM_TAXA);
});
test("classificarPedido: cancelado, COM entregador, com código informado descarta a taxa", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "Cancelado", entregador: "Ana" }, new Set(["1"])), STATUS_CONCILIACAO.EXCLUIDO);
});
test("classificarPedido: situação é comparada sem acento/caixa", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "CANCELADO", entregador: "Ana" }, new Set(["1"])), STATUS_CONCILIACAO.EXCLUIDO);
});

test("ehCancelado reconhece somente variantes explícitas e normalizadas", () => {
  assert.equal(ehCancelado(" Cancelado pelo restaurante "), true);
  assert.equal(ehCancelado("CANCELADA"), true);
  assert.equal(ehCancelado("cancelamento em análise"), false);
});

// ---------- complemento: pedido sem entregador não entra em NADA da conta ----------
// (o filtro em si mora no service.js, ANTES de classificarPedido — aqui só
// testamos o critério puro que o service usa pra decidir isso).
test("temEntregador: null/vazio/só espaço/campo ausente contam como SEM entregador", () => {
  assert.equal(temEntregador(null), false);
  assert.equal(temEntregador(undefined), false);
  assert.equal(temEntregador(""), false);
  assert.equal(temEntregador("   "), false);
});
test("temEntregador: nome de verdade conta como COM entregador", () => {
  assert.equal(temEntregador("Carlos"), true);
  assert.equal(temEntregador("  Ana  "), true);
});

// ---------- resumo financeiro ----------
test("resumoConciliacao soma taxas brutas/descartadas/válidas corretamente", () => {
  const pedidos = [
    { situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { situacao: "Cancelado", taxaEntregador: 15, statusConciliacao: "cancelado_com_taxa" },
    { situacao: "Cancelado", taxaEntregador: 8, statusConciliacao: "excluido" },
  ];
  const r = resumoConciliacao(pedidos);
  assert.equal(r.totalPedidos, 3);
  assert.equal(r.entregues, 1);
  assert.equal(r.cancelados, 2);
  assert.equal(r.canceladosComTaxa, 1);
  assert.equal(r.canceladosSemTaxa, 1);
  assert.equal(r.taxasBrutas, 33);
  assert.equal(r.taxasDescartadas, 8);
  assert.equal(r.taxasValidas, 25);
});

// ---------- agrupamento por entregador ----------
test("agruparPorEntregador conta por entregador e só soma taxa válida", () => {
  const pedidos = [
    { entregador: "Ana", situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { entregador: "Ana", situacao: "Cancelado", taxaEntregador: 5, statusConciliacao: "excluido" },
    { entregador: "Bruno", situacao: "Cancelado", taxaEntregador: 7, statusConciliacao: "cancelado_com_taxa" },
  ];
  const g = agruparPorEntregador(pedidos);
  const ana = g.find((e) => e.entregador === "Ana");
  const bruno = g.find((e) => e.entregador === "Bruno");
  assert.equal(ana.totalPedidos, 2);
  assert.equal(ana.entregues, 1);
  assert.equal(ana.canceladosSemTaxa, 1);
  assert.equal(ana.taxasValidas, 10); // a taxa do cancelado sem taxa NÃO entra
  assert.equal(bruno.canceladosComTaxa, 1);
  assert.equal(bruno.taxasValidas, 7); // cancelado com taxa MANTÉM a taxa
});

test("agruparPorEntregador: pedido sem entregador não aparece no ranking de taxas", () => {
  const pedidos = [
    { entregador: "Ana", situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { entregador: null, situacao: "Cancelado", taxaEntregador: 12, statusConciliacao: "excluido" },
    { entregador: "", situacao: "Cancelado", taxaEntregador: 9, statusConciliacao: "excluido" },
    { situacao: "Cancelado", taxaEntregador: 5, statusConciliacao: "excluido" }, // entregador nem existe no objeto
  ];
  const g = agruparPorEntregador(pedidos);
  assert.equal(g.length, 1); // só a Ana — nenhuma linha "—" pros sem entregador
  assert.equal(g[0].entregador, "Ana");
  assert.equal(g.some((e) => e.entregador === "—"), false);
});

test("agruparPorEntregador unifica variações seguras de caixa, acento e espaços", () => {
  const r = agruparPorEntregador([
    { entregador: "Ana  Silva", situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { entregador: "ANA SILVA", situacao: "Finalizado", taxaEntregador: 12, statusConciliacao: "incluido" },
    { entregador: "Ána Silva", situacao: "Finalizado", taxaEntregador: 8, statusConciliacao: "incluido" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].entregador, "Ana Silva");
  assert.equal(r[0].taxasValidas, 30);
});

// ---------- validação de código digitado (item 2 do pedido) ----------
test("validarCodigo cobre encontrado/não encontrado/não cancelado", () => {
  const mapa = new Map([["1", { situacao: "Cancelado", entregador: "Ana" }], ["2", { situacao: "Finalizado", entregador: "Ana" }]]);
  assert.equal(validarCodigo("1", mapa).encontrado, true);
  assert.equal(validarCodigo("1", mapa).alerta, null);
  assert.notEqual(validarCodigo("2", mapa).alerta, null); // encontrado mas não cancelado -> aviso
  assert.equal(validarCodigo("9", mapa).encontrado, false);
});

// ---------- validação de código de outra operação (complemento: filtro Subway) ----------
test("validarCodigo avisa quando o código pertence a outra operação, em vez de 'não encontrado'", () => {
  const mapa = new Map([["6222", { situacao: "Cancelado", operacao: "acai_no_grau" }]]);
  const r = validarCodigo("6222", mapa);
  assert.equal(r.encontrado, true);
  assert.equal(r.operacao, "acai_no_grau");
  assert.match(r.alerta, /outra operação/);
});
test("validarCodigo funciona normalmente para pedido explicitamente marcado 'subway'", () => {
  const mapa = new Map([["1", { situacao: "Cancelado", operacao: "subway", entregador: "Ana" }]]);
  const r = validarCodigo("1", mapa);
  assert.equal(r.encontrado, true);
  assert.equal(r.alerta, null);
});

// ---------- validação de código sem entregador (complemento: não entra na conta) ----------
test("validarCodigo avisa quando o pedido não tem entregador, em vez de tratar como cancelamento normal", () => {
  const mapa = new Map([["9", { situacao: "Cancelado", operacao: "subway", entregador: null }]]);
  const r = validarCodigo("9", mapa);
  assert.equal(r.encontrado, true);
  assert.match(r.alerta, /não tem entregador/);
});

test("extrairCodigos separa por vírgula, espaço e quebra de linha, sem duplicar", () => {
  assert.deepEqual(extrairCodigos("111, 222 333\n111"), ["111", "222", "333"]);
});

// ---------- resolverStatusConciliacao: ponte entre o motor automático e a conciliação financeira ----------
test("resolverStatusConciliacao: recebe_taxa mantém a taxa (cancelado_com_taxa)", () => {
  assert.equal(resolverStatusConciliacao(CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA), STATUS_CONCILIACAO.CANCELADO_COM_TAXA);
});
test("resolverStatusConciliacao: nao_recebe_taxa descarta a taxa (excluido)", () => {
  assert.equal(resolverStatusConciliacao(CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA), STATUS_CONCILIACAO.EXCLUIDO);
});
test("resolverStatusConciliacao: revisar MANTÉM a taxa por padrão (decisão do usuário — nunca retém pagamento em revisão)", () => {
  assert.equal(resolverStatusConciliacao(CLASSIFICACAO_CANCELAMENTO.REVISAR), STATUS_CONCILIACAO.CANCELADO_COM_TAXA);
});

// ---------- resumoConciliacao: contadores da análise automática (seção 25/53 do pedido) ----------
test("resumoConciliacao conta recebe/não recebe/revisão separadamente da conciliação financeira", () => {
  const pedidos = [
    { situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { situacao: "Cancelado", taxaEntregador: 11, statusConciliacao: "cancelado_com_taxa", classificacaoCancelamento: "recebe_taxa" },
    { situacao: "Cancelado", taxaEntregador: 8, statusConciliacao: "excluido", classificacaoCancelamento: "nao_recebe_taxa" },
    { situacao: "Cancelado", taxaEntregador: 16, statusConciliacao: "cancelado_com_taxa", classificacaoCancelamento: "revisar" },
  ];
  const r = resumoConciliacao(pedidos);
  assert.equal(r.canceladosRecebemTaxa, 1);
  assert.equal(r.canceladosNaoRecebemTaxa, 1);
  assert.equal(r.canceladosRevisao, 1);
  // revisar mantém a taxa -> entra em canceladosComTaxa/taxasValidas normalmente
  assert.equal(r.canceladosComTaxa, 2);
  assert.equal(r.canceladosSemTaxa, 1);
  assert.equal(r.taxasValidas, 10 + 11 + 16);
});

// ---------- item 53 do pedido: consistência financeira entre resumo/entregadores/conciliação ----------
test("consistência financeira: soma dos entregadores bate com taxasValidas do resumo, incluindo um pedido em revisão", () => {
  const pedidos = [
    { entregador: "Ana", situacao: "Finalizado", taxaEntregador: 20, statusConciliacao: "incluido", classificacaoCancelamento: null },
    { entregador: "Ana", situacao: "Cancelado", taxaEntregador: 11, statusConciliacao: "cancelado_com_taxa", classificacaoCancelamento: "recebe_taxa" },
    { entregador: "Bruno", situacao: "Cancelado", taxaEntregador: 8, statusConciliacao: "excluido", classificacaoCancelamento: "nao_recebe_taxa" },
    { entregador: "Bruno", situacao: "Cancelado", taxaEntregador: 16, statusConciliacao: "cancelado_com_taxa", classificacaoCancelamento: "revisar" },
  ];
  const resumo = resumoConciliacao(pedidos);
  const entregadores = agruparPorEntregador(pedidos);
  const somaEntregadores = entregadores.reduce((acc, e) => acc + e.taxasValidas, 0);
  assert.equal(Math.round(somaEntregadores * 100) / 100, resumo.taxasValidas);
  assert.equal(resumo.taxasValidas, 20 + 11 + 16);
  const bruno = entregadores.find((e) => e.entregador === "Bruno");
  assert.equal(bruno.canceladosRevisao, 1);
});

// =====================================================================
// Agente Crescer (Etapa D) — agregação mensal, calendário e explicação
// individual de cancelamento. Todas puras, sem I/O.
// =====================================================================

// ---------- somarResumosPeriodo ----------
test("somarResumosPeriodo: soma campo a campo, sem reclassificar nada", () => {
  const importacoes = [
    { totalPedidos: 100, entregues: 80, cancelados: 20, canceladosComTaxa: 15, canceladosSemTaxa: 5, canceladosRecebemTaxa: 10, canceladosNaoRecebemTaxa: 5, canceladosRevisao: 5, taxasBrutas: 200, taxasDescartadas: 50, taxasValidas: 150 },
    { totalPedidos: 50, entregues: 45, cancelados: 5, canceladosComTaxa: 4, canceladosSemTaxa: 1, canceladosRecebemTaxa: 3, canceladosNaoRecebemTaxa: 1, canceladosRevisao: 1, taxasBrutas: 60, taxasDescartadas: 10, taxasValidas: 50 },
  ];
  const r = somarResumosPeriodo(importacoes);
  assert.equal(r.totalImportacoes, 2);
  assert.equal(r.totalPedidos, 150);
  assert.equal(r.cancelados, 25);
  assert.equal(r.canceladosRecebemTaxa, 13);
  assert.equal(r.canceladosNaoRecebemTaxa, 6);
  assert.equal(r.canceladosRevisao, 6);
  assert.equal(r.taxasBrutas, 260);
  assert.equal(r.taxasValidas, 200);
});

test("somarResumosPeriodo: lista vazia (nenhuma importação no mês) -> tudo zero, nunca lança", () => {
  const r = somarResumosPeriodo([]);
  assert.equal(r.totalImportacoes, 0);
  assert.equal(r.totalPedidos, 0);
  assert.equal(r.taxasValidas, 0);
});

test("somarResumosPeriodo: campo ausente numa importação conta como 0, sem quebrar a soma", () => {
  const r = somarResumosPeriodo([{ totalPedidos: 10 }, { totalPedidos: 5, cancelados: 2 }]);
  assert.equal(r.totalPedidos, 15);
  assert.equal(r.cancelados, 2);
});

// ---------- limitesDoMes / inicioMesSeguinte ----------
test("limitesDoMes: primeiro e último dia do mês", () => {
  assert.deepEqual(limitesDoMes(2026, 8), { inicio: "2026-08-01", fim: "2026-08-31" });
  assert.deepEqual(limitesDoMes(2026, 2), { inicio: "2026-02-01", fim: "2026-02-28" }); // 2026 não é bissexto
});

test("inicioMesSeguinte: caso comum e virada de ano (dezembro -> janeiro)", () => {
  assert.equal(inicioMesSeguinte(2026, 8), "2026-09-01");
  assert.equal(inicioMesSeguinte(2026, 12), "2027-01-01");
});

// ---------- resolverCandidatoPedido ----------
test("resolverCandidatoPedido: sem candidatos -> nao_encontrado", () => {
  assert.deepEqual(resolverCandidatoPedido([]), { status: "nao_encontrado" });
  assert.deepEqual(resolverCandidatoPedido(undefined), { status: "nao_encontrado" });
});

test("resolverCandidatoPedido: 1 candidato -> unico, mesmo sem filtro de período", () => {
  const r = resolverCandidatoPedido([{ dataHora: "2026-08-04T10:00:00" }]);
  assert.equal(r.status, "unico");
  assert.equal(r.candidato.dataHora, "2026-08-04T10:00:00");
});

test("resolverCandidatoPedido: 2+ candidatos SEM ano/mes informado -> ambiguo, nunca escolhe sozinho", () => {
  const r = resolverCandidatoPedido([{ dataHora: "2026-08-04T10:00:00" }, { dataHora: "2026-05-01T08:00:00" }]);
  assert.equal(r.status, "ambiguo");
  assert.equal(r.candidatos.length, 2);
});

test("resolverCandidatoPedido: 2+ candidatos, ano/mes informado -> filtra pelo mês do PEDIDO e resolve", () => {
  const candidatos = [{ dataHora: "2026-08-04T10:00:00" }, { dataHora: "2026-05-01T08:00:00" }];
  const r = resolverCandidatoPedido(candidatos, { ano: 2026, mes: 8 });
  assert.equal(r.status, "unico");
  assert.equal(r.candidato.dataHora, "2026-08-04T10:00:00");
});

test("resolverCandidatoPedido: ano/mes informado mas nenhum candidato bate -> nao_encontrado (nunca inventa um resultado próximo)", () => {
  const r = resolverCandidatoPedido([{ dataHora: "2026-05-01T08:00:00" }], { ano: 2026, mes: 8 });
  assert.equal(r.status, "nao_encontrado");
});

test("resolverCandidatoPedido: só ano OU só mes informado (não os dois) -> filtro não aplicado", () => {
  const candidatos = [{ dataHora: "2026-08-04T10:00:00" }, { dataHora: "2026-05-01T08:00:00" }];
  assert.equal(resolverCandidatoPedido(candidatos, { ano: 2026 }).status, "ambiguo");
  assert.equal(resolverCandidatoPedido(candidatos, { mes: 8 }).status, "ambiguo");
});

// ---------- explicarCancelamento ----------
const PEDIDO_BASE = {
  numeroPedido: "123", dataHora: "2026-08-04T19:00:00", situacao: "Cancelado", entregador: "Ana",
  operacao: OPERACAO.SUBWAY, classificacaoCancelamento: CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA,
  classificacaoMotivo: "Há registro de coleta e de chegada ao endereço antes do cancelamento.",
  classificacaoNivelConfianca: "muito_alta", classificacaoRegra: "regra_chegada",
  statusConciliacao: STATUS_CONCILIACAO.CANCELADO_COM_TAXA,
  dataDespachado: "2026-08-04T18:40:00", dataAceito: "2026-08-04T18:41:00",
  dataColetado: "2026-08-04T18:50:00", dataChegadaEntrega: "2026-08-04T18:58:00", dataCancelado: "2026-08-04T19:00:00",
  classificacaoOverrideEm: null, classificacaoOverrideUsuarioNome: null, classificacaoOverrideMotivo: null,
};

test("explicarCancelamento: pedido NÃO cancelado -> cancelado: false, nenhum campo de classificação", () => {
  const r = explicarCancelamento({ ...PEDIDO_BASE, situacao: "Finalizado" });
  assert.equal(r.cancelado, false);
  assert.equal("classificacaoAutomatica" in r, false);
});

test("explicarCancelamento: cancelado, RECEBE taxa — decisão, motivo, confiança, regra e timeline vêm intactos, nunca recalculados", () => {
  const r = explicarCancelamento(PEDIDO_BASE);
  assert.equal(r.cancelado, true);
  assert.equal(r.elegivelConciliacao, true);
  assert.equal(r.classificacaoDisponivel, true);
  assert.equal(r.classificacaoAutomatica.decisao, CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA);
  assert.equal(r.classificacaoAutomatica.regra, "regra_chegada");
  assert.equal(r.classificacaoAutomatica.nivelConfianca, "muito_alta");
  assert.equal(r.emRevisao, false);
  assert.equal(r.correcaoManual, null);
  assert.deepEqual(r.timeline, {
    dataDespachado: "2026-08-04T18:40:00", dataAceito: "2026-08-04T18:41:00",
    dataColetado: "2026-08-04T18:50:00", dataChegadaEntrega: "2026-08-04T18:58:00", dataCancelado: "2026-08-04T19:00:00",
  });
});

test("explicarCancelamento: cancelado, NÃO recebe taxa", () => {
  const r = explicarCancelamento({ ...PEDIDO_BASE, classificacaoCancelamento: CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA, statusConciliacao: STATUS_CONCILIACAO.EXCLUIDO });
  assert.equal(r.classificacaoAutomatica.decisao, CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA);
  assert.equal(r.statusFinanceiroAtual, STATUS_CONCILIACAO.EXCLUIDO);
});

test("explicarCancelamento: em REVISAR -> emRevisao: true, mas a taxa continua contada (mantida por padrão)", () => {
  const r = explicarCancelamento({ ...PEDIDO_BASE, classificacaoCancelamento: CLASSIFICACAO_CANCELAMENTO.REVISAR, statusConciliacao: STATUS_CONCILIACAO.CANCELADO_COM_TAXA });
  assert.equal(r.emRevisao, true);
  assert.equal(r.statusFinanceiroAtual, STATUS_CONCILIACAO.CANCELADO_COM_TAXA);
});

test("explicarCancelamento: com correção manual -> correcaoManual preenchido, classificacaoAutomatica preserva o ORIGINAL do motor", () => {
  const r = explicarCancelamento({
    ...PEDIDO_BASE,
    classificacaoOverrideEm: "2026-08-05T10:00:00", classificacaoOverrideUsuarioNome: "Consultor João", classificacaoOverrideMotivo: "Confirmado com o entregador.",
  });
  assert.deepEqual(r.correcaoManual, { usuarioNome: "Consultor João", motivo: "Confirmado com o entregador.", em: "2026-08-05T10:00:00" });
  // A automática NUNCA é sobrescrita pela correção manual.
  assert.equal(r.classificacaoAutomatica.decisao, CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA);
});

test("explicarCancelamento: cancelado mas de OUTRA operação -> elegivelConciliacao: false, nunca classifica", () => {
  const r = explicarCancelamento({ ...PEDIDO_BASE, operacao: OPERACAO.ACAI_NO_GRAU, classificacaoCancelamento: null });
  assert.equal(r.cancelado, true);
  assert.equal(r.elegivelConciliacao, false);
  assert.match(r.motivoNaoElegivel, /outra operação/i);
  assert.equal("classificacaoAutomatica" in r, false);
});

test("explicarCancelamento: cancelado, SEM entregador atribuído -> elegivelConciliacao: false", () => {
  const r = explicarCancelamento({ ...PEDIDO_BASE, entregador: null, classificacaoCancelamento: null });
  assert.equal(r.elegivelConciliacao, false);
  assert.match(r.motivoNaoElegivel, /entregador/i);
});

test("explicarCancelamento: cancelado, elegível, mas SEM classificação registrada (importação anterior ao motor) -> classificacaoDisponivel: false, nunca inventa uma decisão", () => {
  const r = explicarCancelamento({ ...PEDIDO_BASE, classificacaoCancelamento: null });
  assert.equal(r.elegivelConciliacao, true);
  assert.equal(r.classificacaoDisponivel, false);
  assert.equal("classificacaoAutomatica" in r, false);
  assert.ok(r.motivo);
});
