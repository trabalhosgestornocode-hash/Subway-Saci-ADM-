import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./bonificacaoMensal.service.js";

const tenant = (req) => ({ organizacaoId: req.tenant.organizacaoId, unidadeId: req.tenant.unidadeId });

export const mes = asyncHandler(async (req, res) => {
  const data = await service.obterMes({ ...tenant(req), ano: req.query.ano, mes: req.query.mes });
  res.json({ data });
});

export const lancamentoPorData = asyncHandler(async (req, res) => {
  const data = await service.obterLancamentoPorData({ ...tenant(req), data: req.params.data });
  res.json({ data });
});

export const excluirLancamento = asyncHandler(async (req, res) => {
  const data = await service.excluirLancamento({ ...tenant(req), usuario: req.user, data: req.params.data, motivo: req.body?.motivo });
  res.json({ data });
});

export const salvarLancamento = asyncHandler(async (req, res) => {
  const data = await service.upsertLancamentoManual({ ...tenant(req), usuario: req.user, dados: req.body ?? {} });
  res.status(201).json({ data });
});

export const metas = asyncHandler(async (req, res) => {
  const data = await service.listarMetas(tenant(req));
  res.json({ data });
});

export const historico = asyncHandler(async (req, res) => {
  const data = await service.listarHistoricoMeses({ ...tenant(req), ano: req.query.ano });
  res.json({ data });
});

export const importacoes = asyncHandler(async (req, res) => {
  const data = await service.listarImportacoes(tenant(req));
  res.json({ data });
});

export const arquivoImportacao = asyncHandler(async (req, res) => {
  const data = await service.arquivoOriginal({ ...tenant(req), importacaoId: req.params.id });
  res.json({ data });
});

// prévia (dry-run) da importação dos 2 PDFs da Visio
export const importarPreview = asyncHandler(async (req, res) => {
  const data = await service.processarImportacaoVisio({ ...tenant(req), usuario: req.user, payload: req.body ?? {}, confirmar: false });
  res.json({ data });
});
// confirma e persiste
export const importarConfirmar = asyncHandler(async (req, res) => {
  const data = await service.processarImportacaoVisio({ ...tenant(req), usuario: req.user, payload: req.body ?? {}, confirmar: true });
  res.status(201).json({ data });
});
