// Testes do CRUD de metas com vigência (item 76-B) — bonificacaoMensal.service.js#salvarMeta.
// Mesma ressalva das demais suítes: roda contra o Supabase de produção, por
// isso usa SEMPRE a unidade de teste isolada (migration 041), nunca a Subway
// Saci real. Usa o indicador "diversos" pra não colidir com os valores que
// bonificacao-mensal-service.test.js espera pra "bebidas" na mesma unidade.
//
// IMPORTANTE: migration 041 já semeia uma meta de "diversos" nesta unidade
// (pra bater com o teste "11 indicadores cadastrados" de
// bonificacao-mensal-service.test.js) — este arquivo tira um SNAPSHOT dela
// antes de mexer e RESTAURA no final, em vez de só apagar, pra não deixar a
// unidade de teste sem essa meta pras outras suítes que rodarem depois.
// Rodar: node --env-file=.env --test test/bonificacao-mensal-metas-crud.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
// Fase P0.4: esta suite exercita um service real; NAO roda contra producao.
const PULAR_INTEGRACAO = motivoPularIntegracao();
import { supabase } from "../src/config/supabase.js";
import { salvarMeta, listarMetas } from "../src/modules/bonificacao-mensal/bonificacaoMensal.service.js";

const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SACI_UNIDADE_ID = "00000000-0000-0000-0000-0000000000b1"; // unidade de teste (migration 041) — NUNCA a real
const USUARIO = { id: null, nome: "teste automatizado (bonificacao-mensal-metas-crud.test.js)", email: "teste@local" };
const INDICADOR_TESTE = "diversos";

function hojeIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function maisDias(iso, n) {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let snapshot = null; // { meta, faixas } do estado ANTES deste arquivo mexer — ou null se não existia nenhuma

async function limparTudo() {
  const { data: metas } = await supabase.from("bonificacao_metas").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("indicador", INDICADOR_TESTE);
  const ids = (metas || []).map((m) => m.id);
  if (ids.length) {
    await supabase.from("bonificacao_metas_faixas").delete().in("meta_id", ids);
    await supabase.from("bonificacao_metas").delete().in("id", ids);
  }
}

before(async () => {
  const { data: meta } = await supabase.from("bonificacao_metas").select("*")
    .eq("unidade_id", SACI_UNIDADE_ID).eq("indicador", INDICADOR_TESTE).is("valid_until", null).maybeSingle();
  if (!meta) { snapshot = null; return; }
  const { data: faixas } = await supabase.from("bonificacao_metas_faixas").select("*").eq("meta_id", meta.id).order("ordem");
  snapshot = { meta, faixas: faixas || [] };
});

after(async () => {
  await limparTudo();
  if (!snapshot) return;
  const { meta, faixas } = snapshot;
  const { data: nova, error } = await supabase.from("bonificacao_metas").insert({
    organizacao_id: meta.organizacao_id, unidade_id: meta.unidade_id, indicador: meta.indicador,
    direcao: meta.direcao, valid_from: meta.valid_from, valid_until: meta.valid_until, observacao: meta.observacao,
  }).select("id").single();
  if (error) { console.error("[teste] falha ao restaurar snapshot de meta:", error.message); return; }
  if (faixas.length) {
    await supabase.from("bonificacao_metas_faixas").insert(faixas.map((f) => ({
      meta_id: nova.id, ordem: f.ordem, tipo: f.tipo, valor_min: f.valor_min, valor_max: f.valor_max, bonus: f.bonus,
    })));
  }
});

describe("salvarMeta — validação", { skip: PULAR_INTEGRACAO }, () => {
  test("indicador inválido é rejeitado", async () => {
    await assert.rejects(
      () => salvarMeta({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "nao_existe", direcao: "higher_is_better", validFrom: hojeIso(), faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 10, bonus: 20 }] }),
      (err) => { assert.match(err.message, /indicador inválido/i); return true; },
    );
  });

  test("sem faixas é rejeitado", async () => {
    await assert.rejects(
      () => salvarMeta({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: INDICADOR_TESTE, direcao: "higher_is_better", validFrom: hojeIso(), faixas: [] }),
      (err) => { assert.match(err.message, /ao menos uma faixa/i); return true; },
    );
  });

  test("vigência no passado é rejeitada (nunca reescreve histórico)", async () => {
    await assert.rejects(
      () => salvarMeta({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: INDICADOR_TESTE, direcao: "higher_is_better", validFrom: maisDias(hojeIso(), -5), faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 10, bonus: 20 }] }),
      (err) => { assert.match(err.message, /não é possível reescrever|não é possível alterar/i); return true; },
    );
  });
});

