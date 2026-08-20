import { test } from "node:test";
import assert from "node:assert/strict";
import { classificarCancelamento, CLASSIFICACAO_CANCELAMENTO, NIVEL_CONFIANCA } from "../src/modules/parser-food-delivery/parserFoodDelivery.classificacao.js";

const { RECEBE_TAXA, NAO_RECEBE_TAXA, REVISAR } = CLASSIFICACAO_CANCELAMENTO;
const { MUITO_ALTA, ALTA, INCONCLUSIVA } = NIVEL_CONFIANCA;

// ---------- casos reais do arquivo de exemplo do usuário (2026-08-19) ----------
// Pedido #8015 — Alisson Carlos dos Santos, aba Subway_Saci do relatório real.
test("caso real #8015 (coletado, sem chegada): RECEBE_TAXA, confiança alta, regra_coleta", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T00:13:10", dataAceito: "2026-08-17T00:13:55",
    dataColetado: "2026-08-17T00:23:12", dataChegadaEntrega: null,
    dataCancelado: "2026-08-17T01:02:09",
    justificativaCancelamento: "o endereço está incompleto e o cliente não atende.",
  });
  assert.equal(r.classificacao, RECEBE_TAXA);
  assert.equal(r.nivelConfianca, ALTA);
  assert.equal(r.regra, "regra_coleta");
  assert.match(r.motivo, /coletado antes do cancelamento/i);
});

// Pedido #2100 — mesmo relatório, com "Data da chegada para entrega" preenchida.
test("caso real #2100 (coletado + chegada): RECEBE_TAXA, confiança muito alta, regra_chegada", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T01:26:25", dataAceito: "2026-08-17T01:26:36",
    dataColetado: "2026-08-17T01:34:05", dataChegadaEntrega: "2026-08-17T01:54:38",
    dataCancelado: "2026-08-17T02:25:09",
    justificativaCancelamento: "o endereço está incompleto e o cliente não atende.",
  });
  assert.equal(r.classificacao, RECEBE_TAXA);
  assert.equal(r.nivelConfianca, MUITO_ALTA);
  assert.equal(r.regra, "regra_chegada");
});

// ---------- casos A-G da seção 52 do pedido ----------
test("Caso A — Despachado → Aceito → Coletado → Cancelado: RECEBE_TAXA", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T15:20:00", dataAceito: "2026-08-17T15:21:00",
    dataColetado: "2026-08-17T15:24:00", dataChegadaEntrega: null, dataCancelado: "2026-08-17T15:40:00",
  });
  assert.equal(r.classificacao, RECEBE_TAXA);
});

test("Caso B — Despachado → Aceito → Coletado → Chegada → Cancelado: RECEBE_TAXA com confiança maior", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T15:20:00", dataAceito: "2026-08-17T15:21:00",
    dataColetado: "2026-08-17T15:24:00", dataChegadaEntrega: "2026-08-17T15:35:00", dataCancelado: "2026-08-17T15:40:00",
  });
  assert.equal(r.classificacao, RECEBE_TAXA);
  assert.equal(r.nivelConfianca, MUITO_ALTA);
});

test("Caso C — Despachado → Aceito → Cancelado (sem coleta): NAO_RECEBE_TAXA", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T15:20:00", dataAceito: "2026-08-17T15:21:00",
    dataColetado: null, dataChegadaEntrega: null, dataCancelado: "2026-08-17T15:25:00",
  });
  assert.equal(r.classificacao, NAO_RECEBE_TAXA);
  assert.equal(r.nivelConfianca, ALTA);
  assert.equal(r.regra, "regra_sem_coleta");
});

test("Caso E — dados contraditórios (cancelamento antes da coleta): REVISAR", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T15:20:00", dataAceito: "2026-08-17T15:21:00",
    dataColetado: "2026-08-17T15:40:00", dataChegadaEntrega: null, dataCancelado: "2026-08-17T15:25:00",
  });
  assert.equal(r.classificacao, REVISAR);
  assert.equal(r.nivelConfianca, INCONCLUSIVA);
});

