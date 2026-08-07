import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./dashboardExecutivo.service.js";

export const unidades = asyncHandler(async (req, res) => {
  const data = await service.listarUnidades({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
  });
  res.json({ data });
});

export const mes = asyncHandler(async (req, res) => {
  const data = await service.obterMes({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.query.unidadeId,
    mes: req.query.mes,
    ano: req.query.ano,
  });
  res.json({ data });
});

export const lancamentoPorData = asyncHandler(async (req, res) => {
  const data = await service.obterLancamentoPorData({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.query.unidadeId,
    data: req.params.data,
  });
  res.json({ data });
});

export const criarLancamento = asyncHandler(async (req, res) => {
  const data = await service.criarLancamento({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    acesso: req.acesso,
    usuario: req.user,
    dados: req.body ?? {},
  });
  res.status(201).json({ data });
});

export const atualizarLancamento = asyncHandler(async (req, res) => {
  const data = await service.atualizarLancamento({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    acesso: req.acesso,
    usuario: req.user,
    id: req.params.id,
    dados: req.body ?? {},
  });
  res.json({ data });
});

export const modeloLogistico = asyncHandler(async (req, res) => {
  const data = await service.obterModeloLogisticoUnidade({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.params.unidadeId,
  });
  res.json({ data });
});

export const atualizarModeloLogistico = asyncHandler(async (req, res) => {
  const data = await service.atualizarModeloLogisticoUnidade({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.params.unidadeId,
    usuario: req.user,
    dados: req.body ?? {},
  });
  res.json({ data });
});

export const historicoModeloLogistico = asyncHandler(async (req, res) => {
  const data = await service.historicoModeloLogisticoUnidade({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.params.unidadeId,
  });
  res.json({ data });
});

// Reset de dia — SÓ funciona em unidade de teste (o service revalida sempre).
// confirmar=false (padrão): devolve só o preview (quais lançamentos seriam
// removidos). confirmar=true: executa de fato.
export const resetTeste = asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  if (b.confirmar === true) {
    const data = await service.executarResetTeste({
      organizacaoId: req.tenant.organizacaoId,
      unidadeIdSessao: req.tenant.unidadeId,
      unidadeIdSolicitado: req.params.unidadeId,
      data: b.data,
      usuario: req.user,
    });
    res.json({ data: { confirmado: true, ...data } });
  } else {
    const data = await service.previewResetTeste({
      organizacaoId: req.tenant.organizacaoId,
      unidadeIdSessao: req.tenant.unidadeId,
      unidadeIdSolicitado: req.params.unidadeId,
      data: b.data,
    });
    res.json({ data: { confirmado: false, ...data } });
  }
});

export const historico = asyncHandler(async (req, res) => {
  const data = await service.obterHistorico({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.query.unidadeId,
    ano: req.query.ano,
  });
  res.json({ data });
});
