// Tool "listar_insumos" — ranking/listagem de insumos por custo unitário ou
// nome (Etapa C). Read-only, sem N+1: 1 única consulta via
// insumos.service.js#listarInsumos (mesma fonte oficial que já alimenta a
// tela Insumos — filtro de categoria/status já aplicado no banco); só a
// ordenação/corte final acontece aqui, puro/testável.
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import { CATEGORIAS_INSUMO, listarInsumos as listarInsumosPadrao } from "../../insumos/insumos.service.js";

/** Trava contra o modelo pedir uma lista gigante — nunca mais que isto, mesmo se solicitado. */
export const MAX_INSUMOS_TOOL = 50;
const LIMITE_PADRAO = 10;

const CAMPOS_ORDENACAO = ["custo_unitario", "nome"];

export const definicao = {
  name: "listar_insumos",
  description:
    "Lista/ranqueia insumos (matérias-primas) do catálogo por custo unitário ou nome — use para perguntas como \"quais insumos são mais caros\", \"quais insumos estão sem custo cadastrado\", \"quais insumos estão inativos\". Por padrão retorna só insumos ATIVOS, ordenados do maior custo unitário para o menor, limitado a 10. Os dados vêm da mesma fonte oficial que já alimenta a tela Insumos — nunca é recalculado aqui.",
  input_schema: {
    type: "object",
    properties: {
      categoria: { type: "string", enum: CATEGORIAS_INSUMO, description: "Filtra por categoria do insumo. Omitir para todas as categorias." },
      ativo: { type: "boolean", description: "true (padrão) = só insumos ativos. false = só inativos." },
      semCusto: { type: "boolean", description: "true = só insumos SEM custo cadastrado (preço ou quantidade da embalagem ausente)." },
      ordenarPor: { type: "string", enum: CAMPOS_ORDENACAO, description: "Campo de ordenação. Padrão: custo_unitario." },
      ordem: { type: "string", enum: ["asc", "desc"], description: "Direção. Padrão: desc (maior custo/última letra primeiro)." },
      limite: { type: "integer", description: `Quantos insumos retornar (máximo ${MAX_INSUMOS_TOOL}). Padrão: ${LIMITE_PADRAO}.` },
    },
    additionalProperties: false,
  },
};

/**
 * @param {{categoria?: string, ativo?: boolean, semCusto?: boolean, ordenarPor?: string, ordem?: string, limite?: number}} input
 * @param {{organizacaoId: string, acesso: object}} contexto
 * @param {{listarInsumos: typeof listarInsumosPadrao}} [deps] injeção para teste.
 */
export async function executar(input, { organizacaoId, acesso }, deps = { listarInsumos: listarInsumosPadrao }) {
  garantirAcessoModulo(acesso, MODULOS.INGREDIENTS);
  garantirPermissao(acesso, PERMISSOES.INSUMOS_VER);

  const categoria = CATEGORIAS_INSUMO.includes(input?.categoria) ? input.categoria : undefined;
  const apenasAtivos = input?.ativo !== false;
  const status = apenasAtivos ? "ativo" : "inativo";
  const semPreco = input?.semCusto === true ? true : undefined;

  const { itens } = await deps.listarInsumos({ organizacaoId, categoria, status, semPreco });

  const resultado = ordenarECapear({
    itens: itens.map((i) => ({
      nome: i.nome, categoria: i.categoria, categoriaRotulo: i.categoria_rotulo,
      unidadeBase: i.unidade_base, custoUnitario: i.custo_unitario, semCusto: i.sem_custo,
      ativo: i.ativo, atualizadoEm: i.preco_atualizado_em,
    })),
    ordenarPor: input?.ordenarPor, ordem: input?.ordem, limite: input?.limite,
  });

  return { ativo: apenasAtivos, ...resultado };
}

/**
 * Ordena e corta a lista já filtrada pelo service — pura/testável, nenhum I/O.
 * @param {{itens: any[], ordenarPor?: string, ordem?: string, limite?: number}} p
 */
export function ordenarECapear({ itens, ordenarPor, ordem, limite }) {
  const campo = ordenarPor === "nome" ? "nome" : "custoUnitario";
  const dirDesc = ordem !== "asc"; // padrão: desc
  const lista = [...itens].sort((a, b) => {
    if (campo === "nome") return dirDesc ? b.nome.localeCompare(a.nome) : a.nome.localeCompare(b.nome);
    // custoUnitario: sem dado NUNCA vira 0 — vai sempre pro fim, em qualquer direção.
    const va = a.custoUnitario, vb = b.custoUnitario;
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return dirDesc ? vb - va : va - vb;
  });

  const limiteAplicado = Math.min(MAX_INSUMOS_TOOL, Math.max(1, Number(limite) || LIMITE_PADRAO));
  return { itens: lista.slice(0, limiteAplicado), totalDisponivel: lista.length, limiteAplicado };
}
