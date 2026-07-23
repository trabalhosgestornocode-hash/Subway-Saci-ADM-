// Testes do serviço de sincronização com repositório FALSO em memória.
// Sem Supabase, sem rede — roda no CI sem nenhuma variável de ambiente.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const CATALOGO = JSON.parse(readFileSync(join(aqui, "fixtures/martinbrower/load-itens.json"), "utf8"));

import { processarCatalogo } from "../src/modules/martinbrower/martinbrower.sync.service.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const UNI_A1 = "aaaaaaaa-1111-1111-1111-111111111111";
const UNI_A2 = "aaaaaaaa-2222-2222-2222-222222222222";

// Repositório em memória que IMPÕE o mesmo isolamento do real: toda linha
// carrega tenant e nenhuma consulta enxerga fora do próprio escopo.
function criarRepoFalso(preexistentes = []) {
  const produtos = preexistentes.map((p, i) => ({ id: `prod-${i}`, ...p }));
  const historico = [];
  let seq = produtos.length;

  return {
    produtos, historico,
    async listarFiltros() { return []; },
    async mapearProdutosExistentes({ organizacaoId, unidadeId, clientId }) {
      return new Map(produtos
        .filter((p) => p.organizacao_id === organizacaoId && p.unidade_id === unidadeId && p.client_id === clientId)
        .map((p) => [p.codigo, p]));
    },
    async upsertProdutos({ organizacaoId, unidadeId, linhas }) {
      const salvos = [];
      for (const l of linhas) {
        assert.equal(l.organizacao_id, organizacaoId, "linha com organização divergente");
        assert.equal(l.unidade_id, unidadeId, "linha com unidade divergente");
        const i = produtos.findIndex((p) =>
          p.organizacao_id === l.organizacao_id && p.unidade_id === l.unidade_id &&
          p.client_id === l.client_id && p.codigo === l.codigo);
        if (i >= 0) { produtos[i] = { ...produtos[i], ...l }; salvos.push({ id: produtos[i].id, codigo: l.codigo, preco: l.preco }); }
        else { const novo = { id: `prod-${seq++}`, ...l }; produtos.push(novo); salvos.push({ id: novo.id, codigo: l.codigo, preco: l.preco }); }
      }
      return { salvos, erros: [] };
    },
    async inserirHistoricoPrecos({ registros }) { historico.push(...registros); return registros; },
    async marcarNaoVistos({ organizacaoId, unidadeId, clientId, codigosVistos }) {
      const vistos = new Set(codigosVistos);
      for (const p of produtos) {
        if (p.organizacao_id === organizacaoId && p.unidade_id === unidadeId && p.client_id === clientId && !vistos.has(p.codigo)) {
          p.visto_na_ultima_sincronizacao = false;
        }
      }
      return [];
    },
  };
}

async function comRepo(repoFalso, fn) {
  // Injeção de dependência: o serviço aceita o repositório, então o teste
  // roda sem Supabase e sem APIs experimentais de mock de módulo.
  return fn((args) => processarCatalogo({ ...args, repo: repoFalso }));
}

const base = { organizacaoId: ORG_A, unidadeId: UNI_A1, clientId: "4532", orderId: 612694, payload: CATALOGO };

// --- contagens ------------------------------------------------------------

test("catálogo novo: tudo criado, nada atualizado, nenhum histórico", async () => {
  const repo = criarRepoFalso();
  await comRepo(repo, async (processar) => {
    const r = await processar({ ...base, sincronizacaoId: "sync-1" });
    assert.equal(r.produtosEncontrados, 10);
    assert.equal(r.produtosValidos, 4);
    assert.equal(r.produtosIgnorados, 2);
    assert.equal(r.produtosCriados, 6);
    assert.equal(r.produtosAtualizados, 0);
    // Produto novo NÃO conta como preço alterado: é a linha de base.
    assert.equal(r.precosAlterados, 0);
    assert.equal(repo.historico.length, 0);
    assert.equal(r.produtosComErro, 4); // os 4 itens rejeitados da fixture
  });
});

