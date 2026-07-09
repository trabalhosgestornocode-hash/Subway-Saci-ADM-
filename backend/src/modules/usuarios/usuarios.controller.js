import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./usuarios.service.js";

export const listar = asyncHandler(async (req, res) => {
  const data = await service.listarUsuarios({ organizacaoId: req.tenant.organizacaoId });
  res.json({ data });
});

export const criar = asyncHandler(async (req, res) => {
  const { nome, email, senha, papel } = req.body ?? {};
  const data = await service.criarUsuario({
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: req.tenant.unidadeId,
    nome, email, senha, papel,
  });
  res.status(201).json({ data });
});

export const atualizar = asyncHandler(async (req, res) => {
  const { papel, ativo } = req.body ?? {};
  const data = await service.atualizarUsuario({
    organizacaoId: req.tenant.organizacaoId, id: req.params.id, papel, ativo,
  });
  res.json({ data });
});

export const excluir = asyncHandler(async (req, res) => {
  const data = await service.excluirUsuario({
    organizacaoId: req.tenant.organizacaoId, id: req.params.id, solicitanteId: req.user.id,
  });
  res.json({ data });
});
