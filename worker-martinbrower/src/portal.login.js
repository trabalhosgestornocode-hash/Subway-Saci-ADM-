// Login no Portal Martin Brower.
//
// REGRA ABSOLUTA: nenhuma tentativa de contornar CAPTCHA ou qualquer outro
// mecanismo de segurança. Se um desafio aparecer, o worker PARA e devolve
// MARTIN_BROWER_MANUAL_VERIFICATION_REQUIRED para que um humano resolva no
// portal oficial.
//
// A senha é usada UMA vez, para preencher o formulário, e descartada logo em
// seguida — a partir daí a autenticação vive nos cookies do browser context.

import { PORTAL_URL, validarAlvoDoPortal, ehPortalReal } from "./config.js";
import { primeiroVisivel, existeSinal } from "./portal.selectors.js";
import { erro, CODIGOS } from "./errors.js";
import { descartarSenha, atualizar, STATUS } from "./sessions.js";
import { log, cronometro } from "./logsafe.js";

/**
 * Abre o portal e faz login.
 * @returns {Promise<{precisa2fa: boolean}>}
 */
export async function fazerLogin(sessao) {
  const page = sessao.page;
  const t = cronometro("login.concluido", { remoteSessionId: sessao.remoteSessionId });

  // SEGUNDA barreira, no instante da navegação. A primeira está em
  // validarConfig(), na subida. Duas porque a variável de ambiente pode mudar
  // em runtime e porque esta é a última linha antes de tocar a rede.
  try {
    validarAlvoDoPortal();
  } catch (e) {
    log("error", "portal.acesso_bloqueado", {
      motivo: "MB_ALLOW_REAL_PORTAL ausente", ehPortalReal: ehPortalReal(),
    });
    throw erro(CODIGOS.INDISPONIVEL, e.message);
  }

  atualizar(sessao, { status: STATUS.AUTENTICANDO, etapa: "Abrindo Portal Martin Brower" });
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });

  // Um CAPTCHA já na abertura significa que o portal está desconfiado do IP —
  // parar aqui é mais honesto que tentar prosseguir e travar a conta.
  if (await existeSinal(page, "sinalCaptcha", { timeout: 3000 })) {
    throw erro(CODIGOS.VERIFICACAO_MANUAL, "captcha na tela de login");
  }

  atualizar(sessao, { etapa: "Aguardando autenticação" });

  const campoUsuario = await primeiroVisivel(page, "campoUsuario");
  const campoSenha = await primeiroVisivel(page, "campoSenha");
  if (!campoUsuario || !campoSenha) {
    // Não sabemos se o portal mudou ou se já estávamos logados — conferimos.
    if (await existeSinal(page, "sinalAutenticado", { timeout: 2000 })) {
      log("info", "login.ja_autenticado", { remoteSessionId: sessao.remoteSessionId });
      t.fim();
      return { precisa2fa: false };
    }
    throw erro(CODIGOS.INDISPONIVEL, "tela de login nao reconhecida (seletores podem estar desatualizados)");
  }

  const { usuario, senha } = sessao._credenciais ?? {};
  if (!usuario || !senha) throw erro(CODIGOS.AUTH_FAILED, "credenciais ausentes na sessao");

  await campoUsuario.fill(usuario);
  await campoSenha.fill(senha);

  // A senha já está no formulário: não precisamos mais dela em memória.
  descartarSenha(sessao);

  const botao = await primeiroVisivel(page, "botaoEntrar");
  if (!botao) throw erro(CODIGOS.INDISPONIVEL, "botao de login nao encontrado");

  await Promise.all([
    // O portal pode navegar OU responder por XHR — não exigimos navegação.
    page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    botao.click(),
  ]);

  return await classificarResultado(sessao, t);
}

/**
 * Decide o que aconteceu depois do submit. A ordem importa: erros explícitos
 * antes de sucesso, para não confundir uma tela que contém as duas coisas.
 */
async function classificarResultado(sessao, cronometroLogin) {
  const page = sessao.page;

  if (await existeSinal(page, "sinalCaptcha", { timeout: 2000 })) {
    throw erro(CODIGOS.VERIFICACAO_MANUAL, "captcha apos submit");
  }
  if (await existeSinal(page, "sinalBloqueio", { timeout: 1500 })) {
    throw erro(CODIGOS.ACESSO_NEGADO, "conta bloqueada ou tentativas excedidas");
  }
  if (await existeSinal(page, "sinalCredencialInvalida", { timeout: 1500 })) {
    throw erro(CODIGOS.AUTH_FAILED, "credenciais recusadas pelo portal");
  }
  if (await existeSinal(page, "sinalDois2fa", { timeout: 3000 })) {
    atualizar(sessao, { status: STATUS.AGUARDANDO_CODIGO, etapa: "Aguardando código de segurança" });
    log("info", "login.2fa_requerido", { remoteSessionId: sessao.remoteSessionId });
    cronometroLogin.fim({ resultado: "2fa" });
    return { precisa2fa: true };
  }
  if (await existeSinal(page, "sinalAutenticado", { timeout: 5000 })) {
    atualizar(sessao, { status: STATUS.AUTENTICADO, etapa: "Sessão autenticada" });
    cronometroLogin.fim({ resultado: "autenticado" });
    return { precisa2fa: false };
  }

  // Nenhum sinal reconhecido. Não adivinhamos: falhar aqui é melhor que seguir
  // e produzir um catálogo vazio que pareceria legítimo.
  throw erro(CODIGOS.INDISPONIVEL, "estado pos-login nao reconhecido");
}

/** Envia o código 2FA que o backend recebeu do usuário. */
export async function enviarCodigo2fa(sessao) {
  const page = sessao.page;
  const codigo = sessao._codigo2fa;
  if (!codigo) throw erro(CODIGOS.DOIS_FA_INVALIDO, "codigo ausente na sessao");

  const campo = await primeiroVisivel(page, "campoCodigo2fa");
  if (!campo) throw erro(CODIGOS.INDISPONIVEL, "campo de codigo 2FA nao encontrado");

  await campo.fill(codigo);
  sessao._codigo2fa = null;   // usado uma vez, descartado imediatamente

  const botao = await primeiroVisivel(page, "botaoConfirmarCodigo");
  if (!botao) throw erro(CODIGOS.INDISPONIVEL, "botao de confirmacao do 2FA nao encontrado");

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    botao.click(),
  ]);

  if (await existeSinal(page, "sinalDois2fa", { timeout: 2500 })) {
    // Ainda pedindo o código = o que foi digitado não serviu.
    throw erro(CODIGOS.DOIS_FA_INVALIDO, "portal continua solicitando o codigo");
  }
  if (await existeSinal(page, "sinalBloqueio", { timeout: 1500 })) {
    throw erro(CODIGOS.ACESSO_NEGADO, "bloqueio apos 2FA");
  }
  if (!(await existeSinal(page, "sinalAutenticado", { timeout: 5000 }))) {
    throw erro(CODIGOS.DOIS_FA_INVALIDO, "autenticacao nao confirmada apos o codigo");
  }

  atualizar(sessao, { status: STATUS.AUTENTICADO, etapa: "Sessão autenticada" });
  log("info", "login.2fa_confirmado", { remoteSessionId: sessao.remoteSessionId });
}