describe("salvarMeta — cadastro inicial, edição in-place, nova vigência", { skip: PULAR_INTEGRACAO }, () => {
  test("cadastra a 1ª meta do indicador (parte de uma unidade limpa)", async () => {
    await limparTudo();
    const r = await salvarMeta({
      organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: INDICADOR_TESTE,
      direcao: "higher_is_better", validFrom: hojeIso(),
      faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 20, bonus: 25 }, { ordem: 2, tipo: "limite_minimo", valorMin: 30, bonus: 50 }],
    });
    assert.equal(r.direcao, "higher_is_better");
    assert.equal(r.validUntil, null);
    assert.equal(r.faixas.length, 2);
    assert.equal(r.faixas[1].bonus, 50);
  });

  test("editar com o MESMO validFrom (hoje) faz update in-place — não duplica linha", async () => {
    await salvarMeta({
      organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: INDICADOR_TESTE,
      direcao: "higher_is_better", validFrom: hojeIso(),
      faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 22, bonus: 30 }],
    });
    const { data: linhas } = await supabase.from("bonificacao_metas").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("indicador", INDICADOR_TESTE);
    assert.equal(linhas.length, 1, "continua sendo UMA meta, a edição não criou uma segunda vigência");
    const metas = await listarMetas({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID });
    const m = metas.find((x) => x.indicador === INDICADOR_TESTE);
    assert.equal(m.faixas.length, 1, "as faixas antigas foram substituídas, não acumuladas");
    assert.equal(m.faixas[0].bonus, 30);
  });

  test("nova vigência FUTURA fecha a anterior sem apagar (histórico preservado)", async () => {
    const futura = maisDias(hojeIso(), 30);
    await salvarMeta({
      organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: INDICADOR_TESTE,
      direcao: "higher_is_better", validFrom: futura,
      faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 25, bonus: 40 }],
    });
    const { data: linhas, error } = await supabase.from("bonificacao_metas").select("*").eq("unidade_id", SACI_UNIDADE_ID).eq("indicador", INDICADOR_TESTE).order("valid_from");
    assert.equal(error, null);
    assert.equal(linhas.length, 2, "agora existem DUAS vigências — a antiga fechada + a nova aberta");
    const antiga = linhas[0], nova = linhas[1];
    assert.equal(antiga.valid_from, hojeIso());
    assert.equal(antiga.valid_until, maisDias(futura, -1), "a antiga foi fechada exatamente 1 dia antes da nova começar");
    assert.equal(nova.valid_from, futura);
    assert.equal(nova.valid_until, null);

    // a meta ANTIGA continua com suas faixas intactas — histórico não mudou
    const { data: faixasAntigas } = await supabase.from("bonificacao_metas_faixas").select("*").eq("meta_id", antiga.id);
    assert.equal(faixasAntigas.length, 1);
    assert.equal(Number(faixasAntigas[0].bonus), 30, "a faixa da vigência antiga continua com o valor de quando ela valia");
  });

  test("auditoria registrou a alteração com resumo antes/depois", async () => {
    const { data: aud } = await supabase.from("plataforma_auditoria").select("detalhes")
      .eq("acao", "bonificacao_mensal.meta_alterada").eq("entidade", "bonificacao_meta")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    assert.ok(aud, "deveria existir um registro de auditoria");
    assert.match(aud.detalhes.resumo, /alterada de .* para .*vigente a partir de/i);
  });
});
