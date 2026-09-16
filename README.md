# Resumo Matinal — podcast

Versão em áudio do e-mail "Resumo matinal". O Apps Script (agenda + notícias + e-mail) dispara
um GitHub Action que escreve o roteiro com Gemini, gera a voz com Gemini TTS, converte para MP3
e publica um feed de podcast no GitHub Pages. O Spotify lê esse feed; o Google Home toca o Spotify.

```
Apps Script (4h) ──e-mail──▶ você
      └─ repository_dispatch ─▶ Action ─▶ gh-pages: feed.xml + ep/AAAA-MM-DD.mp3 ─▶ Spotify ─▶ Google Home
```

Custo: Gemini Flash-Lite e Gemini 2.5 Flash TTS têm free tier (1 uso/dia cabe folgado).
GitHub Actions/Pages: grátis em repositório público.

> **O podcast é público.** Qualquer pessoa pode achá-lo no Spotify. Por isso o padrão é narrar
> **só as notícias** — a agenda fica só no e-mail (`AGENDA_NO_AUDIO: false` no Apps Script).

## Instalação (uma vez, ~15 min)

### 1. Repositório no GitHub
1. Crie um repositório **público** chamado `resumo-matinal-podcast` (GitHub Pages grátis exige público).
2. Envie o conteúdo desta pasta (a subpasta `apps-script/` é só cópia de referência, pode ir junto):
   ```bash
   cd ~/resumo-matinal-podcast && git init -b main && git add . && git commit -m "Resumo Matinal podcast" && git remote add origin https://github.com/SEU_USUARIO/resumo-matinal-podcast.git && git push -u origin main
   ```
3. **Settings → Secrets and variables → Actions**
   - aba *Secrets* → `GEMINI_API_KEY` = sua chave do AI Studio
   - aba *Variables* → `OWNER_EMAIL` = seu e-mail (o Spotify manda o código de verificação do feed para ele)
   - opcionais em *Variables*: `VOZ` (`Charon` = padrão masc. informativo; `Kore` fem. firme; `Aoede`, `Puck`…), `MANTER_EPISODIOS` (padrão 14)
4. **Actions → "Gerar episódio do Resumo Matinal" → Run workflow**. Gera um episódio de teste e cria a branch `gh-pages`.
5. **Settings → Pages → Source: Deploy from a branch → `gh-pages` / `/ (root)` → Save.**
   Em ~1 min: feed em `https://SEU_USUARIO.github.io/resumo-matinal-podcast/feed.xml`
   e página com player em `https://SEU_USUARIO.github.io/resumo-matinal-podcast/`.

### 2. Apps Script
1. Cole `apps-script/resumo-matinal.gs` no projeto, substituindo tudo.
2. Em `CONFIG.PODCAST` preencha `GITHUB_REPO` e `SITE_URL` com seu usuário.
3. Token do GitHub: **foto do perfil → Settings → Developer settings → Personal access tokens → Fine-grained → Generate new token**.
   Repository access: *Only select repositories* → `resumo-matinal-podcast`. Permissions: **Contents → Read and write**. Copie o token.
4. No Apps Script: **Configurações do projeto (engrenagem) → Propriedades do script → Adicionar propriedade**:
   `GITHUB_TOKEN` = o token. (A chave Gemini **não** vai no Apps Script — fica só no GitHub.)
5. Rode `testarPodcast` → acompanhe em *Actions*; em ~3 min o episódio de hoje aparece no site. Depois rode `configurarGatilho`.

### 3. Spotify
1. https://creators.spotify.com → entrar com sua conta → **Add your podcast → I have an RSS feed** → cole a URL do `feed.xml`.
2. O Spotify envia um código para o `OWNER_EMAIL`; confirme.
3. Aprovação: de minutos a algumas horas. Depois copie o link do programa e cole em `CONFIG.PODCAST.SPOTIFY_URL` (vira link no botão do e-mail).

Novos episódios: o Spotify relê o feed periodicamente (em geral < 1 h). Se às 7h o episódio de hoje
ainda não estiver lá, adiante o gatilho: em `configurarGatilho` troque `.atHour(4)` por `.atHour(3)`.

### 4. Google Home (rotina "Bom dia")
App Google Home → **Automações → Bom dia → Adicionar ação → "Tentar adicionar sua própria"** e digite:

> tocar o podcast Resumo Matinal no Spotify

Deixe essa ação por último (depois de clima etc.). O Assistente toca o episódio mais recente.
Requisito: Spotify vinculado ao Google Home (Configurações → Música → Spotify).

## Manutenção
- *Actions* mostra cada geração; se falhar, o motivo está no log do passo "Gerar roteiro, áudio e feed".
- A branch `gh-pages` é recriada todo dia com 1 commit e só os últimos `MANTER_EPISODIOS` — o repositório não cresce.
- Roteiros ficam em `ep/AAAA-MM-DD.txt`, para conferir o que foi lido.
- Trocar de modelo: variáveis `MODELO_TEXTO` / `MODELO_TTS` no repositório (padrões: `gemini-3.5-flash-lite` e `gemini-2.5-flash-preview-tts`).
