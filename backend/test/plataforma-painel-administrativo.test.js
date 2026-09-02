// Fase C — Gestão de acesso ao PAINEL ADMINISTRATIVO pelo SuperAdmin.
//
// Escopo: lógica de negócio + injeção de um Supabase FAKE (mesmo padrão de
// usuarios-listar-vinculos.test.js). Nenhuma escrita real, nenhuma migration
// aplicada — os testes rodam sobre o schema PREVISTO na migration 061.
//
// Rodar: node --env-file-if-exists=.env --test test/plataforma-painel-administrativo.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { requireSuperadmin } from "../src/middlewares/auth.js";
import { ACOES } from "../src/shared/auditoria.js";
import {
  planejarMudancaPainelAdministrativo,
  definirPainelAdministrativo,
  listarUsuariosPainelAdministrativo,
  listarUsuarios,
  obterUsuario,
} from "../src/modules/plataforma/plataforma.usuarios.service.js";

// ---------------------------------------------------------------------------
// Supabase FAKE — chainable, registra toda tabela tocada e toda escrita.
// ---------------------------------------------------------------------------
function fakeSupabase(estado = {}) {
  const tabelasTocadas = [];
  const escritas = [];

  function from(tabela) {
    tabelasTocadas.push(tabela);
    const ctx = { tabela, eq: {}, inFiltro: null, single: false };
    const linhas = () => (estado[tabela] ?? []).filter((l) => {
      const okEq = Object.entries(ctx.eq).every(([k, val]) => l[k] === val);
      const okIn = !ctx.inFiltro || ctx.inFiltro.valores.includes(l[ctx.inFiltro.col]);
      return okEq && okIn;
    });
    const resolverLista = () => Promise.resolve({ data: linhas(), error: null });
    const resolverSingle = () => Promise.resolve({ data: linhas()[0] ?? null, error: null });

    const builder = {
      select() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      or() { return builder; },
      is() { return builder; },
      gte() { return builder; },
      eq(k, val) { ctx.eq[k] = val; return builder; },
      in(k, arr) { ctx.inFiltro = { col: k, valores: arr }; return builder; },
      maybeSingle() { ctx.single = true; return { then: (res, rej) => resolverSingle().then(res, rej) }; },
      single() { ctx.single = true; return { then: (res, rej) => resolverSingle().then(res, rej) }; },
      upsert(obj) { escritas.push({ op: "upsert", tabela, obj }); return Promise.resolve({ error: null }); },
      update(obj) {
        const alvo = { op: "update", tabela, obj, eq: ctx.eq };
        escritas.push(alvo);
        return { eq(k, val) { alvo.eq = { ...alvo.eq, [k]: val }; return Promise.resolve({ error: null }); } };
      },
      then(res, rej) { return (ctx.single ? resolverSingle() : resolverLista()).then(res, rej); },
    };
    return builder;
  }

  return {
    from,
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
    _tabelasTocadas: tabelasTocadas,
    _escritas: escritas,
  };
}

// UUIDs válidos (v.uuid rejeita qualquer coisa que não seja UUID).
const SA = "5a000000-0000-4000-8000-000000000001";
const U1 = "10000000-0000-4000-8000-000000000001";
const U2 = "20000000-0000-4000-8000-000000000002";
const U3 = "30000000-0000-4000-8000-000000000003";
const U9 = "90000000-0000-4000-8000-000000000009";

const req = (over = {}) => ({
  user: { id: SA, email: "sa@crescer.com", superadmin: true, ...over.user },
  headers: {}, socket: {}, header: () => null, ...over,
});

const auditSpy = () => {
  const chamadas = [];
  return { fn: async (e) => { chamadas.push(e); }, chamadas: () => chamadas };
};

