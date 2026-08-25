// Orquestração do Agente Crescer: recebe a mensagem já autenticada +
// contextualizada (organizacaoId/unidadeId/acesso vindos de req.tenant/
// req.acesso), resolve/continua a conversa, roda o loop de tool use da
// Claude API, mede o custo real e audita o uso.
//
// CONTEXTO CONVERSACIONAL (Fase 1.5): só o TEXTO FINAL de cada turno
// anterior entra no histórico reenviado a Claude — nunca os blocos brutos de
// tool_use/tool_result (esses só existem durante O LOOP DESTA requisição,
// nunca são persistidos nem reenviados entre turnos). Mantém contexto
// suficiente para referências como "e no dia 4?" sem inflar tokens.
//
// MEDIÇÃO DE CUSTO (Fase 1.6): uma interação pode envolver VÁRIAS chamadas à
// Anthropic (uma por iteração do loop, por causa de tool use) — o usage
// acumulado (agente.usage.js) soma todas antes de calcular o custo
// (agente.pricing.js) e gravar 1 linha em agente_uso (agente.uso.service.js).
// Se algo falhar DEPOIS de já ter consumido tokens, o `finally` ainda grava
// o que realmente foi consumido — nunca perde a métrica por causa do erro.
//
// `provider`/`executarFerramentaFn`/`conversas`/`uso` são injetáveis — em
// produção usam a Anthropic real, as tools reais e a persistência real
// (defaults abaixo); nos testes, dublês controlados (ver
// test/agente-service.test.js). Isso é o que permite testar o loop inteiro,
// incluindo isolamento de conversa e medição de custo, sem depender de
// rede/Anthropic/Supabase.
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { ferramentasDisponiveis, executarFerramenta, NOME_TOOL_NAVEGACAO } from "./agente.tools.js";
import { construirSystemPrompt } from "./agente.prompt.js";
import { sanitizarPageContext } from "./agente.pageContext.js";
import * as providerPadrao from "./agente.provider.js";
import * as conversasPadrao from "./agente.conversas.service.js";
import * as usoPadrao from "./agente.uso.service.js";
import { usageVazio, acumularUsage } from "./agente.usage.js";
import { calcularCustoUso } from "./agente.pricing.js";
import { MODELO } from "./agente.provider.js";

/** Limite de segurança contra loop infinito de tool use. Pequeno de propósito. */
export const MAX_TOOL_ITERATIONS = 6;
const TAMANHO_MAX_MENSAGEM = 2000;
/** Nunca lotar a resposta de botões — item explícito da Etapa F.1 (a maioria das respostas usa 0 ou 1). */
export const MAX_ACOES_SUGERIDAS = 3;

/**
 * Ponto de entrada do Agente Crescer.
 *
 * `organizacaoId`/`unidadeId`/`acesso` SEMPRE vêm de `req.tenant`/`req.acesso`
 * (Context Token, já validado por requireContexto) — nunca do corpo da
 * requisição. `conversationId` É aceito do corpo (é só um identificador de
 * conversa, não de tenant) — mas nunca usado sozinho: `conversas.buscarConversa`
 * sempre revalida usuario/organização/unidade antes de reaproveitar uma
 * conversa existente (ver agente.conversas.service.js).
 *
 * @param {{
 *   organizacaoId: string, unidadeId: string|null,
 *   acesso: import('../../middlewares/auth.js').AcessoContexto,
 *   usuario: import('../../middlewares/auth.js').UsuarioAutenticado,
 *   mensagem: unknown,
 *   conversationId?: unknown,
 *   pageContext?: unknown,
 *   provider?: typeof providerPadrao,
 *   executarFerramentaFn?: typeof executarFerramenta,
 *   conversas?: typeof conversasPadrao,
 *   uso?: typeof usoPadrao,
 * }} params
 */
