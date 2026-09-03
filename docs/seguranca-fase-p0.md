# Fase P0 de Segurança — hardening

Correções dos itens P0 da auditoria de 2026-09-03. Este documento cobre o que
exige atenção operacional (rollout de MFA, backup) e o que precisa ser feito
fora do código.

---

## MFA (verificação em duas etapas) para SuperAdmin e Painel Administrativo

### Estado atual (após esta fase)

O **suporte de backend está pronto e DORMENTE**:

- `requireAuth` lê o nível de garantia do JWT do Supabase e expõe em
  `req.user.aal` (`"aal1"` = só senha, `"aal2"` = senha + 2º fator),
  `req.user.amr` (métodos: `["password","totp"]`) e `req.user.mfaCadastrada`
  (a conta tem ao menos um fator TOTP verificado).
- `/api/v1/me` devolve esses campos (o frontend pode usar para oferecer o
  cadastro do 2º fator).
- Os routers `/plataforma/*` e `/administrativo/*` já têm o gate
  `exigirMfaSeExigido(...)` montado — **mas ele é no-op** enquanto
  `MFA_ENFORCE_SUPERADMIN` / `MFA_ENFORCE_PAINEL_ADM` não forem `"true"`.
- `requireAAL2` existe para rotas que um dia nasçam MFA-only (nenhuma hoje).

Nada muda no comportamento até as flags serem ligadas.

### O que falta (NÃO feito nesta fase — exige decisão de produto + ambiente de teste)

1. **Fluxo de enrollment no frontend.** O Supabase JS já expõe a API
   (`supabase.auth.mfa.enroll({ factorType: "totp" })` → QR code →
   `supabase.auth.mfa.challenge` → `supabase.auth.mfa.verify`). Precisa de:
   - uma tela "Configurar verificação em duas etapas" (mostra QR, pede o
     código de 6 dígitos, confirma);
   - no login, se a conta tem fator verificado e o AAL é `aal1`, pedir o
     código antes de liberar o app (`supabase.auth.mfa.challengeAndVerify`);
   - um aviso persistente para SuperAdmin / Painel Administrativo sem MFA
     (`req.user.mfaCadastrada === false`) até que cadastrem.
2. **Testar em um projeto Supabase real.** MFA depende de config do projeto
   (Authentication → MFA habilitado). Não foi possível validar aqui.

### Rollout seguro (ordem obrigatória)

> Ligar `MFA_ENFORCE_*` antes do passo 3 **tranca os administradores para fora**
> — o gate responde 401 e não há caminho de volta pela UI. O único resgate
> seria emitir um JWT AAL2 fora da aplicação ou remover a env var e
> redeployar.

1. **Deploy deste código** (flags ausentes/false). Nada muda.
2. **Habilitar MFA no projeto Supabase** e implementar o enrollment no
   frontend (item acima).
3. **Cada SuperAdmin e cada usuário do Painel Administrativo cadastra o TOTP**
   e passa a logar com AAL2. Confirmar via painel do SuperAdmin (lista de
   usuários) ou consultando `auth.mfa_factors` que **100%** dos privilegiados
   têm fator `verified`.
4. **Só então** definir no Render:
   - `MFA_ENFORCE_SUPERADMIN=true`
   - `MFA_ENFORCE_PAINEL_ADM=true`
5. Manter um SuperAdmin "quebra-vidro" documentado com MFA já cadastrado e
   credenciais guardadas em cofre, para o caso de alguém perder o
   authenticator.

### Rollback

Remover a env var (ou setar `false`) e redeployar. O gate volta a ser no-op
imediatamente (o valor é lido do ambiente na subida do processo).

---

## Backup / restauração do banco — DIAGNÓSTICO

**Status: NÃO COMPROVADO pelo código/CLI disponíveis nesta fase.**

O que dá para afirmar a partir do repositório:

- O banco é **Supabase** (Postgres gerenciado). O `render.yaml` só descreve o
  serviço web; o banco é externo.