// ===========================================================================
// 1-3. Só o SuperAdmin administra o acesso (a rota vive no plataformaRouter)
// ===========================================================================
describe("autorização — só SuperAdmin administra o acesso ao Painel Administrativo", () => {
  const passa = (user) => {
    let erro = null;
    requireSuperadmin({ user }, {}, (e) => { erro = e ?? null; });
    return erro;
  };

  test("usuário comum -> 403", () => {
    assert.equal(passa({ id: "u", superadmin: false, painelAdministrativo: false }).statusCode, 403);
  });

  test("usuário que SÓ tem painelAdministrativo=true -> 403 (monitorar ≠ administrar acessos)", () => {
    assert.equal(passa({ id: "u", superadmin: false, painelAdministrativo: true }).statusCode, 403);
  });

  test("SuperAdmin -> passa", () => {
    assert.equal(passa({ id: "sa", superadmin: true }), null);
  });
});

// ===========================================================================
// planejarMudancaPainelAdministrativo (PURO) — idempotência e reativação
// ===========================================================================
describe("planejarMudancaPainelAdministrativo (puro)", () => {
  test("conceder sem registro -> inserir, alterado", () => {
    assert.deepEqual(planejarMudancaPainelAdministrativo({ registroAtual: null, conceder: true }),
      { alterado: true, operacao: "inserir", estadoAnterior: false, estadoNovo: true });
  });
  test("conceder com registro ativo -> nenhuma (idempotente)", () => {
    assert.deepEqual(planejarMudancaPainelAdministrativo({ registroAtual: { ativo: true }, conceder: true }),
      { alterado: false, operacao: "nenhuma", estadoAnterior: true, estadoNovo: true });
  });
  test("conceder com registro revogado -> reativar", () => {
    assert.deepEqual(planejarMudancaPainelAdministrativo({ registroAtual: { ativo: false }, conceder: true }),
      { alterado: true, operacao: "reativar", estadoAnterior: false, estadoNovo: true });
  });
  test("revogar com registro ativo -> revogar", () => {
    assert.deepEqual(planejarMudancaPainelAdministrativo({ registroAtual: { ativo: true }, conceder: false }),
      { alterado: true, operacao: "revogar", estadoAnterior: true, estadoNovo: false });
  });
  test("revogar sem registro -> nenhuma (idempotente)", () => {
    assert.deepEqual(planejarMudancaPainelAdministrativo({ registroAtual: null, conceder: false }),
      { alterado: false, operacao: "nenhuma", estadoAnterior: false, estadoNovo: false });
  });
  test("revogar com registro já revogado -> nenhuma (idempotente)", () => {
    assert.deepEqual(planejarMudancaPainelAdministrativo({ registroAtual: { ativo: false }, conceder: false }),
      { alterado: false, operacao: "nenhuma", estadoAnterior: false, estadoNovo: false });
  });
});