export async function processarMensagem({
  organizacaoId, unidadeId, acesso, usuario, mensagem, conversationId, pageContext,
  provider = providerPadrao,
  executarFerramentaFn = executarFerramenta,
  conversas = conversasPadrao,
  uso = usoPadrao,
}) {
  const textoMensagem = v.texto(mensagem, "Mensagem", { min: 1, max: TAMANHO_MAX_MENSAGEM });
  const conversaIdInformado = v.uuidOpcional(conversationId, "conversationId");
  // PAGE CONTEXT: puramente informativo pro prompt (ver agente.pageContext.js)
  // — NUNCA decide tenant/módulo/permissão (isso já está fixado acima, a
  // partir de organizacaoId/unidadeId/acesso, sempre vindos do backend).
  // Entrada não confiável (vem do frontend): sanitizada numa lista branca
  // antes de tocar em qualquer coisa; malformada/maliciosa vira `null`
  // silenciosamente, nunca derruba a mensagem do usuário.
  const contextoPagina = sanitizarPageContext(pageContext);

  const inicio = Date.now();
  const toolsUtilizadas = [];
  // Etapa F.1 — sugestões de navegação (nunca dado consultado, por isso
  // nunca entram em toolsUtilizadas/"Consultou": ver loop abaixo).
  const acoesSugeridas = [];
  let usageTotal = usageVazio();
  let toolCallsCount = 0;
  let modeloUsado = MODELO;
  let sucesso = false;
  let conversaId = null;
  let mensagensDeContexto = 0;
  let erroCapturado = null;

  try {
    // Reaproveita a conversa SÓ se ela pertencer a este usuário+organização+
    // unidade — qualquer divergência (outro tenant, id inventado, id de
    // conversa já apagada) é tratada exatamente como "não existe": cria uma
    // conversa nova, sem revelar ao cliente a diferença entre os dois casos.
    const existente = await conversas.buscarConversa({
      conversaId: conversaIdInformado, usuarioId: usuario?.id ?? null, organizacaoId, unidadeId,
    });
    conversaId = existente?.id ?? await conversas.criarConversa({ usuarioId: usuario?.id ?? null, organizacaoId, unidadeId });

    const historico = await conversas.buscarMensagens(conversaId, conversas.HISTORICO_MAX_MENSAGENS);
    mensagensDeContexto = historico.length;

    const system = construirSystemPrompt({ usuario, acesso, pageContext: contextoPagina });
    const messages = [
      ...historico.map((m) => ({ role: m.papel, content: m.conteudo })),
      { role: "user", content: textoMensagem },
    ];
    const contextoTools = { organizacaoId, unidadeId, acesso };
    // Catálogo FILTRADO por módulo/permissão do acesso atual (1ª camada de
    // defesa em profundidade) — calculado 1 vez, reaproveitado em todas as
    // iterações do loop (não muda dentro da mesma interação). A 2ª camada
    // (garantirAcessoModulo/garantirPermissao dentro de cada tool) continua
    // rodando sempre, independente disto — ver agente.tools.js.
    const ferramentas = ferramentasDisponiveis(acesso);

    let respostaFinal = null;
    for (let iteracao = 0; iteracao < MAX_TOOL_ITERATIONS; iteracao++) {
      const resposta = await provider.enviarMensagem({ system, messages, tools: ferramentas });
      usageTotal = acumularUsage(usageTotal, resposta.usage);
      if (resposta.model) modeloUsado = resposta.model;

      if (resposta.stop_reason !== "tool_use") {
        respostaFinal = extrairTexto(resposta);
        break;
      }

      messages.push({ role: "assistant", content: resposta.content });

      const chamadas = resposta.content.filter((b) => b.type === "tool_use");
      toolCallsCount += chamadas.length;
      const resultados = [];
      for (const chamada of chamadas) {
        const resultado = await executarComoToolResult(chamada, contextoTools, executarFerramentaFn);
        resultados.push(resultado);
        if (chamada.name === NOME_TOOL_NAVEGACAO) {
          // Navegação nunca é "fonte de dado consultada" — não entra em
          // toolsUtilizadas. Extrai a action já resolvida (module/permissão/
          // parâmetros já validados por agente.acoes.js dentro da tool).
          extrairAcaoSugerida(resultado, acoesSugeridas);
        } else {
          toolsUtilizadas.push(chamada.name);
        }
      }
      messages.push({ role: "user", content: resultados });
    }

    if (respostaFinal === null) {
      throw ApiError.internal("O Agente Crescer não conseguiu concluir a resposta (limite de consultas às ferramentas atingido). Tente reformular a pergunta.");
    }

    // Persiste só o texto final de cada lado — nunca os blocos de tool_use/
    // tool_result do loop acima (ver cabeçalho do arquivo). `acoes` (Etapa
    // F.1) é persistida pra reaparecer ao reidratar a conversa (ver
    // migration 050) — mas nunca é fonte de autorização: clicar numa action
    // antiga sempre revalida módulo/permissão ATUAIS via o router do
    // frontend, nunca confia no que foi salvo aqui.
    await conversas.salvarMensagem({ conversaId, papel: "user", conteudo: textoMensagem });
    await conversas.salvarMensagem({ conversaId, papel: "assistant", conteudo: respostaFinal, toolsUtilizadas, acoes: acoesSugeridas });

    sucesso = true;
    return { resposta: respostaFinal, conversationId: conversaId, actions: acoesSugeridas, metadata: { toolsUtilizadas } };
  } catch (erro) {
    erroCapturado = erro;
    throw erro;
  } finally {
    const duracaoMs = Date.now() - inicio;
    const custo = calcularCustoUso({ model: modeloUsado, ...usageTotal });
    const errorCode = erroCapturado ? String(erroCapturado.statusCode ?? "erro_interno") : null;

    // Métrica estruturada (custo/tokens/modelo) para o SuperAdmin — nunca
    // derruba a requisição se falhar (ver agente.uso.service.js#registrarUso).
    await uso.registrarUso({
      conversaId, usuarioId: usuario?.id ?? null, organizacaoId, unidadeId,
      provider: "anthropic", model: modeloUsado, pricingVersion: custo.pricingVersion,
      inputTokens: usageTotal.inputTokens, outputTokens: usageTotal.outputTokens,
      cacheCreationTokens: usageTotal.cacheCreationTokens, cacheReadTokens: usageTotal.cacheReadTokens,
      estimatedCostUsd: custo.estimatedCostUsd,
      toolCallsCount, toolsUsed: toolsUtilizadas,
      durationMs: duracaoMs, success: sucesso, errorCode,
    });

    // Auditoria NUNCA carrega o texto da mensagem/resposta (privacidade) —
    // só metadados de uso. Não derruba a requisição se falhar (auditar() já
    // engole o próprio erro, ver shared/auditoria.js).
    await auditar({
      atorId: usuario?.id ?? null,
      atorEmail: usuario?.email ?? null,
      atorTipo: "usuario",
      acao: ACOES.AGENTE_MENSAGEM_ENVIADA,
      entidade: "agente_mensagem",
      entidadeId: conversaId,
      organizacaoId: organizacaoId ?? null,
      impersonadoPor: acesso?.impersonadoPor ?? null,
      detalhes: {
        unidadeId: unidadeId ?? null, conversationId: conversaId, mensagensDeContexto,
        toolsUtilizadas, model: modeloUsado, estimatedCostUsd: custo.estimatedCostUsd,
        // Só o identificador da página (ex.: "dashboard-executivo"), nunca o
        // objeto pageContext inteiro — mesmo espírito de nunca gravar o
        // texto da conversa: aqui é telemetria, não conteúdo.
        paginaContexto: contextoPagina?.module ?? null,
        ...usageTotal, duracaoMs, sucesso,
      },
    });
  }
}