- `database/migrations/` tem as 66 migrations versionadas e o `README`
  descreve a ordem — isso permite **reconstruir o schema**, não os dados.
- Existe `backend/backups/` no `.gitignore` ("dumps de produção com
  preços/insumos — não versionar") → sugere dumps manuais esporádicos, não um
  processo confiável.
- Nenhum script de backup/restore, política de retenção, ou runbook de
  desastre no repo.

### O que precisa ser verificado no painel do Supabase (fora do código)

| Pergunta | Onde |
|---|---|
| Qual plano? (Free não tem backup automático; Pro = diário 7 dias; Team/Ent = PITR) | Supabase → Project Settings → Billing |
| Backups automáticos estão ativos? Qual a retenção? | Supabase → Database → Backups |
| PITR disponível? Até quantos dias/segundos atrás? | Supabase → Database → Backups → Point in Time |
| Já foi feito um teste de restore? | (processo — provavelmente não) |

### Resposta às perguntas da auditoria

> **Se o banco fosse apagado hoje, qual seria o caminho de recuperação?**
> - Plano Pro+: restaurar o backup diário mais recente (ou PITR) pelo painel
>   do Supabase. Perda = até 24h (Pro) ou minutos (PITR).
> - Plano Free: **apenas** os dumps manuais em `backend/backups/`, se
>   existirem e estiverem atualizados. Perda potencial = semanas.

> **Perda máxima de dados?**
> **NÃO COMPROVADO.** Depende inteiramente do plano contratado, que não é
> verificável a partir do código.

### Ação recomendada (P0.11)

1. Confirmar o plano e a política de backup no painel do Supabase.
2. Se Free: **subir para Pro** antes de crescer, OU montar um cron externo
   (`pg_dump` → storage externo cifrado) com retenção ≥ 7 dias.
3. **Executar um teste de restore** num projeto Supabase separado e cronometrar
   (RTO) — documentar o procedimento passo a passo aqui.
4. Definir e documentar RPO/RTO aceitáveis para o negócio.

---

## XSS — auditoria dirigida (P0.7)

Foi feita uma auditoria **dirigida** (não linha a linha das ~290 chamadas a
`innerHTML`) dos sinks que renderizam dado vindo do banco / de arquivo
importado / do Agente:

| Sink | Helper | Veredito |
|---|---|---|
| Painel Administrativo — nomes de empresa/unidade/usuário (cross-tenant) | `realce()` (`painelAdmUi.js:313`) | escapa cada segmento antes do `<mark>` — **OK** |
| Painel Administrativo — PDF | `txt()` = `escapeHtml(limparTexto())` (`painelAdmPdf.js:81`) | **OK** |
| Seleção de empresa/unidade — nome, logo, cidade, motivo | `escapeHtml` em todos (`selecaoAmbiente.js`) | **OK** |
| Formulários do painel — value/placeholder/textarea | `campo`/`selecao`/`area` (`adminUi.js:197`) | escapam value/ph/rótulo — **OK** |
| Resposta do Agente Crescer | `renderizarMarkdownSeguro` (`markdown.js`) | `escapeHtml` ANTES de qualquer transformação; tags fixas, nunca atributos — **OK** (com testes) |
| Vendas — `nome_sw`/`codigo_sw`/`produto_nome` (vêm da planilha) | `escapeHtml` (`vendas.js:427,433,679,689`) | **OK** |
| Martin Brower — `descricao`/`grupo_descricao` do catálogo | `escapar` (`martinbrower.js:238,285`) | **OK** |
| Histórico de alterações de produto | `escapeHtml` em rótulo/valores/autor (`views.js:192`) | **OK** |

**Corrigido:** o único handler inline de todo o frontend —
`<a href="#" onclick="return false">` no rodapé "by atlaz.company"
(`index.html`) — virou `<span>` (era um link que não navegava; zero mudança
visual/comportamental). Era o único bloqueador de CSP em `script-src`.

**Conclusão:** não foi encontrado XSS armazenado/refletido confirmado. A
disciplina de `escapeHtml` é consistente (658 chamadas). O risco residual da
auditoria (XSS-01) era a ausência da CSP como rede de defesa — tratado abaixo.

Atributos estruturais (`id="${id}"`, `type="${tipo}"`, `data-produto="${uuid}"`)
não são escapados, mas vêm sempre de literais do código ou de UUIDs do banco,
nunca de texto livre — mesmo modelo de confiança do resto do código.

---

## CSP — pronta para enforce, virada pendente de staging (P0.8)

### O que foi feito

- Removido o único handler inline (acima) → `script-src` **já não precisa** de
  `'unsafe-inline'` (e nunca teve `'unsafe-eval'`).
- `img-src` já era `'self' data: blob: https:` — o `https:` é necessário para
  logos de empresa (URL arbitrária salva por empresa); imagens não executam.
- Recursos externos legítimos confirmados e todos já na CSP: `cdn.jsdelivr.net`
  (Chart.js, supabase-js), `fonts.googleapis.com` + `fonts.gstatic.com`
  (fontes), domínio do Supabase (`connect-src` https + wss),
  `portal.martinbrower.com.br` (`frame-src`).

### Por que NÃO foi ligada nesta fase

1. **Exige smoke em staging, tela por tela**, com o DevTools aberto — não é
   verificável sem um backend Supabase real e navegando o app inteiro.
2. **`style-src 'unsafe-inline'` continua necessário** — o app escreve
   `style="height:..."` / `width:...` / `background:...` em elementos gerados
   (barras de gráfico e de progresso). Trocar por nonce/hash é reescrita da
   camada de render — fora do escopo P0. Documentado como dívida consciente.
3. **Exportação de PDF do Painel Administrativo** (`painelAdmPdf.js`) monta um
   documento standalone com um `<script>` inline de paginação
   (`SCRIPT_PAGINADOR`), servido via `iframe srcdoc` — que **herda a CSP da
   página**. Com enforce, esse script é bloqueado e a paginação do PDF quebra
   (o PDF ainda sai, mas com quebras de página piores).

### Checklist para ligar `CSP_ENFORCE=true` (em staging primeiro)

1. Resolver o `<script>` do PDF: calcular `sha256` de `SCRIPT_PAGINADOR` e
   adicionar `'sha256-...'` a `script-src` **ou** mover a paginação para CSS
   Paged Media / um `.js` servido.
2. Deploy em staging com `CSP_ENFORCE=true`.
3. Navegar TODAS as áreas (login, seleção, cada módulo de tenant, Agente,
   Painel SuperAdmin, Painel Administrativo, exportar um PDF) com o DevTools →
   Console aberto. Zero violação de `script-src`.
4. Se aparecer violação legítima nova, adicionar a origem específica (nunca
   `*` nem `'unsafe-inline'` em script).
5. Só então `CSP_ENFORCE=true` em produção.

---

## Outras mudanças da Fase P0 (referência rápida)

| Item | Commit | Observação |
|---|---|---|
| xlsx vulnerável → SheetJS 0.20.3 oficial | `security(deps): replace vulnerable xlsx` | `package-lock` fixa `resolved`+`integrity`; `npm ci` no Render baixa o tarball exato |
| qs/body-parser DoS | `security(deps): pin qs 6.16.0 and body-parser 1.20.6` | via `overrides` — sem major |
| Rate limiting geral + PIN por conta/IP | `security(rate-limit): centralized abuse protection` | tudo por env `RATE_LIMIT_*`, defaults generosos |
| Teto do Agente Crescer | `security(agent): usage caps` | por conta (memória) + por org (agente_uso) |
| MFA dormente | `security(mfa): dormant AAL2 support` | este documento |
| CSP / XSS / headers | ver commits `security(xss)` / `security(headers)` | CSP **não** foi ligada em enforce nesta fase — ver o commit |
| Eventos de segurança | `security(audit): record security events` | usa a auditoria existente |
