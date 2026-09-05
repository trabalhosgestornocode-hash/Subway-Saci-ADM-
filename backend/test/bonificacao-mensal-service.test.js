// Testes E (ponta a ponta) e F do item 76 — fluxo real de importação contra
// o banco (migrations 028 e 041 aplicadas). Roda contra o MESMO Supabase de
// produção (não existe banco de teste isolado — `npm test` carrega o .env
// normal), então usa uma unidade DE TESTE dedicada (eh_teste=true, migration
// 041), nunca a unidade real da Subway Saci — essa era a causa do bug
// "a bonificação do dia 1º de agosto pede pra ser preenchida de novo":
// esta suíte gravava e depois APAGAVA (limparDadosDeTeste) um lançamento na
// unidade real toda vez que rodava. Ver docs do incidente no relatório do
// chat / commit que introduziu a migration 041.
// Rodar: node --env-file=.env --test test/bonificacao-mensal-service.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../src/config/supabase.js";
import { processarImportacaoVisio, obterMes, listarMetas, excluirLancamento } from "../src/modules/bonificacao-mensal/bonificacaoMensal.service.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";

// Fase P0.4: esta suíte exercita um service real; NÃO roda contra produção.
const PULAR_INTEGRACAO = motivoPularIntegracao();

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
// Unidade DE TESTE dedicada (migration 041) — NUNCA a unidade real da Subway
// Saci. O nome contém o token "Saci" de propósito: mesmaUnidadeVisio() exige
// um token distintivo em comum com o "estabelecimento" lido do PDF de
// fixture (que diz "Subway Saci"), então a unidade de teste precisa
// compartilhar esse token para o fluxo de importação validar de verdade.
const SACI_UNIDADE_ID = "00000000-0000-0000-0000-0000000000b1";
// Fase P0.6: antes era um ID fixo capturado em produção (migration 025, que
// usa gen_random_uuid() — não existe num projeto de teste do zero). Agora é
// criada e apagada por este arquivo — mesma organização, nome SEM o token
// "Saci" de propósito (é o que faz processarImportacaoVisio recusar o PDF).
let outraUnidadeId = null;
// Precisa cair dentro da vigência da meta semeada pela migration 041
// (valid_from 2026-08-01) pra evaluateBonusMetric ter meta pra avaliar.
// Como agora é uma unidade isolada (nunca usada por operação real), a data
// em si não precisa mais ser "no futuro" — só precisa bater com a vigência da meta.
const DATA_TESTE = "2026-08-01";
const USUARIO = { id: null, nome: "teste automatizado (bonificacao-mensal-service.test.js)" };

