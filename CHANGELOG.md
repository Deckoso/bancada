# Novidades da Bancada

Versões mais novas no topo. Os arquivos de cada versão ficam na página de
[versões (Releases)](https://github.com/Deckoso/bancada/releases), com o `SHA256SUMS.txt` para conferir.

## 0.8.0 — 16/11/2026

> **Quem tem a 0.7.x (Windows ou Mac):** a 0.7 não sabe se atualizar. Instale a 0.8.0 **por cima, uma última vez**
> (Windows: feche a Bancada pelo ícone ao lado do relógio → Sair e rode o instalador; Mac: arraste a Bancada nova para
> Aplicativos e substitua). Projetos, notas e ajustes continuam. Da 0.8.0 em diante ela se atualiza sozinha.

**Instalar e atualizar**
- Atualização automática nos dois sistemas: procura 1× por dia (ou em **Ajustes → Atualização → Procurar atualização**),
  baixa em segundo plano, confere e avisa *"Nova versão 0.8.x — instala quando você fechar"*. Instala só ao sair; dá
  para desligar. Windows pelo electron-updater; Mac por um atualizador próprio que confere o SHA-512 e a assinatura do
  app novo (mesma identidade do instalado) antes de trocar. Nunca aceita versão mais velha; só fala com o GitHub.
- O aviso de versão nova (`latest.yml` / `latest-mac.yml`) vem **assinado** (Ed25519) e a Bancada confere com a chave
  fixa no app antes de aceitar; o arquivo baixado tem de ter o SHA-512 desse aviso assinado. Sem assinatura válida,
  não atualiza (fica no registro). Publicar uma Release sem a chave de quem assina não instala nada em ninguém.
- Mac **universal** (chip Apple e Intel, macOS 12+) em `.dmg` e `.zip`, assinado sempre com a mesma identidade: as
  permissões do Mac não precisam ser dadas de novo a cada versão.
- Release com `SHA256SUMS.txt`; o motor de voz é compilado da fonte oficial (Mac) ou vem do zip oficial conferido (Windows).

**Voz e imagem**
- 🎤 **Voz no terminal**: segure para falar, solte e o texto cai no terminal sem Enter; toque alterna; Esc cancela
  (⌘⇧M / Ctrl+Shift+M). Reconhecimento local (whisper.cpp), modelo baixado uma vez (≈ 550 MB), áudio apagado.
- 📷 **Recorte de tela** direto para o terminal (⌘⇧R / Ctrl+Shift+R), sem passar pela Área de Trabalho, com prévia
  Enviar/Cancelar. No celular, o 📷 abre a câmera ou a galeria e a foto vai para o terminal do computador.

**Escritório**
- Mostra tudo o que roda no projeto: tarefas em segundo plano, agentes e subagentes, monitores, terminais comuns
  (`npm run dev`, testes, build), servidor local e git. Pose "acompanhando · N" quando o turno acabou mas há coisas
  rodando; tarefa calada aparece como "rodando em silêncio", não "sem sinal". Codex e Google aparecem pelo terminal.

**Primeira abertura e ajuda**
- Acha projetos com git em Documentos, Área de Trabalho, Developer, Projects e repos; motor "Nenhum" por padrão.
- **Checagem** de cada IA (instalada → conectada → plano) com o conserto em português; sem plano do Claude, sugere o Codex.
- Resumo por IA vem desligado em instalação nova (a primeira abertura pergunta).
- **Relatar problema** (Ajustes → Problemas): copia um relatório curto, sem terminal, conversa ou senha. Registro de
  erros com tamanho limitado. Cartões curtos "Como foi a semana?" e "Travou?".
- **Medidor de limite** do Claude ("Limite 5 h · semana"), âmbar a partir de 80%, encadeado com a sua barra de status.

**Windows**
- Textos do Windows (sem "Finder", "⌘" ou "Mac" na tela).
- Hooks bem mais leves: `cmd.exe` + a própria Bancada em modo leve no lugar de um PowerShell por evento.
- A voz precisa do runtime do Visual C++ (a Checagem confere e mostra o link oficial).

**Segurança (revisão de 16/11)**
- **Barra de status encadeada:** a Bancada passa a encadear **só a barra do próprio usuário** (`~/.claude/settings.json`
  e `~/.claude/settings.local.json`). O `statusLine` que um projeto declara no `.claude/` da pasta dele **não roda mais**
  pela Bancada (um repositório baixado traria o próprio comando). Respeita o `disableAllHooks` do usuário, e uma barra que
  passa dos 2 s é encerrada junto com os processos filhos.

**Ainda não testado em máquina real (vai no próximo retorno):** atualização 0.8.0 → 0.8.1 nos dois sistemas, voz e
`hook.cmd` num PC Windows, Mac Intel físico.

## 0.7.1 — 14/11/2026

- Corrige a tela travada da 0.7.0 (erro de aspas no `app.js`) e acrescenta um teste que compila todos os scripts da tela.
- Segurança: origem das chamadas internas conferida também no Windows, caminho de rede recusado, aspas do PowerShell,
  git sem `fsmonitor`, navegação e revogação de aparelhos mais rígidas, markdown mais seguro; Electron 45.3.2 com
  proteções de execução (fuses) ligadas.

## 0.7.0 — 14/11/2026

- **A Bancada roda no Windows** 10 (1809+) e 11, x64: instalador por usuário (sem administrador), terminais em
  PowerShell, atalhos com Ctrl, instaladores oficiais das IAs (`.ps1`), hooks do Claude, acesso pelo celular via Tailscale.
- Guia em [docs/WINDOWS.md](docs/WINDOWS.md). Sem atualização automática nesta versão (chegou na 0.8.0).
