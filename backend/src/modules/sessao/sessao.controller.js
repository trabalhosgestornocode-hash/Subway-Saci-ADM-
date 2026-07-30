import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./sessao.service.js";
import * as v from "../../shared/validar.js";

/** Origem da requisição — usada na auditoria e gravada na sessão. */
function origem(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}

// GET /api/v1/sessao/acessos — empresas/unidades que o usuário pode acessar.
// É o que alimenta a tela de seleção logo após o login.
export const acessos = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarAcessos({ usuarioId: req.user.id }) });
});

// POST /api/v1/sessao/selecionar — valida a escolha e emite o Context Token.
export const selecionar = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const data = await service.selecionarContexto({
    usuario: req.user,
    organizacaoId: body.organizacaoId,
    unidadeId: body.unidadeId,
    troca: v.booleano(body.troca),
    ...origem(req),
  });
  res.status(201).json({ data });
});

// GET /api/v1/sessao/atual — contexto vigente (recarregamento de página).
export const atual = asyncHandler(async (req, res) => {
  res.json({ data: service.contextoAtual(req) });
});

// POST /api/v1/sessao/encerrar — revoga o contexto. Serve tanto para "Sair"
// quanto para "Sair da empresa" (fim da impersonação). O corpo não influencia
// nada: o que é revogado vem da identidade autenticada.
export const encerrar = asyncHandler(async (req, res) => {
  const data = await service.encerrarContexto({
    usuario: req.user, acesso: req.acesso ?? null, ...origem(req),
  });
  res.json({ data });
});

// POST /api/v1/sessao/senha — define a nova senha do próprio usuário e limpa a
// flag de senha provisória. A identidade é o Access Token; não pede a senha
// atual porque o usuário acabou de autenticar com ela (é o fluxo do 1º acesso).
export const novaSenha = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const data = await service.definirNovaSenha({
    usuario: req.user, senha: body.senha, ...origem(req),
  });
  res.json({ data });
});
