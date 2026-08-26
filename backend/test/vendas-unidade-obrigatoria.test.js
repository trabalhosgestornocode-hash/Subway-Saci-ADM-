// Fase F (regressão/estabilização): Vendas (SWFast) é 100% escopado por
// unidade — cada uma das 9 funções abaixo tinha, antes desta fase, um
// `.eq("unidade_id", unidadeId)` sem nenhuma guarda: no contexto "Todas as
// unidades" (unidadeId null), a tela aparecia silenciosamente vazia em vez
// de dizer que precisa escolher uma unidade (achado real da Fase F).
//
// Este teste prova a guarda `exigirUnidade()` sem tocar em REDE/banco: a
// checagem é a PRIMEIRA linha de cada função — com unidadeId ausente, a
// promise rejeita antes de qualquer `supabase.from(...)` ser chamado (por
// isso roda em milissegundos, sem round-trip nenhum). Precisa só das
// variáveis de ambiente PRESENTES (`.env`, mesmo padrão de `npm test`) pra
// `config/supabase.js` importar sem abortar — não precisa delas serem
// válidas nem de TEST_SUPABASE_* (esse é só para os testes de integração
// contra um projeto real, ver isolamento-tenant.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processarImportacaoVendas, arquivoOriginal, visaoGeral, listarFaturamento,
  listarProdutosVendidos, listarImportacoes, excluirImportacao, listarDivergencias,
  resolverDivergencia, vincularProduto, vincularLote,
} from "../src/modules/vendas/vendas.service.js";

const MSG = "Selecione uma unidade para acessar o módulo Vendas.";

/** @param {Promise<unknown>} promessa */
async function esperaRecusaPorFaltaDeUnidade(promessa) {
  await assert.rejects(promessa, (erro) => {
    assert.equal(erro.statusCode, 400, `esperava 400 (badRequest), recebeu ${erro.statusCode}`);
    assert.equal(erro.message, MSG);
    return true;
  });
}

test("Vendas: as 9 funções escopadas por unidade recusam unidadeId ausente/null", async () => {
  await esperaRecusaPorFaltaDeUnidade(processarImportacaoVendas({ organizacaoId: "org1", unidadeId: null, payload: { produtos: {} } }));
  await esperaRecusaPorFaltaDeUnidade(arquivoOriginal({ unidadeId: null, importacaoId: "imp1" }));
  await esperaRecusaPorFaltaDeUnidade(visaoGeral({ unidadeId: null, filtros: {} }));
  await esperaRecusaPorFaltaDeUnidade(listarFaturamento({ unidadeId: null, filtros: {} }));
  await esperaRecusaPorFaltaDeUnidade(listarProdutosVendidos({ unidadeId: null, filtros: {} }));
  await esperaRecusaPorFaltaDeUnidade(listarImportacoes({ unidadeId: null }));
  await esperaRecusaPorFaltaDeUnidade(excluirImportacao({ unidadeId: null, importacaoId: "imp1" }));
  await esperaRecusaPorFaltaDeUnidade(listarDivergencias({ unidadeId: null }));
  await esperaRecusaPorFaltaDeUnidade(resolverDivergencia({ unidadeId: null, divergenciaId: "d1" }));
  await esperaRecusaPorFaltaDeUnidade(vincularProduto({ organizacaoId: "org1", unidadeId: null, codigoSw: "101" }));
  await esperaRecusaPorFaltaDeUnidade(vincularLote({ organizacaoId: "org1", unidadeId: null, itens: [{ codigoSw: "101" }] }));
});

test("Vendas: unidadeId undefined também é recusado (não só null explícito)", async () => {
  await esperaRecusaPorFaltaDeUnidade(visaoGeral({ filtros: {} }));
  await esperaRecusaPorFaltaDeUnidade(listarImportacoes({}));
});

test("Vendas: a guarda dispara ANTES de qualquer chamada ao banco (rejeita em milissegundos, sem round-trip de rede)", async () => {
  // Se a guarda estivesse depois do primeiro acesso ao supabase, esta
  // chamada levaria o tempo de uma requisição de rede real (ou penduraria/
  // daria erro de conexão) em vez de rejeitar quase instantaneamente com a
  // mensagem exata "selecione uma unidade" — é essa ordem que este teste
  // protege contra regressão.
  const inicio = Date.now();
  await esperaRecusaPorFaltaDeUnidade(vincularLote({ organizacaoId: "org1", unidadeId: undefined, itens: [] }));
  assert.ok(Date.now() - inicio < 500, "a guarda deveria rejeitar quase instantaneamente, sem tentar rede");
});