// ===========================================================================
// definirPainelAdministrativo — comportamento + auditoria + isolamento
// ===========================================================================
describe("definirPainelAdministrativo", () => {
  const perfil = { id: U1, nome: "Fulano", email: "fulano@x.com" };

  test("4. conceder sem registro -> upsert com ativo=true e criado_por = ator", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [] });
    const spy = auditSpy();
    const r = await definirPainelAdministrativo(req(), U1, { conceder: true }, { db, registrar: spy.fn });
    assert.deepEqual(r, { id: U1, painelAdministrativo: true, alterado: true });
    assert.equal(db._escritas.length, 1);
    assert.equal(db._escritas[0].op, "upsert");
    assert.equal(db._escritas[0].obj.ativo, true);
    assert.equal(db._escritas[0].obj.criado_por, SA);
    assert.equal(spy.chamadas().length, 1);
    assert.equal(spy.chamadas()[0].acao, ACOES.PAINEL_ADM_CONCEDIDO);
  });

  test("5. conceder DUAS vezes -> idempotente: não escreve nem audita na 2ª", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [{ usuario_id: U1, ativo: true }] });
    const spy = auditSpy();
    const r = await definirPainelAdministrativo(req(), U1, { conceder: true }, { db, registrar: spy.fn });
    assert.deepEqual(r, { id: U1, painelAdministrativo: true, alterado: false });
    assert.equal(db._escritas.length, 0);
    assert.equal(spy.chamadas().length, 0);
  });

  test("6. revogar -> update ativo=false + auditoria PAINEL_ADM_REVOGADO", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [{ usuario_id: U1, ativo: true }] });
    const spy = auditSpy();
    const r = await definirPainelAdministrativo(req(), U1, { conceder: false }, { db, registrar: spy.fn });
    assert.deepEqual(r, { id: U1, painelAdministrativo: false, alterado: true });
    assert.equal(db._escritas[0].op, "update");
    assert.equal(db._escritas[0].obj.ativo, false);
    assert.equal(spy.chamadas()[0].acao, ACOES.PAINEL_ADM_REVOGADO);
  });

  test("7. revogar DUAS vezes -> idempotente", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [{ usuario_id: U1, ativo: false }] });
    const spy = auditSpy();
    const r = await definirPainelAdministrativo(req(), U1, { conceder: false }, { db, registrar: spy.fn });
    assert.equal(r.alterado, false);
    assert.equal(db._escritas.length, 0);
    assert.equal(spy.chamadas().length, 0);
  });

  test("8. conceder após revogação -> reativa (operacao=reativar), escreve e audita", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [{ usuario_id: U1, ativo: false }] });
    const spy = auditSpy();
    const r = await definirPainelAdministrativo(req(), U1, { conceder: true }, { db, registrar: spy.fn });
    assert.equal(r.alterado, true);
    assert.equal(db._escritas[0].op, "upsert");
    assert.equal(db._escritas[0].obj.ativo, true);
    assert.equal(spy.chamadas()[0].detalhes.operacao, "reativar");
  });

  test("9. NÃO toca plataforma_admins / usuarios_organizacoes / usuarios_unidades", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [] });
    await definirPainelAdministrativo(req(), U1, { conceder: true }, { db, registrar: auditSpy().fn });
    const proibidas = ["plataforma_admins", "usuarios_organizacoes", "usuarios_unidades", "sessoes_contexto"];
    for (const t of proibidas) {
      assert.ok(!db._tabelasTocadas.includes(t), `nunca deveria consultar/escrever em ${t}`);
    }
    assert.deepEqual([...new Set(db._tabelasTocadas)].sort(), ["painel_administrativo_usuarios", "perfis"]);
  });

  test("13/14. auditoria só em mudança real; detalhes carregam estado anterior e novo", async () => {
    const db = fakeSupabase({ perfis: [perfil], painel_administrativo_usuarios: [] });
    const spy = auditSpy();
    await definirPainelAdministrativo(req(), U1, { conceder: true, observacao: "dono Crescer 2" }, { db, registrar: spy.fn });
    const e = spy.chamadas()[0];
    assert.equal(e.atorTipo, "superadmin");
    assert.equal(e.entidade, "usuario");
    assert.equal(e.entidadeId, U1);
    assert.equal(e.detalhes.estadoAnterior, "sem_acesso");
    assert.equal(e.detalhes.estadoNovo, "com_acesso");
    assert.equal(e.detalhes.observacao, "dono Crescer 2");
  });

  test("usuário inexistente -> 404, sem escrita nem auditoria", async () => {
    const db = fakeSupabase({ perfis: [], painel_administrativo_usuarios: [] });
    const spy = auditSpy();
    await assert.rejects(() => definirPainelAdministrativo(req(), U9, { conceder: true }, { db, registrar: spy.fn }),
      /não encontrado/i);
    assert.equal(db._escritas.length, 0);
    assert.equal(spy.chamadas().length, 0);
  });
});

