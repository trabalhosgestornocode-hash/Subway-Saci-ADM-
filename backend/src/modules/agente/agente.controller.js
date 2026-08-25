import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./agente.service.js";

// organizacaoId/unidadeId/acesso vêm SEMPRE de req.tenant/req.acesso
// (Context Token, já resolvidos por requireContexto) — nunca do corpo da
// requisição. O corpo fornece a pergunta, opcionalmente a conversa a
// continuar (conversationId nunca é usado sozinho — ver agente.service.js) e
// opcionalmente o PAGE CONTEXT (em que tela da interface o usuário estava —
// ex.: { module: "dashboard-executivo", year, month }). pageContext É
// TRATADO COMO NÃO CONFIÁVEL AQUI: passa bruto para o service, que sanitiza
// numa lista branca antes de qualquer uso (ver agente.pageContext.js) — nunca
// influencia tenant/módulo/permissão, só o texto do system prompt.
export const mensagem = asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const data = await service.processarMensagem({
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: req.tenant.unidadeId,
    acesso: req.acesso,
    usuario: req.user,
    mensagem: b.mensagem,
    conversationId: b.conversationId,
    pageContext: b.pageContext,
  });
  res.json({ data });
});

// Reidrata o histórico de uma conversa (ex.: após F5 na tela do agente).
export const historicoConversa = asyncHandler(async (req, res) => {
  const data = await service.obterHistoricoConversa({
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: req.tenant.unidadeId,
    usuario: req.user,
    conversationId: req.params.conversationId,
  });
  res.json({ data });
});