test("produto existente com MESMO preço não gera histórico", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532",
    codigo: "1001088", preco: 486.01, primeira_sincronizacao: "2026-01-01T00:00:00.000Z",
  }]);
  await comRepo(repo, async (processar) => {
    const r = await processar({ ...base, sincronizacaoId: "sync-2" });
    assert.equal(r.produtosAtualizados, 1);
    assert.equal(r.precosAlterados, 0);
    assert.equal(repo.historico.length, 0);
  });
});

test("mudança de preço gera UM registro com valor e percentual corretos", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532",
    codigo: "1001088", preco: 400.00, primeira_sincronizacao: "2026-01-01T00:00:00.000Z",
  }]);
  await comRepo(repo, async (processar) => {
    const r = await processar({ ...base, sincronizacaoId: "sync-3" });
    assert.equal(r.precosAlterados, 1);
    assert.equal(repo.historico.length, 1);

    const h = repo.historico[0];
    assert.equal(h.codigo, "1001088");
    assert.equal(h.preco_anterior, 400);
    assert.equal(h.preco_novo, 486.01);
    assert.equal(h.alteracao_valor, 86.01);
    assert.equal(h.alteracao_percentual, 21.5025);
    assert.equal(h.sincronizacao_id, "sync-3");
    assert.equal(h.organizacao_id, ORG_A);
    assert.equal(h.unidade_id, UNI_A1);
  });
});

test("queda de preço registra valor e percentual negativos", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532", codigo: "1001088", preco: 500,
  }]);
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s" });
    const h = repo.historico[0];
    assert.equal(h.alteracao_valor, -13.99);
    assert.ok(h.alteracao_percentual < 0);
  });
});

test("diferença abaixo do centavo não conta como mudança", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532", codigo: "1001088", preco: 486.009999,
  }]);
  await comRepo(repo, async (processar) => {
    const r = await processar({ ...base, sincronizacaoId: "s" });
    assert.equal(r.precosAlterados, 0);
  });
});

test("item sem preço não gera histórico nem quebra a sincronização", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532", codigo: "0002046", preco: 30,
  }]);
  await comRepo(repo, async (processar) => {
    const r = await processar({ ...base, sincronizacaoId: "s" });
    assert.equal(repo.historico.filter((h) => h.codigo === "0002046").length, 0);
    assert.ok(r.produtosValidos > 0);
  });
});

// --- persistência ---------------------------------------------------------

test("primeira_sincronizacao é preservada; ultima_sincronizacao avança", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532", codigo: "1001088",
    preco: 486.01, primeira_sincronizacao: "2026-01-01T00:00:00.000Z",
  }]);
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s" });
    const p = repo.produtos.find((x) => x.codigo === "1001088");
    assert.equal(p.primeira_sincronizacao, "2026-01-01T00:00:00.000Z");
    assert.ok(new Date(p.ultima_sincronizacao) > new Date("2026-01-01"));
  });
});

test("produto não duplica ao sincronizar duas vezes", async () => {
  const repo = criarRepoFalso();
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s1" });
    const depois1 = repo.produtos.length;
    await processar({ ...base, sincronizacaoId: "s2" });
    assert.equal(repo.produtos.length, depois1);
  });
});

test("produto que sumiu do catálogo é sinalizado, NUNCA excluído", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532",
    codigo: "8888888", descricao: "PRODUTO DESCONTINUADO", preco: 10,
    visto_na_ultima_sincronizacao: true,
  }]);
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s" });
    const sumido = repo.produtos.find((p) => p.codigo === "8888888");
    assert.ok(sumido, "produto ausente NÃO pode ser excluído");
    assert.equal(sumido.visto_na_ultima_sincronizacao, false);
  });
});