const b64 = (path) => readFileSync(join(FIXTURES, path)).toString("base64");
// Geral = "Relatório de Vendas" (novo layout, auditoria de 15/08/2026 — PDF
// real anexado pelo usuário: Faturamento R$10.655,71, Ticket Médio R$47,57,
// 224 cupons válidos/de vendas, "Subway Teresina Saci"). Loja continua no
// "Relatório de Produtos" de sempre — nada mudou nesse lado.
const payloadCompleto = () => ({
  data: DATA_TESTE,
  geral: { nomeArquivo: "visio-vendas.pdf", conteudoBase64: b64("visio-vendas.pdf") },
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

describe("Migration 041 aplicada — metas seedadas na unidade de teste", { skip: PULAR_INTEGRACAO }, () => {
  test("unidade de teste tem os 11 indicadores cadastrados (réplica da Subway Saci)", async () => {
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

describe("Teste E (ponta a ponta) — relatório de outra unidade é bloqueado", { skip: PULAR_INTEGRACAO }, () => {
  before(async () => {
    const { data, error } = await supabase.from("unidades")
      .insert({ organizacao_id: SACI_ORG_ID, nome: "__TESTE_P06__ Outra Unidade (sem token Saci)", eh_teste: true })
      .select("id").single();
    if (error) throw new Error(`Falha ao criar unidade descartável do Teste E: ${error.message}`);
    outraUnidadeId = data.id;
  });
  after(async () => {
    await limparDadosDeTeste();
    if (outraUnidadeId) await supabase.from("unidades").delete().eq("id", outraUnidadeId);
  });
  test("PDF da Subway Saci enviado com outra unidade selecionada é recusado", async () => {
    await assert.rejects(
      () => processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: outraUnidadeId, usuario: USUARIO, payload: payloadCompleto(), confirmar: false }),
      (err) => { assert.match(err.message, /unidade diferente/i); return true; },
    );
  });
});

describe("Fluxo completo de importação + Teste F (duplicidade)", { skip: PULAR_INTEGRACAO }, () => {
  after(limparDadosDeTeste);

  test("preview não persiste nada", async () => {
    await limparDadosDeTeste();
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: false });
    assert.equal(r.persistido, false);
    assert.equal(r.duplicado, false);
    assert.equal(r.preview.geral.faturamento, 10655.71);
    assert.equal(r.preview.geral.ticketMedio, 47.57);
    assert.equal(r.preview.loja.faturamento, 3893.15);
    const { data: nada } = await supabase.from("bonificacao_lancamentos_diarios").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE).maybeSingle();
    assert.equal(nada, null);
  });

  test("confirmar persiste o lançamento com os valores corretos", async () => {
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r.persistido, true);
    assert.equal(r.lancamento.faturamentoGeral, 10655.71);
    assert.equal(r.lancamento.ticketMedio, 47.57);
    assert.equal(r.lancamento.cuponsValidosGeral, 224);
    assert.equal(r.lancamento.cuponsVendasGeral, 224);
    assert.equal(r.lancamento.ppdGeral, null); // Relatório de Vendas não traz PPD — coluna legada fica vazia
    assert.equal(r.lancamento.faturamentoLoja, 3893.15);
    assert.equal(r.lancamento.qtdSanduichesLoja, 132);
    assert.equal(r.lancamento.qtdBebidasLoja, 56);
    assert.equal(r.lancamento.origem, "visio");
    assert.ok(Math.abs(r.lancamento.mix.bebidas - 42.42) < 0.1);
  });

  test("Teste F — reimportar o mesmo dia sem 'substituir' é bloqueado com valores atuais x novos", async () => {
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: false });
    assert.equal(r.duplicado, true);
    assert.equal(r.existente.faturamentoGeral, 10655.71); // valor atual
    assert.equal(r.preview.geral.faturamento, 10655.71); // valor novo (mesmos PDFs neste teste)
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
    assert.equal(dia.status, "IMPORTADO"); // mesmo sem PPD (Relatório de Vendas não traz) — bug real corrigido em statusDia()
    assert.equal(dia.lancamento.faturamentoGeral, 10655.71);
    // bebidas do mês (só este 1 dia lançado): 56/132 = 42,42% -> faixa >=40% (R$25), abaixo de 45%
    assert.equal(r.indicadores.bebidas.bonusAtual, 25);
    assert.equal(r.indicadores.bebidas.status, "dentro_da_meta");
    // ticket médio ponderado (só este 1 dia): 10655.71 / 224 cupons = 47.57 — bate com o valor que o próprio relatório informou pro dia
    assert.ok(Math.abs(r.indicadores.ticket_medio.valorAtual - 47.57) < 0.01);
  });

  test("correção manual na importação marca manualOverride", async () => {
    const payload = { ...payloadCompleto(), substituir: true, correcoes: { geral: { faturamento: 9999.99 } } };
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload, confirmar: true });
    assert.equal(r.lancamento.faturamentoGeral, 9999.99);
    assert.equal(r.lancamento.manualOverride.faturamento_geral, true);
    assert.equal(r.lancamento.origem, "misto");
  });
});

describe("Teste G — excluir lançamento libera o PDF para reimportação", { skip: PULAR_INTEGRACAO }, () => {
  after(limparDadosDeTeste);

  test("excluir apaga o lançamento, grava o snapshot e libera as importações", async () => {
    await limparDadosDeTeste();
    const r1 = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r1.persistido, true);

    const idsImportacaoAntes = [r1.lancamento.importacaoGeralId, r1.lancamento.importacaoLojaId].filter(Boolean);
    assert.equal(idsImportacaoAntes.length, 2); // geral + loja

    const rExcluir = await excluirLancamento({
      organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
      data: DATA_TESTE, motivo: "teste automatizado — corrigir data errada",
    });
    assert.equal(rExcluir.excluido, true);
    assert.equal(rExcluir.importacoesLiberadas, 2);

    const { data: lancamento } = await supabase.from("bonificacao_lancamentos_diarios")
      .select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE).maybeSingle();
    assert.equal(lancamento, null, "o lançamento deveria ter sido apagado de verdade");

    const { data: importacoesRestantes } = await supabase.from("bonificacao_importacoes")
      .select("id").in("id", idsImportacaoAntes);
    assert.equal((importacoesRestantes ?? []).length, 0, "as importações ligadas ao lançamento deveriam ter sido liberadas");

    const { data: snapshot } = await supabase.from("bonificacao_lancamentos_exclusoes")
      .select("id, motivo, lancamento_snapshot").eq("unidade_id", SACI_UNIDADE_ID).eq("data_lancamento", DATA_TESTE)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    assert.ok(snapshot, "deveria existir um snapshot da exclusão");
    assert.equal(snapshot.motivo, "teste automatizado — corrigir data errada");
    assert.equal(snapshot.lancamento_snapshot.id, r1.lancamento.id); // guardou o registro certo, por inteiro
  });

  test("depois de excluído, o MESMO arquivo pode ser reimportado (era isto que estava bloqueado)", async () => {
    const r2 = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r2.persistido, true);
    assert.equal(r2.lancamento.faturamentoGeral, 10655.71);
  });
});

