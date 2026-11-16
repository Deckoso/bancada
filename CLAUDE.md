# CLAUDE.md — Bancada

Este repositório tem **mais de uma pessoa** mexendo, cada uma com o próprio Claude. Este arquivo é lido por todos os
Claudes que trabalham aqui. As regras abaixo existem para ninguém trabalhar às cegas sobre a mudança do outro.

## Antes de começar (sempre)

1. `git fetch origin` e `git status`. Se o seu branch estiver atrás do `main`, atualize antes de editar.
2. Leia as **últimas entradas de [`docs/DIARIO.md`](docs/DIARIO.md)**. A mais nova fica no topo. Ali está o que a outra pessoa mudou, o
   que ficou pela metade e o que ela pediu para revisar.
3. `git log --oneline -15 origin/main` para conferir o que entrou desde a última entrada do diário.
4. Se a tarefa mexe numa área citada como "em andamento" no diário, combine antes de editar: escreva uma entrada
   avisando ou abra uma issue.

## Ao terminar (sempre)

1. Acrescente uma entrada **no topo** de `docs/DIARIO.md`, no formato do próprio arquivo: data, quem, o que mudou, como
   foi testado, o que ficou pendente e o que a outra pessoa precisa saber ou revisar.
2. Se mudou algo que o usuário vê, acrescente o item em `CHANGELOG.md`, na seção da próxima versão.
3. Commit com mensagem clara em português (`feat: …`, `fix: …`, `docs: …`).

## Como as mudanças entram no `main`

- Trabalhe num **branch próprio** (`nome/assunto`, ex.: `joao/atalhos-windows`) e abra um **Pull Request** para o `main`.
- A outra pessoa revisa. O merge vai por **squash**, com uma mensagem que resume o PR.
- Nada de `push --force` no `main`.
- **Release e versão** (tag, instaladores e manifestos de atualização) são publicadas só pelo dono do repositório, porque
  a atualização automática exige a assinatura dele. Quem colabora não cria Release, não muda a versão no `package.json` e
  não mexe na chave pública de atualização em `app/main/updater.js`. Se uma mudança precisar de versão nova, peça no diário.

## Regras do código (valem para todos)

- **Nada pessoal ou secreto no repositório:**
  - nome de pasta ou de máquina de ninguém, IP da rede de casa ou do trabalho, e-mail, token, chave;
  - dado real em teste (use dado fictício).

  O repositório é público.
- **Testes verdes antes do PR:**
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test test/unit/*.test.js`
  (no Windows: `set ELECTRON_RUN_AS_NODE=1` e depois `node_modules\.bin\electron --test test\unit\*.test.js`).

  O `syntax.test.js` compila os scripts da tela: um erro de sintaxe ali deixa o app inteiro travado.
- **Mac e Windows:**
  - toda diferença entre os dois sistemas fica em `app/main/platform.js`;
  - na tela, textos com Finder/Explorador, ⌘/Ctrl e Mac/PC passam por `window.UI.T` (`app/renderer/dom.js`). O teste
    `textos-sistema.test.js` confere isso.
- **Canais IPC:** todo `handle('…')` novo em `app/main/index.js` precisa ser classificado em `app/main/remote.js`, em
  `BLOCKED` (o celular não pode) ou em `REMOTE_OK` (o celular pode). Um teste falha se faltar. Regra: o celular nunca
  pode mais do que digitar no terminal.
- **Segurança:**
  - nada de shell com texto interpolado: use `execFile`/`spawn` com uma lista de argumentos;
  - todo caminho de arquivo vindo da tela ou do celular passa pelas guardas que já existem (`files.resolveInside`, `links`,
    `platform.isNetworkPath`);
  - downloads só com hash fixo no código;
  - mudanças em atualização, acesso remoto, arquivos ou hooks: escreva no diário **"pedir revisão de segurança"**.
- **Memória:** nada de laço ou evento que se re-dispare. Animação só com a aba visível. Timers com fim.
- Binário compilado não entra no git: ele é gerado no build a partir de fonte com hash fixo.

## Mapa rápido

| Onde | O quê |
|---|---|
| `app/main/index.js` | processo principal: janelas, canais IPC, ligação dos módulos |
| `app/main/pty-manager.js`, `engines.js` | terminais e como cada IA é aberta |
| `app/main/hooks.js`, `activity.js`, `project-pulse.js` | estado de cada Claude, segundo plano e Escritório |
| `app/main/remote.js` | acesso pelo celular (só Tailscale) |
| `app/main/updater.js` | atualização automática (manifesto assinado) |
| `app/main/voice.js`, `screen-shot.js`, `attachments.js` | voz, recorte de tela, imagens |
| `app/renderer/` | tela (sem framework; `dom.js` tem `h()` e `UI.T`) |
| `test/unit/`, `test/corpus/` | testes e cenários do Escritório |
| `docs/` | guias de uso, Windows, passar para outra pessoa e **DIARIO.md** |

Comandos: `npm start` (rodar), `npm test`, `npm run dist:mac` / `npm run dist:win` (instaladores; precisam do
`aurora-tokens.css`, veja os scripts).