test("classificação manual do administrador vence o filtro automático", async () => {
  const repo = criarRepoFalso([{
    organizacao_id: ORG_A, unidade_id: UNI_A1, client_id: "4532",
    codigo: "5000102", preco: 41.9, ignorado: false, classificacao_manual: true,
  }]);
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s" });
    // O avental seria ignorado pela regra padrão, mas o admin decidiu incluir.
    assert.equal(repo.produtos.find((p) => p.codigo === "5000102").ignorado, false);
  });
});

// --- isolamento multiempresa ---------------------------------------------

test("sincronizar a unidade A1 não toca nos produtos da A2 nem da ORG_B", async () => {
  const repo = criarRepoFalso([
    { organizacao_id: ORG_A, unidade_id: UNI_A2, client_id: "7777", codigo: "1001088", preco: 100 },
    { organizacao_id: ORG_B, unidade_id: "bbbbbbbb-1111-1111-1111-111111111111", client_id: "4532", codigo: "1001088", preco: 200 },
  ]);
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s" });

    // Os produtos das outras lojas ficaram intactos, com o preço original.
    assert.equal(repo.produtos.find((p) => p.unidade_id === UNI_A2).preco, 100);
    assert.equal(repo.produtos.find((p) => p.organizacao_id === ORG_B).preco, 200);
    // E nenhum histórico foi criado para elas.
    assert.equal(repo.historico.filter((h) => h.unidade_id !== UNI_A1).length, 0);
    // O catálogo de A1 nasceu do zero: mesmo código, linha separada.
    assert.equal(repo.produtos.filter((p) => p.codigo === "1001088").length, 3);
  });
});

test("toda linha gravada carrega organizacao_id, unidade_id e client_id", async () => {
  const repo = criarRepoFalso();
  await comRepo(repo, async (processar) => {
    await processar({ ...base, sincronizacaoId: "s" });
    for (const p of repo.produtos) {
      assert.equal(p.organizacao_id, ORG_A);
      assert.equal(p.unidade_id, UNI_A1);
      assert.equal(p.client_id, "4532");
      assert.equal(typeof p.client_id, "string", "client_id gravado precisa ser string (migration 019)");
    }
    for (const h of repo.historico) {
      assert.equal(h.organizacao_id, ORG_A);
      assert.equal(h.unidade_id, UNI_A1);
    }
  });
});

// --- robustez -------------------------------------------------------------

test("erro ao gravar um produto não cancela o catálogo inteiro", async () => {
  const repo = criarRepoFalso();
  const original = repo.upsertProdutos;
  repo.upsertProdutos = async (args) => {
    const r = await original.call(repo, args);
    return { salvos: r.salvos.slice(1), erros: [{ codigo: r.salvos[0].codigo, motivo: "conflito simulado" }] };
  };
  await comRepo(repo, async (processar) => {
    const r = await processar({ ...base, sincronizacaoId: "s" });
    assert.equal(r.errosGravacao.length, 1);
    assert.ok(r.produtosComErro >= 1);
    assert.ok(repo.produtos.length >= 5, "o resto do catálogo foi gravado");
  });
});

test("catálogo vazio é rejeitado como CATALOG_INVALID", async () => {
  await comRepo(criarRepoFalso(), async (processar) => {
    await assert.rejects(
      () => processar({ ...base, payload: { data: { groups: [] } }, sincronizacaoId: "s" }),
      (e) => e.codigo === "MARTIN_BROWER_CATALOG_INVALID");
  });
});

test("o progresso é reportado nas etapas esperadas", async () => {
  const etapas = [];
  await comRepo(criarRepoFalso(), async (processar) => {
    await processar({ ...base, sincronizacaoId: "s", aoProgredir: (e) => etapas.push(e) });
  });
  assert.deepEqual(etapas, [
    "Normalizando produtos", "Filtrando itens ignorados",
    "Comparando preços", "Atualizando banco", "Finalizando sincronização",
  ]);
});
