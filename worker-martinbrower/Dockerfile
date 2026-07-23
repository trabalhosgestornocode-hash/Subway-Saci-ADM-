# =====================================================================
# Worker Playwright — Martin Brower
# =====================================================================
# Roda SEPARADO do backend principal. O backend no Render nunca instala
# Playwright nem Chromium: ele tem 512 MB e um Chromium headless consome
# 300-500 MB só para abrir uma aba.
#
# A imagem oficial da Playwright já traz o Chromium e TODAS as bibliotecas de
# sistema que ele exige (fontes, libnss, libatk, libgbm...). Montar isso à mão
# sobre node:20-slim daria uma imagem parecida em tamanho e muito mais frágil.
#
# ⚠️ A tag da imagem e a versão do pacote `playwright` em package.json DEVEM
#    ser a mesma (1.49.1). Versões diferentes = "browser not found" em runtime.
# =====================================================================
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV NODE_ENV=production \
    PORT=8080 \
    # O browser já vem na imagem; impedir novo download economiza ~150 MB
    # e evita rede durante o build.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Sem isto o Node não sabe o teto de memória do container e o GC roda
    # tarde demais, causando OOM antes da hora com o Chromium ao lado.
    NODE_OPTIONS=--max-old-space-size=512

WORKDIR /app

# Dependências em camada própria: mudar código não reinstala tudo.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# A imagem base já provê o usuário sem privilégio `pwuser`.
USER pwuser

EXPOSE 8080

# Sem HEALTHCHECK do Docker de propósito: o Cloud Run faz o probe por HTTP
# em /health e um healthcheck interno só gastaria CPU.
CMD ["node", "src/server.js"]