test("cancelado com entregador mas nenhum evento logístico registrado: REVISAR (nunca força decisão)", () => {
  const r = classificarCancelamento({
    dataDespachado: null, dataAceito: null, dataColetado: null, dataChegadaEntrega: null,
    dataCancelado: "2026-08-17T15:25:00",
  });
  assert.equal(r.classificacao, REVISAR);
});

test("sem o próprio horário de cancelamento: REVISAR (insuficiente por definição)", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T15:20:00", dataAceito: "2026-08-17T15:21:00",
    dataColetado: "2026-08-17T15:24:00", dataChegadaEntrega: null, dataCancelado: null,
  });
  assert.equal(r.classificacao, REVISAR);
});

// ---------- item 22 do pedido: nunca decidir só pelo tempo decorrido ----------
test("coleta muito próxima do cancelamento ainda RECEBE_TAXA — tempo é contexto, não critério", () => {
  const r = classificarCancelamento({
    dataDespachado: "2026-08-17T14:00:00", dataAceito: "2026-08-17T14:00:30",
    dataColetado: "2026-08-17T14:01:00", dataChegadaEntrega: null, dataCancelado: "2026-08-17T14:01:30",
  });
  assert.equal(r.classificacao, RECEBE_TAXA);
});

// ---------- item 20 do pedido: "Aceito" sozinho nunca é suficiente ----------
test("só aceito (sem despacho nem coleta) cancelado depois: NAO_RECEBE_TAXA, nunca trata aceite como entrega iniciada", () => {
  const r = classificarCancelamento({
    dataDespachado: null, dataAceito: "2026-08-17T15:21:00",
    dataColetado: null, dataChegadaEntrega: null, dataCancelado: "2026-08-17T15:25:00",
  });
  assert.equal(r.classificacao, NAO_RECEBE_TAXA);
});

test("despacho ou aceite posteriores ao cancelamento tornam a cronologia inconclusiva", () => {
  for (const campo of ["dataDespachado", "dataAceito"]) {
    const r = classificarCancelamento({ [campo]: "2026-08-17T11:00:00", dataCancelado: "2026-08-17T10:00:00" });
    assert.equal(r.classificacao, REVISAR, campo);
  }
});

test("coleta ou chegada posteriores ao cancelamento tornam a cronologia inconclusiva", () => {
  for (const campo of ["dataColetado", "dataChegadaEntrega"]) {
    const r = classificarCancelamento({
      dataColetado: campo === "dataColetado" ? "2026-08-17T11:00:00" : "2026-08-17T09:50:00",
      dataChegadaEntrega: campo === "dataChegadaEntrega" ? "2026-08-17T11:00:00" : null,
      dataCancelado: "2026-08-17T10:00:00",
    });
    assert.equal(r.classificacao, REVISAR, campo);
  }
});

test("timestamp igual ao cancelamento é aceito como evidência, sem inverter a cronologia", () => {
  const coleta = classificarCancelamento({ dataColetado: "2026-08-17T10:00:00", dataCancelado: "2026-08-17T10:00:00" });
  const aceite = classificarCancelamento({ dataAceito: "2026-08-17T10:00:00", dataCancelado: "2026-08-17T10:00:00" });
  assert.equal(coleta.classificacao, RECEBE_TAXA);
  assert.equal(aceite.classificacao, NAO_RECEBE_TAXA);
});

// ---------- item 23 do pedido: justificativa é contexto, nunca decide sozinha ----------
test("justificativa mencionando endereço não muda a decisão baseada em eventos", () => {
  const semColeta = classificarCancelamento({
    dataDespachado: "2026-08-17T15:20:00", dataAceito: "2026-08-17T15:21:00", dataColetado: null,
    dataCancelado: "2026-08-17T15:25:00", justificativaCancelamento: "endereço incompleto e cliente não atende",
  });
  assert.equal(semColeta.classificacao, NAO_RECEBE_TAXA);
  assert.match(semColeta.motivo, /Justificativa do cancelamento/);
});
