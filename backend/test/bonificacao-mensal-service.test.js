// Testes E (ponta a ponta) e F do item 76 — fluxo real de importação contra
// o banco (migration 028 aplicada). Usa a unidade real Subway Saci e uma
// data de teste isolada (2020-06-15, fora de qualquer operação real), e
// limpa tudo o que criar ao final. Rodar: node --env-file=.env --test test/bonificacao-mensal-service.test.js
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../src/config/supabase.js";
import { processarImportacaoVisio, obterMes, listarMetas } from "../src/modules/bonificacao-mensal/bonificacaoMensal.service.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SACI_UNIDADE_ID = "00000000-0000-0000-0000-0000000000a1";
const OUTRA_UNIDADE_ID = "768a8c0c-fe9b-4576-a8df-f0ffa10b444e"; // Loja Florianópolis-SC 1 (unidade de teste real do sistema)
// A tabela de lançamentos é NOVA (nenhuma linha pré-existente pra qualquer
// data), então não há risco de colisão com dado real — mas a data PRECISA
// cair dentro da vigência da meta semeada (valid_from 2026-08-01) pra
// evaluateBonusMetric ter meta pra avaliar.
const DATA_TESTE = "2026-08-01";
const USUARIO = { id: null, nome: "teste automatizado (bonificacao-mensal-service.test.js)" };

const b64 = (path) => readFileSync(join(FIXTURES, path)).toString("base64");
const payloadCompleto = () => ({
  data: DATA_TESTE,
  geral: { nomeArquivo: "visio-geral.pdf", conteudoBase64: b64("visio-geral.pdf") },
  loja: { nomeArquivo: "visio-loja.pdf", conteudoBase64: b64("visio-loja.pdf") },
});

async function limparDadosDeTeste() {
  const { data: imps } = await supabase.from("bonificacao_importacoes").select("id, arquivo_storage").eq("unidade_id", SACI_UNIDADE_ID).eq("data_lancamento", DATA_TESTE);
  for (const imp of imps || []) {
    if (imp.arquivo_storage) await supabase.storage.from("bonificacao-visio").remove([imp.arquivo_storage]);
  }
  await supabase.from("bonificacao_lancamentos_diarios").delete().eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE);
  await supabase.from("bonificacao_importacoes").delete().eq("unidade_id", SACI_UNIDADE_ID).eq("data_lancamento", DATA_TESTE);
}

describe("Migration 028 aplicada — metas seedadas", () => {
  test("Subway Saci tem os 11 indicadores cadastrados", async () => {
    const metas = await listarMetas({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID });
    assert.equal(metas.length, 11);
    const bebidas = metas.find((m) => m.indicador === "bebidas");
    assert.equal(bebidas.direcao, "higher_is_better");
    assert.deepEqual(bebidas.faixas.map((f) => f.bonus), [25, 50, 75]);
    const cmv = metas.find((m) => m.indicador === "cmv");
    assert.equal(cmv.direcao, "lower_is_better");
    assert.equal(cmv.faixas.find((f) => f.tipo === "limite_maximo").bonus, 200);
    const avaliacao = metas.find((m) => m.indicador === "avaliacao_ifood");
    assert.equal(avaliacao.faixas[0].bonus, null); // sem valor definido — item 60
  });
});

describe("Teste E (ponta a ponta) — relatório de outra unidade é bloqueado", () => {
  after(limparDadosDeTeste);
  test("PDF da Subway Saci enviado com a Florianópolis-SC 1 selecionada é recusado", async () => {
    await assert.rejects(
      () => processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: OUTRA_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: false }),
      (err) => { assert.match(err.message, /unidade diferente/i); return true; },
    );
  });
});

describe("Fluxo completo de importação + Teste F (duplicidade)", () => {
  after(limparDadosDeTeste);

  test("preview não persiste nada", async () => {
    await limparDadosDeTeste();
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: false });
    assert.equal(r.persistido, false);
    assert.equal(r.duplicado, false);
    assert.equal(r.preview.geral.faturamento, 9845.09);
    assert.equal(r.preview.loja.faturamento, 3893.15);
    const { data: nada } = await supabase.from("bonificacao_lancamentos_diarios").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE).maybeSingle();
    assert.equal(nada, null);
  });

  test("confirmar persiste o lançamento com os valores corretos", async () => {
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r.persistido, true);
    assert.equal(r.lancamento.faturamentoGeral, 9845.09);
    assert.equal(r.lancamento.ppdGeral, 168);
    assert.equal(r.lancamento.faturamentoLoja, 3893.15);
    assert.equal(r.lancamento.qtdSanduichesLoja, 132);
    assert.equal(r.lancamento.qtdBebidasLoja, 56);
    assert.equal(r.lancamento.origem, "visio");
    assert.ok(Math.abs(r.lancamento.mix.bebidas - 42.42) < 0.1);
  });

  test("Teste F — reimportar o mesmo dia sem 'substituir' é bloqueado com valores atuais x novos", async () => {
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: false });
    assert.equal(r.duplicado, true);
    assert.equal(r.existente.faturamentoGeral, 9845.09); // valor atual
    assert.equal(r.preview.geral.faturamento, 9845.09); // valor novo (mesmos PDFs neste teste)
  });

  test("Teste F — com 'substituir', o mesmo dia é atualizado, não duplicado", async () => {
    const payload = { ...payloadCompleto(), substituir: true };
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload, confirmar: true });
    assert.equal(r.persistido, true);
    const { data: linhas, error } = await supabase.from("bonificacao_lancamentos_diarios").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE);
    assert.equal(error, null);
    assert.equal(linhas.length, 1); // continua sendo UMA linha, não duplicou
  });

  test("obterMes reflete o lançamento com status IMPORTADO e a meta de bebidas avaliada", async () => {
    const r = await obterMes({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: 2026, mes: 8 });
    const dia = r.calendario.find((d) => d.data === DATA_TESTE);
    assert.equal(dia.status, "IMPORTADO");
    assert.equal(dia.lancamento.faturamentoGeral, 9845.09);
    // bebidas do mês (só este 1 dia lançado): 56/132 = 42,42% -> faixa >=40% (R$25), abaixo de 45%
    assert.equal(r.indicadores.bebidas.bonusAtual, 25);
    assert.equal(r.indicadores.bebidas.status, "dentro_da_meta");
  });

  test("correção manual na importação marca manualOverride", async () => {
    const payload = { ...payloadCompleto(), substituir: true, correcoes: { geral: { faturamento: 9999.99 } } };
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload, confirmar: true });
    assert.equal(r.lancamento.faturamentoGeral, 9999.99);
    assert.equal(r.lancamento.manualOverride.faturamento_geral, true);
    assert.equal(r.lancamento.origem, "misto");
  });
});
