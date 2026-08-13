import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarDadosLancamento } from "../src/modules/dashboard-executivo/dashboardExecutivo.service.js";

// Complemento "Salvar como rascunho": a mesma normalização agora precisa
// aceitar dado incompleto quando statusAlvo === 'rascunho', mesmo em cenários
// que antes eram sempre obrigatórios (financeiro elegível, motivo de "sem
// operação"), e continuar exigindo tudo quando statusAlvo === 'finalizado'.
const OPCOES = { podeAjustarNegativo: false, exigirFinanceiro: true, desempenhoAnterior: null };

test("rascunho: situação normal, financeiro elegível, nada preenchido -> aceita, tudo null", () => {
  const dados = normalizarDadosLancamento({ situacao: "normal", status: "rascunho" }, OPCOES);
  assert.equal(dados.statusAlvo, "rascunho");
  assert.equal(dados.qtdVendas, null);
  assert.equal(dados.valorVendasBruto, null);
  assert.equal(dados.valorVendasIfood, null);
  assert.equal(dados.taxasComissoes, null);
  assert.equal(dados.outrasDeducoes, null);
});

test("finalizado: situação normal, financeiro elegível, sem valorVendasIfood -> rejeita", () => {
  assert.throws(() => normalizarDadosLancamento(
    { situacao: "normal", status: "finalizado", taxasComissoes: 10, servicosPromocoes: 5, taxasEntregadores: 2, outrasDeducoes: 0 },
    OPCOES,
  ), /Valor das vendas \(iFood\)/);
});

test("finalizado: situação normal, financeiro elegível, tudo preenchido -> aceita", () => {
  const dados = normalizarDadosLancamento(
    { situacao: "normal", status: "finalizado", valorVendasIfood: 100, taxasComissoes: 10, servicosPromocoes: 5, taxasEntregadores: 2, outrasDeducoes: 0 },
    OPCOES,
  );
  assert.equal(dados.statusAlvo, "finalizado");
  assert.equal(dados.valorVendasIfood, 100);
});

test("rascunho: financeiro NÃO elegível (dia comum) -> nunca exige, igual antes", () => {
  const dados = normalizarDadosLancamento({ situacao: "normal", status: "rascunho" }, { ...OPCOES, exigirFinanceiro: false });
  assert.equal(dados.valorVendasIfood, null);
});

test("rascunho: situação sem_operacao sem motivo -> aceita (motivo fica null)", () => {
  const dados = normalizarDadosLancamento({ situacao: "sem_operacao", status: "rascunho" }, OPCOES);
  assert.equal(dados.statusAlvo, "rascunho");
  assert.equal(dados.motivoSemOperacao, null);
});

test("finalizado: situação sem_operacao sem motivo -> rejeita", () => {
  assert.throws(() => normalizarDadosLancamento({ situacao: "sem_operacao", status: "finalizado" }, OPCOES), /Motivo de não operação/);
});

test("finalizado: situação sem_operacao com motivo -> aceita", () => {
  const dados = normalizarDadosLancamento({ situacao: "sem_operacao", status: "finalizado", motivoSemOperacao: "Feriado" }, OPCOES);
  assert.equal(dados.motivoSemOperacao, "Feriado");
});

test("status ausente no corpo -> assume 'rascunho' por padrão (nunca finalizado por engano)", () => {
  const dados = normalizarDadosLancamento({ situacao: "normal" }, OPCOES);
  assert.equal(dados.statusAlvo, "rascunho");
});

test("rascunho: campos negativos continuam rejeitados mesmo sendo opcionais", () => {
  assert.throws(() => normalizarDadosLancamento({ situacao: "normal", status: "rascunho", qtdVendas: -1 }, OPCOES), /Quantidade de vendas/);
});
