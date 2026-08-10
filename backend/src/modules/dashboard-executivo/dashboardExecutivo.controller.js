import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./dashboardExecutivo.service.js";
import { simularPrecoProduto } from "./dashboardExecutivo.simulador.service.js";

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

// Exclusão universal (real ou teste) — só quem tem DASHBOARD_EXECUTIVO_EXCLUIR
// (organization_admin). Sempre exige motivo.
export const excluirLancamento = asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const data = await service.excluirLancamento({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: b.unidadeId,
    usuario: req.user,
    id: req.params.id,
    motivo: b.motivo,
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

// Lançamento de faturamento mensal (distribuição). Mesmo padrão do reset de
// teste: confirmar=false (padrão) só devolve a prévia; confirmar=true executa.
export const lancamentoMensal = asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const data = await service.lancamentoMensal({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: b.unidadeId,
    usuario: req.user,
    dados: b,
    confirmar: b.confirmar === true,
  });
  res.status(b.confirmar === true ? 201 : 200).json({ data: { confirmado: b.confirmar === true, ...data } });
});

// Simulação de preço Balcão/iFood + tabela (card "Simulação de preço" da Visão Geral).
export const simuladorPreco = asyncHandler(async (req, res) => {
  const data = await simularPrecoProduto({
    organizacaoId: req.tenant.organizacaoId,
    unidadeIdSessao: req.tenant.unidadeId,
    unidadeIdSolicitado: req.query.unidadeId,
    canal: req.query.canal,
    tabela: req.query.tabela,
    produto: req.query.produto,
    mes: req.query.mes,
    ano: req.query.ano,
  });
  res.json({ data });
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