describe("Teste H — regressão do bug relatado: dia pedia pra ser preenchido de novo", { skip: PULAR_INTEGRACAO }, () => {
  after(limparDadosDeTeste);

  // Reproduz o cenário real: os 2 relatórios (Geral+Loja) ficam registrados
  // em bonificacao_importacoes, mas o processo é interrompido ANTES do
  // upsert em bonificacao_lancamentos_diarios (ex.: erro de rede no meio do
  // caminho) — simulado aqui apagando só o lançamento e mantendo as
  // importações "penduradas" (órfãs), exatamente o estado que ficava depois
  // de uma falha parcial. Sem a correção em gravarImportacao(), reimportar
  // os MESMOS arquivos falhava para sempre com "já foi importado
  // anteriormente" e o dia nunca saía de PENDENTE.
  test("reimportar os mesmos arquivos depois de uma falha parcial se autorrecupera", async () => {
    await limparDadosDeTeste();

    const r1 = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r1.persistido, true);
    const idsImportacao = [r1.lancamento.importacaoGeralId, r1.lancamento.importacaoLojaId].filter(Boolean);
    assert.equal(idsImportacao.length, 2);

    // Simula a falha parcial: apaga só o lançamento diário (via SQL direto,
    // NUNCA via excluirLancamento — essa função libera as importações de
    // propósito; aqui o objetivo é justamente deixá-las órfãs).
    const { error: eDelLinha } = await supabase.from("bonificacao_lancamentos_diarios").delete().eq("id", r1.lancamento.id);
    assert.equal(eDelLinha, null);

    const { data: orfaos } = await supabase.from("bonificacao_importacoes").select("id, status").in("id", idsImportacao);
    assert.equal(orfaos.length, 2, "as importações continuam existindo, agora órfãs (sem lançamento apontando pra elas)");

    const { data: semLancamento } = await supabase.from("bonificacao_lancamentos_diarios").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE).maybeSingle();
    assert.equal(semLancamento, null, "pré-condição: dia sem lançamento, calendário mostraria PENDENTE");

    // Reimporta os MESMOS 2 PDFs, SEM `substituir` — é exatamente o que o
    // usuário faz ao tentar de novo depois de ver o dia "vazio".
    const r2 = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r2.persistido, true, "a reimportação deveria se autorrecuperar, não ficar bloqueada em loop");
    assert.equal(r2.lancamento.faturamentoGeral, 10655.71);

    // As importações órfãs foram REAPROVEITADAS (mesmos ids), não duplicadas.
    assert.equal(r2.lancamento.importacaoGeralId, r1.lancamento.importacaoGeralId);
    assert.equal(r2.lancamento.importacaoLojaId, r1.lancamento.importacaoLojaId);

    const obterMesDepois = await obterMes({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: 2026, mes: 8 });
    const dia = obterMesDepois.calendario.find((d) => d.data === DATA_TESTE);
    assert.equal(dia.status, "IMPORTADO", "o calendário não pode mais mostrar PENDENTE depois da autorrecuperação");
  });

  test("arquivo vinculado a um lançamento de VERDADE em outro dia continua bloqueado (item 20 preservado)", async () => {
    await limparDadosDeTeste();
    // Importa normalmente no dia de teste — fica vinculado a um lançamento real.
    const r = await processarImportacaoVisio({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, payload: payloadCompleto(), confirmar: true });
    assert.equal(r.persistido, true);

    // Tenta importar o MESMO PDF (mesmo hash) para OUTRO dia, sem substituir.
    const outraData = "2026-08-02";
    await assert.rejects(
      () => processarImportacaoVisio({
        organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
        payload: { ...payloadCompleto(), data: outraData }, confirmar: true,
      }),
      (err) => { assert.match(err.message, /já foi importado anteriormente/i); return true; },
    );

    // limpa o segundo dia também (não fica coberto pelo after() desta describe, que só limpa DATA_TESTE)
    await supabase.from("bonificacao_lancamentos_diarios").delete().eq("unidade_id", SACI_UNIDADE_ID).eq("data", outraData);
  });
});