// ===========================================================================
// 12. Listagem de quem tem acesso
// ===========================================================================
describe("listarUsuariosPainelAdministrativo", () => {
  const estado = () => ({
    painel_administrativo_usuarios: [
      { usuario_id: U1, ativo: true, observacao: "ok", created_at: "2026-01-01", updated_at: "2026-01-01" },
      { usuario_id: U2, ativo: true, observacao: null, created_at: "2026-02-01", updated_at: "2026-02-01" },
      { usuario_id: U3, ativo: false, observacao: "saiu", created_at: "2026-03-01", updated_at: "2026-04-01" },
    ],
    perfis: [
      { id: U1, nome: "João", email: "joao@x.com", ativo: true },
      { id: U2, nome: "Maria", email: "maria@x.com", ativo: true },
      { id: U3, nome: "Carlos", email: "carlos@x.com", ativo: true },
    ],
  });

  test("padrão -> só ativos, com nome/email vindos de perfis", async () => {
    const r = await listarUsuariosPainelAdministrativo({}, { db: fakeSupabase(estado()) });
    assert.equal(r.status, "ativos");
    assert.equal(r.total, 2);
    assert.deepEqual(r.usuarios.map((u) => u.id).sort(), [U1, U2]);
    assert.equal(r.usuarios[0].nome, "João");
    assert.equal(r.usuarios[0].acessoAtivo, true);
  });

  test("status=revogados -> só os revogados", async () => {
    const r = await listarUsuariosPainelAdministrativo({ status: "revogados" }, { db: fakeSupabase(estado()) });
    assert.deepEqual(r.usuarios.map((u) => u.id), [U3]);
    assert.equal(r.usuarios[0].acessoAtivo, false);
  });

  test("status=todos -> ativos e revogados", async () => {
    const r = await listarUsuariosPainelAdministrativo({ status: "todos" }, { db: fakeSupabase(estado()) });
    assert.equal(r.total, 3);
  });

  test("status inválido -> cai no padrão 'ativos', nunca lança", async () => {
    const r = await listarUsuariosPainelAdministrativo({ status: "hackzor" }, { db: fakeSupabase(estado()) });
    assert.equal(r.status, "ativos");
  });

  test("vazio -> lista vazia, nunca lança", async () => {
    const r = await listarUsuariosPainelAdministrativo({}, { db: fakeSupabase({ painel_administrativo_usuarios: [], perfis: [] }) });
    assert.deepEqual(r, { status: "ativos", usuarios: [], total: 0 });
  });
});

// ===========================================================================
// 10-11. listarUsuarios / obterUsuario expõem painelAdministrativo
// ===========================================================================
describe("listarUsuarios / obterUsuario expõem o flag painelAdministrativo", () => {
  const estado = () => ({
    perfis: [
      { id: U1, nome: "Com acesso", email: "a@x.com", ativo: true, created_at: "2026-01-01" },
      { id: U2, nome: "Sem acesso", email: "b@x.com", ativo: true, created_at: "2026-01-02" },
    ],
    painel_administrativo_usuarios: [
      { usuario_id: U1, ativo: true, observacao: "dono Crescer", created_at: "2026-01-05", updated_at: "2026-01-05" },
    ],
    plataforma_admins: [],
    usuarios_organizacoes: [],
    usuarios_unidades: [],
    sessoes_contexto: [],
    plataforma_auditoria: [],
  });

  test("10. listarUsuarios: painelAdministrativo=true só para quem tem registro ativo", async () => {
    const lista = await listarUsuarios({}, { db: fakeSupabase(estado()) });
    const porId = Object.fromEntries(lista.map((u) => [u.id, u]));
    assert.equal(porId[U1].painelAdministrativo, true);
    assert.equal(porId[U2].painelAdministrativo, false);
    // não confundiu com superadmin
    assert.equal(porId[U1].superadmin, false);
  });

  test("11. obterUsuario: expõe painelAdministrativo + observação + desde", async () => {
    const u1 = await obterUsuario(U1, { db: fakeSupabase(estado()) });
    assert.equal(u1.painelAdministrativo, true);
    assert.equal(u1.observacaoPainelAdministrativo, "dono Crescer");
    assert.equal(u1.painelAdministrativoDesde, "2026-01-05");
    assert.equal(u1.superadmin, false);

    const u2 = await obterUsuario(U2, { db: fakeSupabase(estado()) });
    assert.equal(u2.painelAdministrativo, false);
    assert.equal(u2.observacaoPainelAdministrativo, null);
  });
});
