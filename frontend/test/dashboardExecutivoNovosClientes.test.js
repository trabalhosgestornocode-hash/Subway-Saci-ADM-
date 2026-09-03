import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const frontendUrl = new URL("../src/dashboardExecutivo.js", import.meta.url);
const serviceUrl = new URL("../../backend/src/modules/dashboard-executivo/dashboardExecutivo.service.js", import.meta.url);

describe("Dashboard Executivo — card Novos Clientes", () => {
  test("aparece depois de Ticket Médio e antes dos indicadores financeiros", async () => {
    const fonte = await readFile(frontendUrl, "utf8");
    const ticket = fonte.indexOf('cardDef("Ticket Médio"');
    const novos = fonte.indexOf('cardDef("Novos Clientes"');
    const taxas = fonte.indexOf('cardDef("Taxas e Comissões"');
    assert.ok(ticket >= 0 && novos > ticket && taxas > novos);
  });

  test("é informativo e não recebe meta, status, saldo ou barra", async () => {
    const fonte = await readFile(frontendUrl, "utf8");
    const inicio = fonte.indexOf('cardDef("Novos Clientes"');
    const fim = fonte.indexOf('cardDef("Taxas e Comissões"', inicio);
    const card = fonte.slice(inicio, fim);
    assert.doesNotMatch(card, /metaBarraHtml|pill|status|saldo/);
  });

  test("API usa a mesma variável no card e no acumulado de Desempenho", async () => {
    const fonte = await readFile(serviceUrl, "utf8");
    assert.match(fonte, /const novosClientes = novosClientesAcumulados/);
    assert.match(fonte, /novosClientes:\s*\{ valor: novosClientes \}/);
    assert.match(fonte, /acumuladoNovosClientes:\s*novosClientes/);
    assert.match(fonte, /novosClientes:\s*\{ valor: novosClientesAgregado \}/);
    assert.match(fonte, /acumuladoNovosClientes:\s*novosClientesAgregado/);
  });

  test("histórico mantém uma única chave compatível para o conceito", async () => {
    const fonte = await readFile(serviceUrl, "utf8");
    assert.match(fonte, /faturamento, qtdVendas, novosClientes,/);
    assert.doesNotMatch(fonte, /novosClientesCard|novosClientesVisaoGeral/);
  });
});
