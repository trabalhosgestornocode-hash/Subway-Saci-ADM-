// MFA (verificação em duas etapas) — SEMPRE via Supabase Auth.
//
// NÃO existe TOTP próprio, NÃO guardamos o segredo em lugar nenhum. O
// `supabase.auth.mfa.*` faz enroll/challenge/verify/unenroll; o backend só
// LÊ o nível AAL do JWT (req.user.aal) e audita o evento a partir do estado
// real (POST /sessao/mfa/evento).
//
// ESTADOS (o que a UI precisa distinguir):
//   'sem_fator'         -> conta nunca cadastrou 2º fator
//   'aal1_com_fator'    -> tem fator, mas a sessão atual é só senha -> DESAFIAR
//   'aal2'              -> sessão já verificada com o 2º fator
//
// O frontend NUNCA marca "mfaOk = true" por conta própria: quem decide é o
// Supabase (upgrade real da sessão para AAL2) e o backend (que relê o JWT).

import { getSupabase } from "./supabaseClient.js";
import { http } from "./sessao.js";

/**
 * Estado de MFA da sessão atual.
 * @returns {Promise<{ estado: 'sem_fator'|'aal1_com_fator'|'aal2', nivelAtual: string|null, nivelProximo: string|null, fatores: Array<{id:string, friendlyName:string|null, status:string}> }>}
 */
export async function estadoMfa() {
  const sb = await getSupabase();
  const [{ data: aal }, { data: lista }] = await Promise.all([
    sb.auth.mfa.getAuthenticatorAssuranceLevel(),
    sb.auth.mfa.listFactors(),
  ]);
  const fatores = (lista?.totp ?? []).map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null, status: f.status }));
  const temVerificado = fatores.some((f) => f.status === "verified");
  let estado = "sem_fator";
  if (aal?.currentLevel === "aal2") estado = "aal2";
  else if (temVerificado) estado = "aal1_com_fator";
  return { estado, nivelAtual: aal?.currentLevel ?? null, nivelProximo: aal?.nextLevel ?? null, fatores };
}

/**
 * Passo 1 do cadastro: cria um fator TOTP (status 'unverified'). Devolve o QR
 * (SVG gerado pelo Supabase — sem lib de QR aqui), o segredo e a URI otpauth.
 * @param {string} [nome] friendly name
 */
export async function iniciarCadastro(nome = "Autenticador") {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: nome });
  if (error) throw new Error(traduz(error.message));
  return {
    factorId: data.id,
    qrSvg: data.totp?.qr_code ?? null,   // SVG (string) — renderizável direto
    segredo: data.totp?.secret ?? null,  // para digitar manualmente no app
    uri: data.totp?.uri ?? null,
  };
}

/**
 * Passo 2 do cadastro: challenge + verify. Em caso de sucesso a sessão SOBE
 * para AAL2 e o backend é avisado (auditoria a partir do estado real).
 * @param {string} factorId @param {string} codigo 6 dígitos
 */
export async function confirmarCadastro(factorId, codigo) {
  const sb = await getSupabase();
  const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId });
  if (e1) throw new Error(traduz(e1.message));
  const { error: e2 } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code: String(codigo || "").trim() });
  if (e2) throw new Error(traduz(e2.message));
  await avisarBackend("cadastrada");
  return true;
}

/**
 * Desafio de LOGIN — a conta já tem fator verificado e a sessão está em AAL1.
 * challenge + verify no fator verificado -> sessão vira AAL2.
 * @param {string} codigo 6 dígitos
 */
export async function desafiarLogin(codigo) {
  const sb = await getSupabase();
  const { data: lista } = await sb.auth.mfa.listFactors();
  const fator = (lista?.totp ?? []).find((f) => f.status === "verified");
  if (!fator) throw new Error("Nenhum autenticador cadastrado nesta conta.");
  const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: fator.id });
  if (e1) throw new Error(traduz(e1.message));
  const { error: e2 } = await sb.auth.mfa.verify({ factorId: fator.id, challengeId: ch.id, code: String(codigo || "").trim() });
  if (e2) throw new Error(traduz(e2.message));
  return true;
}

/**
 * Remove um fator. Não há endpoint público de "remover MFA de outra pessoa" —
 * isto é o PRÓPRIO usuário removendo o SEU fator, autenticado.
 * @param {string} factorId
 */
export async function removerFator(factorId) {
  const sb = await getSupabase();
  const { error } = await sb.auth.mfa.unenroll({ factorId });
  if (error) throw new Error(traduz(error.message));
  await avisarBackend("removida");
  return true;
}

/** Avisa o backend para auditar (ele relê o estado real do JWT — não confia no cliente). */
async function avisarBackend(acao) {
  try { await http.post("/api/v1/sessao/mfa/evento", { acao }); } catch { /* auditoria não pode derrubar o fluxo */ }
}

/**
 * `true` se a sessão precisa do 2º fator para subir a AAL2 (tem fator, está em
 * AAL1). Chamado após o login e ao receber `app:mfa-requerida`.
 */
export async function precisaDesafioMfa() {
  try { return (await estadoMfa()).estado === "aal1_com_fator"; }
  catch { return false; }
}

let _desafioAberto = null;
/**
 * Abre um overlay pedindo o código do autenticador e sobe a sessão para AAL2.
 * Idempotente (um por vez). Resolve `true` se verificou, `false` se cancelou.
 * @returns {Promise<boolean>}
 */
export function abrirDesafioMfa() {
  if (_desafioAberto) return _desafioAberto;
  _desafioAberto = new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.innerHTML = `
      <div class="modal mfa-dialog">
        <h2>Verificação em duas etapas</h2>
        <p>Digite o código de 6 dígitos do seu app autenticador para continuar.</p>
        <input id="mfa-ov-codigo" class="mfa-codigo-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
        <p class="mfa-erro bad" id="mfa-ov-erro" hidden></p>
        <div class="cfg-acoes">
          <button class="btn btn-primary" id="mfa-ov-ok">Confirmar</button>
          <button class="btn btn-ghost btn-sm" id="mfa-ov-cancel">Cancelar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector("#mfa-ov-codigo");
    const err = ov.querySelector("#mfa-ov-erro");
    inp.focus();
    const fechar = (ok) => { ov.remove(); _desafioAberto = null; resolve(ok); };
    ov.querySelector("#mfa-ov-cancel").addEventListener("click", () => fechar(false));
    ov.querySelector("#mfa-ov-ok").addEventListener("click", async () => {
      const codigo = inp.value.trim();
      err.hidden = true;
      if (!/^\d{6}$/.test(codigo)) { err.textContent = "Digite os 6 dígitos."; err.hidden = false; return; }
      try { await desafiarLogin(codigo); fechar(true); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    });
  });
  return _desafioAberto;
}

function traduz(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid") && m.includes("code")) return "Código incorreto. Confira no app autenticador e tente de novo.";
  if (m.includes("expired")) return "O código expirou. Gere um novo no app e tente de novo.";
  if (m.includes("mfa") && m.includes("disabled")) return "A verificação em duas etapas não está habilitada neste ambiente. Fale com o suporte.";
  if (m.includes("rate")) return "Muitas tentativas. Aguarde um instante.";
  return msg || "Falha na verificação em duas etapas.";
}
