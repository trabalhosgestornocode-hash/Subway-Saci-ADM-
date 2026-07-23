import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./contexto.service.js";

// GET /api/v1/contexto — contextos (orgs/unidades) do usuário autenticado.
export const obter = asyncHandler(async (req, res) => {
  res.json({ data: await service.obterContexto({ usuarioId: req.user.id }) });
});

// POST /api/v1/contexto/acessar — superadmin "Acessa" uma organização (auditado).
export const acessar = asyncHandler(async (req, res) => {
  const { organizacaoId } = req.body ?? {};
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;
  const userAgent = req.header("user-agent") || null;
  const data = await service.registrarAcessoSuperadmin({
    usuarioId: req.user.id, organizacaoId, ip, userAgent,
  });
  res.status(201).json({ data });
});

// GET /api/v1/contexto/acessos — histórico de acessos do superadmin (auditoria).
export const acessos = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarAcessosSuperadmin({ usuarioId: req.user.id, limite: req.query.limite }) });
});