/**
 * Histórico de uma conversa para reidratar a tela (ex.: após F5). Mesma
 * validação de tenant de `processarMensagem` — um conversationId de outro
 * usuário/organização/unidade nunca é encontrado.
 * @param {{organizacaoId: string, unidadeId: string|null, usuario: {id?: string}, conversationId: unknown, conversas?: typeof conversasPadrao}} params
 */
export async function obterHistoricoConversa({ organizacaoId, unidadeId, usuario, conversationId, conversas = conversasPadrao }) {
  const conversaId = v.uuid(conversationId, "conversationId");
  const existente = await conversas.buscarConversa({ conversaId, usuarioId: usuario?.id ?? null, organizacaoId, unidadeId });
  if (!existente) throw ApiError.notFound("Conversa não encontrada.");

  const mensagens = await conversas.buscarMensagens(existente.id);
  return {
    conversationId: existente.id,
    mensagens: mensagens.map((m) => ({
      papel: m.papel, texto: m.conteudo, tools: m.toolsUtilizadas, actions: m.acoes ?? [], criadoEm: m.criadoEm,
    })),
  };
}

async function executarComoToolResult(chamada, contextoTools, executarFerramentaFn) {
  try {
    const resultado = await executarFerramentaFn(chamada.name, chamada.input, contextoTools);
    return { type: "tool_result", tool_use_id: chamada.id, content: JSON.stringify(resultado ?? {}) };
  } catch (erro) {
    const mensagemErro = erro instanceof ApiError ? erro.message : "Falha ao executar esta consulta.";
    return { type: "tool_result", tool_use_id: chamada.id, content: JSON.stringify({ erro: mensagemErro }), is_error: true };
  }
}

/**
 * Extrai a action já resolvida (ou nada) do tool_result de `sugerir_navegacao`
 * e empilha em `acoesSugeridas`, respeitando MAX_ACOES_SUGERIDAS — nunca
 * lança: um JSON inesperado ou uma tool que retornou erro só significa
 * "nenhuma action desta chamada", nunca derruba a interação.
 * @param {{content: string, is_error?: boolean}} resultado
 * @param {object[]} acoesSugeridas
 */
function extrairAcaoSugerida(resultado, acoesSugeridas) {
  if (resultado.is_error || acoesSugeridas.length >= MAX_ACOES_SUGERIDAS) return;
  try {
    const parsed = JSON.parse(resultado.content);
    if (parsed?.sugerida && parsed.action) acoesSugeridas.push(parsed.action);
  } catch {
    // Corpo inesperado — trata como "nenhuma action", nunca derruba a interação.
  }
}

function extrairTexto(resposta) {
  if (resposta.stop_reason === "refusal") {
    return "Não consigo responder a essa solicitação.";
  }
  const texto = (resposta.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return texto || "Não consegui gerar uma resposta. Tente reformular a pergunta.";
}
