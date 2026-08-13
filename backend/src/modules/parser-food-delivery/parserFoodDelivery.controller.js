import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./parserFoodDelivery.service.js";

const tenant = (req) => ({ organizacaoId: req.tenant.organizacaoId, unidadeId: req.tenant.unidadeId });

export const importacoes = asyncHandler(async (req, res) => {
  const data = await service.listarImportacoes(tenant(req));
  res.json({ data });
});

export const importacaoDetalhe = asyncHandler(async (req, res) => {
  const data = await service.obterImportacao({ ...tenant(req), importacaoId: req.params.id });
  res.json({ data });
});

export const arquivoImportacao = asyncHandler(async (req, res) => {
  const data = await service.arquivoOriginal({ ...tenant(req), importacaoId: req.params.id });
  res.json({ data });
});

// passo 1 — só lê e valida o arquivo (formato/período/quantidade)
export const importarPreview = asyncHandler(async (req, res) => {
  const data = await service.previewArquivo({ ...tenant(req), arquivo: req.body?.arquivo });
  res.json({ data });
});

// passo 2/3 — reclassifica com a lista de códigos "sem taxa" (idempotente, não salva)
export const conciliarPreview = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const data = await service.conciliarPreview({
    ...tenant(req), arquivo: body.arquivo, codigosSemTaxa: body.codigosSemTaxa,
    periodoInicioManual: body.periodoInicio, periodoFimManual: body.periodoFim,
  });
  res.json({ data });
});

// confirma e persiste
export const conciliarConfirmar = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const data = await service.confirmarImportacao({
    ...tenant(req), usuario: req.user, arquivo: body.arquivo, codigosSemTaxa: body.codigosSemTaxa,
    periodoInicioManual: body.periodoInicio, periodoFimManual: body.periodoFim,
  });
  res.status(201).json({ data });
});

export const editarCodigos = asyncHandler(async (req, res) => {
  const data = await service.editarCodigosSemTaxa({
    ...tenant(req), importacaoId: req.params.id, novosCodigos: req.body?.codigosSemTaxa, usuario: req.user,
  });
  res.json({ data });
});

export const excluirImportacao = asyncHandler(async (req, res) => {
  const data = await service.excluirImportacao({
    ...tenant(req), importacaoId: req.params.id, motivo: req.body?.motivo, usuario: req.user,
  });
  res.json({ data });
});
