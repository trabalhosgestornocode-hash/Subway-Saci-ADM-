// Testes do REV mensal (migration 052). Cenários de duplicidade (1 registro
// por unidade+mês+ano) e de isolamento entre organizações. Roda contra o
// Supabase real, sempre na
// unidade de teste isolada (migration 041) — nunca a Subway Saci real.
// Rodar: node --env-file=.env --test test/bonificacao-mensal-rev-mensal.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { obterRevMensal, salvarRevMensal, obterMes } from "../src/modules/bonificacao-mensal/bonificacaoMensal.service.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";

// Fase P0.4: NÃO roda contra produção. Só roda apontado a um Supabase de teste.
const PULAR_INTEGRACAO = motivoPularIntegracao();

const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SACI_UNIDADE_ID = "00000000-0000-0000-0000-0000000000b1"; // unidade de teste (migration 041)
// Fase P0.6: antes eram IDs fixos capturados em produção (Empresa Base) — não
// existem num projeto de teste do zero. Agora esta suíte cria e apaga sua
// própria organização+unidade descartáveis, só para o teste de isolamento
// entre tenants (Cenário 7); nunca escreve nelas de outra forma.
let outraOrgId = null;
let outraUnidadeId = null;
const USUARIO = { id: null, nome: "teste automatizado (bonificacao-mensal-rev-mensal.test.js)", email: "teste@local" };
// Competência isolada — não colide com nenhuma outra suíte nesta unidade.
const ANO = 2031, MES = 3;

async function limpar() {
  await supabase.from("bonificacao_rev_mensal").delete().eq("unidade_id", SACI_UNIDADE_ID).eq("ano", ANO).eq("mes", MES);
}

describe("REV mensal — 1 registro por unidade+mês+ano (item 2 do pedido)", { skip: PULAR_INTEGRACAO }, () => {
  after(limpar);

  test("sem lançamento ainda -> obterRevMensal devolve null (nunca 0)", async () => {
    await limpar();
    const r = await obterRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: ANO, mes: MES });
    assert.equal(r, null);
  });

  test("lança o REV do mês", async () => {
    const r = await salvarRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, ano: ANO, mes: MES, valor: 86 });
    assert.equal(r.valor, 86);
  });

  test("Cenário 6 — relançar o MESMO mês atualiza (upsert), nunca cria um 2º registro", async () => {
    const r = await salvarRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, ano: ANO, mes: MES, valor: 91 });
    assert.equal(r.valor, 91);

    const { data: linhas, error } = await supabase.from("bonificacao_rev_mensal")
      .select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("ano", ANO).eq("mes", MES);
    assert.equal(error, null);
    assert.equal(linhas.length, 1, "continua sendo UM registro pra unidade+mês+ano, não duplicou");
  });

  test("a constraint do banco também recusa 2 linhas pro mesmo unidade+ano+mês (insert direto, sem upsert)", async () => {
    const { error } = await supabase.from("bonificacao_rev_mensal").insert({
      organizacao_id: SACI_ORG_ID, unidade_id: SACI_UNIDADE_ID, ano: ANO, mes: MES, valor: 70,
    });
    assert.ok(error, "deveria falhar por violar a unique constraint (unidade_id, ano, mes)");
    assert.match(String(error.message || error.code), /duplicate|unique|23505/i);
  });

  test("valor negativo é rejeitado", async () => {
    await assert.rejects(
      () => salvarRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, ano: ANO, mes: MES, valor: -5 }),
      (err) => { assert.match(err.message, /não pode ser negativo/i); return true; },
    );
  });

  test("mês/ano inválidos são rejeitados", async () => {
    await assert.rejects(
      () => salvarRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, ano: ANO, mes: 13, valor: 80 }),
      (err) => { assert.match(err.message, /mês/i); return true; },
    );
  });

  test("obterMes reflete o REV mensal em revMensal e no indicador 'rev'", async () => {
    const r = await obterMes({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: ANO, mes: MES });
    assert.equal(r.revMensal.valor, 91);
    assert.equal(r.indicadores.rev.valorAtual, 91);
  });
});

describe("Cenário 7 — isolamento entre organizações", { skip: PULAR_INTEGRACAO }, () => {
  before(async () => {
    const { data: org, error: eOrg } = await supabase.from("organizacoes")
      .insert({ nome: "__TESTE_P06__ Org descartável (rev-mensal isolamento)", status: "teste" })
      .select("id").single();
    if (eOrg) throw new Error(`Falha ao criar organização descartável: ${eOrg.message}`);
    outraOrgId = org.id;

    const { data: un, error: eUn } = await supabase.from("unidades")
      .insert({ organizacao_id: outraOrgId, nome: "__TESTE_P06__ Unidade descartável (rev-mensal isolamento)", eh_teste: true })
      .select("id").single();
    if (eUn) throw new Error(`Falha ao criar unidade descartável: ${eUn.message}`);
    outraUnidadeId = un.id;
  });
  after(async () => {
    if (outraOrgId) await supabase.from("organizacoes").delete().eq("id", outraOrgId); // cascade cuida da unidade
  });

  test("não é possível ler/escrever REV de uma unidade de outra organização", async () => {
    await assert.rejects(
      () => obterRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: outraUnidadeId, ano: ANO, mes: MES }),
      (err) => { assert.match(err.message, /acesso/i); return true; },
    );
    await assert.rejects(
      () => salvarRevMensal({ organizacaoId: SACI_ORG_ID, unidadeId: outraUnidadeId, usuario: USUARIO, ano: ANO, mes: MES, valor: 90 }),
      (err) => { assert.match(err.message, /acesso/i); return true; },
    );
  });

  test("a organização dona da unidade consegue ler normalmente (controle: o bloqueio acima é por tenant, não um bug geral)", async () => {
    const r = await obterRevMensal({ organizacaoId: outraOrgId, unidadeId: outraUnidadeId, ano: ANO, mes: MES });
    assert.equal(r, null); // sem dado lançado — mas a CHAMADA em si não é recusada
  });
});
