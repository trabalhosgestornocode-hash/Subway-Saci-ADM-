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

export const salvarMeta = asyncHandler(async (req, res) => {
  // `indicador` vem SEMPRE da rota, nunca do corpo — evita que um campo
  // `indicador` divergente no body altere silenciosamente qual meta é salva.
  const data = await service.salvarMeta({ ...tenant(req), usuario: req.user, ...(req.body ?? {}), indicador: req.params.indicador });
  res.status(201).json({ data });
});

// Calendário do mês de UM indicador manual (REV/Pesquisas/Nota iFood/Pedidos
// com chamado) — mesmo padrão do calendário da Visio (item corrigido: era
// mensal, agora é diário).
export const calendarioIndicador = asyncHandler(async (req, res) => {
  const data = await service.obterCalendarioIndicador({ ...tenant(req), indicador: req.params.indicador, ano: req.query.ano, mes: req.query.mes });
  res.json({ data });
});

export const historicoMensalIndicador = asyncHandler(async (req, res) => {
  const data = await service.historicoMensalIndicador({ ...tenant(req), indicador: req.params.indicador, meses: req.query.meses });
  res.json({ data });
});

export const salvarValorDiaIndicador = asyncHandler(async (req, res) => {
  const data = await service.salvarValorDiaIndicador({ ...tenant(req), usuario: req.user, ...(req.body ?? {}), indicador: req.params.indicador });
  res.status(201).json({ data });
});

// REV (migration 052): 1 valor por unidade+mês, nunca por dia. O valor de
// LEITURA já vem embutido em `mes.revMensal`; esta rota é só a de ESCRITA.
export const salvarRevMensal = asyncHandler(async (req, res) => {
  const data = await service.salvarRevMensal({ ...tenant(req), usuario: req.user, ...(req.body ?? {}) });
  res.status(201).json({ data });
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
