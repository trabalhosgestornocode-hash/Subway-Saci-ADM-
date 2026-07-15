import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./vendas.service.js";

const tenant = (req) => ({ organizacaoId: req.tenant.organizacaoId, unidadeId: req.tenant.unidadeId });
const filtros = (req) => ({
  de: req.query.de, ate: req.query.ate, canal: req.query.canal, origem: req.query.origem,
  grupo: req.query.grupo, tipo: req.query.tipo, vinculo: req.query.vinculo,
});

export const visaoGeral = asyncHandler(async (req, res) => {
  res.json({ data: await service.visaoGeral({ unidadeId: req.tenant.unidadeId, filtros: filtros(req) }) });
});
export const faturamento = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarFaturamento({ unidadeId: req.tenant.unidadeId, filtros: filtros(req) }) });
});
export const produtosVendidos = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarProdutosVendidos({ unidadeId: req.tenant.unidadeId, filtros: filtros(req) }) });
});
export const importacoes = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarImportacoes({ unidadeId: req.tenant.unidadeId }) });
});
export const excluirImportacao = asyncHandler(async (req, res) => {
  res.json({ data: await service.excluirImportacao({ unidadeId: req.tenant.unidadeId, importacaoId: req.params.id }) });
});
// link temporário para baixar o arquivo original importado
export const arquivoOriginal = asyncHandler(async (req, res) => {
  res.json({ data: await service.arquivoOriginal({ unidadeId: req.tenant.unidadeId, importacaoId: req.params.id }) });
});
export const divergencias = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarDivergencias({ unidadeId: req.tenant.unidadeId }) });
});
// marca/desmarca divergência como resolvida
export const resolverDivergencia = asyncHandler(async (req, res) => {
  const resolvida = req.body?.resolvida !== false;
  res.json({ data: await service.resolverDivergencia({ unidadeId: req.tenant.unidadeId, divergenciaId: req.params.id, resolvida }) });
});

// prévia (dry-run) da importação — o backend lê o arquivo (CSV/Excel/PDF)
export const preview = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const data = await service.processarImportacaoVendas({ organizacaoId, unidadeId, payload: req.body ?? {}, confirmar: false });
  res.json({ data });
});
// confirma e persiste (guarda também o arquivo original no Storage)
export const importar = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const data = await service.processarImportacaoVendas({ organizacaoId, unidadeId, payload: req.body ?? {}, confirmar: true });
  res.status(201).json({ data });
});

// vincula código do SW a um produto do sistema (com componentes p/ combos)
export const vincular = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { codigoSw, produtoId, tipoItem, nomeSw, componentes } = req.body ?? {};
  res.json({ data: await service.vincularProduto({ organizacaoId, unidadeId, codigoSw, produtoId, tipoItem, nomeSw, componentes }) });
});
// vínculo em massa
export const vincularLote = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: await service.vincularLote({ organizacaoId, unidadeId, itens: req.body?.itens }) });
});
// componentes atuais de um combo
export const componentesCombo = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarComponentes({ organizacaoId: req.tenant.organizacaoId, codigoSw: req.params.codigo }) });
});
