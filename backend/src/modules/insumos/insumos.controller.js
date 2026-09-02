import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./insumos.service.js";

export const listar = asyncHandler(async (req, res) => {
  const { busca, categoria, status, sem_preco } = req.query;
  const data = await service.listarInsumos({
    organizacaoId: req.tenant.organizacaoId,
    busca,
    categoria,
    status,
    semPreco: sem_preco === "true" || sem_preco === "1",
  });
  res.json({ data });
});

export const obter = asyncHandler(async (req, res) => {
  const data = await service.obterInsumo({ organizacaoId: req.tenant.organizacaoId, id: req.params.id });
  res.json({ data });
});

export const produtos = asyncHandler(async (req, res) => {
  const data = await service.produtosQueUsam({ organizacaoId: req.tenant.organizacaoId, insumoId: req.params.id });
  res.json({ data });
});

export const criar = asyncHandler(async (req, res) => {
  const data = await service.criarInsumo({
    organizacaoId: req.tenant.organizacaoId,
    dados: req.body ?? {},
    usuario: identidadeOperacional(req),
  });
  res.status(201).json({ data });
});

export const atualizar = asyncHandler(async (req, res) => {
  const data = await service.atualizarInsumo({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
    dados: req.body ?? {},
    usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

export const remover = asyncHandler(async (req, res) => {
  const data = await service.excluirInsumo({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
  });
  res.json({ data });
});

export const definirAtivo = asyncHandler(async (req, res) => {
  const data = await service.definirAtivo({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
    ativo: req.body?.ativo,
    usuario: identidadeOperacional(req),
  });
  res.json({ data });
});
