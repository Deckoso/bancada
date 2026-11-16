# Bancada no Windows

A partir da versão 0.7 a Bancada também roda no Windows 10 (versão 1809 ou mais nova) e no Windows 11, em PCs de 64 bits (x64).
Este guia é da **0.8**: atualização automática, voz, recorte de tela e hooks mais leves.

> **Tem a 0.7.1 (ou 0.7.0) instalada?** Ela ainda não sabe se atualizar. Instale a **0.8.0 por cima, uma última vez**:
> baixe o `Bancada-Setup-0.8.0-windows-x64.exe`, feche a Bancada (ícone ao lado do relógio → **Sair**) e rode o
> instalador. Projetos, notas, terminais e ajustes continuam (ficam em `%APPDATA%\Bancada`, fora do app). Da 0.8.0 em
> diante ela se atualiza sozinha.

## Instalar

1. Baixe `Bancada-Setup-<versão>-windows-x64.exe` na página de [versões](https://github.com/Deckoso/bancada/releases).
2. Dê dois cliques no arquivo. A instalação é só para o seu usuário, não pede senha de administrador e termina sozinha. A Bancada abre no fim.
3. **"O Windows protegeu o computador"** (SmartScreen, tela azul): esse aviso aparece porque a Bancada ainda não tem
   certificado de assinatura (custa caro e é anual). Clique no link **Mais informações** e depois no botão
   **Executar assim mesmo**. Ele só aparece na primeira vez.
   - **Controle Inteligente de Aplicativos** (Windows 11, em Segurança do Windows → Controle de aplicativos e navegador):
     se estiver **Ativado**, ele bloqueia programas sem assinatura sem oferecer "Executar assim mesmo". Nesse caso a
     Bancada não instala nesse PC enquanto ele estiver ligado; desligá-lo é decisão de quem cuida do PC (depois de
     desligado, o Windows não deixa religar sem reinstalar). No modo **Avaliação** ou **Desativado**, segue o passo acima.
   - Para conferir o arquivo antes: `certutil -hashfile Bancada-Setup-<versão>-windows-x64.exe SHA256` no PowerShell e
     compare com o `SHA256SUMS.txt` da mesma página.
4. Ficam um atalho na Área de Trabalho e outro no menu Iniciar. A Bancada é instalada em `%LOCALAPPDATA%\Programs\Bancada`, e os seus dados ficam em `%APPDATA%\Bancada`.

Para desinstalar, vá em **Configurações → Aplicativos → Bancada → Desinstalar**. Os seus dados (projetos, notas) continuam em `%APPDATA%\Bancada`. Para apagar tudo, apague também essa pasta.

## Atualização automática (0.8)

- A Bancada procura versão nova **1× por dia** (e quando você clica em **Ajustes → Atualização → Procurar atualização**).
- Achou: baixa **em segundo plano** e mostra na lateral *"Nova versão 0.8.x — instala quando você fechar"*.
- **Instala só quando você sai da Bancada** (ícone ao lado do relógio → **Sair**). A instalação é silenciosa e por cima;
  na próxima vez que abrir, já é a versão nova. Nada é interrompido no meio do trabalho, e os dados continuam.
- Segurança: só fala com o GitHub (saída HTTPS; nenhuma porta aberta). O `latest.yml` vem **assinado** (Ed25519, arquivo
  `latest.yml.sig`) e a Bancada confere com a chave fixa no app antes de aceitar a versão; depois do download, confere o
  **SHA-512** do instalador contra esse `latest.yml` assinado e só então instala ao sair. Sem assinatura válida ou com
  hash diferente: não instala e apaga o arquivo. **Nunca** aceita versão mais velha que a instalada. O instalador não tem
  certificado do Windows; a assinatura do `latest.yml` + o hash são a garantia.
- Para desligar: desmarque **Procurar e baixar sozinha** em **Ajustes → Atualização**. Dá para atualizar à mão a qualquer
  momento rodando o instalador novo por cima.

## Conectar uma IA

**Ajustes → Assistentes de IA → Instalar** e depois **Entrar na minha conta**, igual ao Mac. A Bancada usa os instaladores oficiais para Windows:

| IA | Instalador | Onde fica |
|---|---|---|
| Claude | `https://claude.ai/install.ps1` | `%USERPROFILE%\.local\bin\claude.exe` |
| Codex | `https://chatgpt.com/codex/install.ps1` | onde o instalador da OpenAI puser (a Bancada procura nos lugares conhecidos) |
| Google (agy) | `https://antigravity.google/cli/install.ps1` | `%LOCALAPPDATA%\agy\bin\agy.exe` |

**Recomendado:** instale também o [Git para Windows](https://git-scm.com/downloads/win). Com ele o Claude roda os comandos pelo Git Bash, como no Mac, e as abas **Arquivos** e **Mudanças** mostram o git. Sem ele o Claude usa o PowerShell, o que também funciona.

## Voz no terminal 🎤 (0.8)

Segure o 🎤 no cabeçalho do terminal (ou **Ctrl+Shift+M**), fale e solte: o texto aparece no terminal **sem Enter**.
Um toque liga/desliga a gravação; **Esc** cancela. Serve para o Claude, o Codex ou qualquer programa do terminal.

- O reconhecimento é o whisper.cpp **no próprio PC**: na primeira vez, **Ajustes → Voz no terminal → Baixar voz (≈ 550 MB)**.
  Depois funciona sem internet; o áudio é apagado em seguida.
- **Runtime do Visual C++:** o motor precisa do "Microsoft Visual C++ Redistributable (x64)", que muitos PCs já têm. A
  Checagem dos Ajustes confere e, se faltar, mostra o link do instalador oficial da Microsoft
  (`https://aka.ms/vs/17/release/vc_redist.x64.exe`). Instale e clique em **Testar**.
- **Velocidade:** no Windows o motor usa só o processador. Num PC comum (i5/Ryzen 5 recente) espere **2–5 s** por frase de
  ~10 s (estimativa, ainda não medida num PC real); a Checagem mede no seu PC. Se ficar lento, troque o **Modelo** para
  **Rápido, menos preciso** (erra mais os termos técnicos).
- Microfone negado? **Configurações → Privacidade e segurança → Microfone**: ligue "Acesso ao microfone" e "Permitir que
  aplicativos da área de trabalho acessem o microfone".

## Recorte de tela 📷 (0.8)

Clique em 📷 no cabeçalho do terminal (ou **Ctrl+Shift+R**): abre a **Ferramenta de Captura** do Windows. Recorte a parte
da tela que quer mostrar. A Bancada pega a imagem da área de transferência (espera até 30 s, com **Cancelar** na tela),
mostra uma prévia e, em **Enviar**, salva em `%APPDATA%\Bancada\anexos` e põe o caminho no terminal — sem passar pela
Área de Trabalho. Efeito colateral: o recorte fica também na sua área de transferência, como em qualquer recorte do Windows.

> **Cópias fora da Bancada:** a Ferramenta de Captura do Windows 11 pode **guardar sozinha uma cópia** de cada recorte em
> **Imagens\Capturas de Tela** (que às vezes entra no backup do OneDrive), e o recorte também fica no **histórico da área
> de transferência** (Win+V) se ele estiver ligado. Essas cópias não são apagadas pela Bancada (a limpeza de 14 dias vale
> só para `anexos`). Para evitar: Ferramenta de Captura → **Configurações** → desligue "Salvar capturas de tela
> automaticamente"; e, se quiser, **Configurações → Sistema → Área de transferência** → desligue o histórico.
No celular, o 📷 do terminal abre a câmera ou a galeria e a foto vai para o terminal do PC.

## Hooks mais leves (0.8)

Para mostrar o estado de cada IA (trabalhando, esperando você, terminou) e o Escritório, o Claude avisa a Bancada a cada
passo. Na 0.7 cada aviso abria um PowerShell (medido como referência: ~0,3 s e ~110 MB por vez; o modo leve, ~0,06 s e ~13 MB). Na 0.8 o aviso é um `cmd.exe` curto que roda a
própria Bancada em modo leve (`hook.cmd`, gerado em `%APPDATA%\Bancada\hooks`), bem mais rápido e leve. Nada é escrito
nas configurações do Claude: os hooks vão só nos terminais abertos pela Bancada. (Reserva, se algo der errado no seu PC:
variável de ambiente `BANCADA_HOOKS_PS=1` volta ao PowerShell.)

## O que muda em relação ao Mac

| No Mac | No Windows |
|---|---|
| ⌘1 … ⌘5 (projeto em foco) | Ctrl+1 … Ctrl+5 |
| ⌘T (novo terminal) | Ctrl+Shift+T |
| ⌘J (Hoje) | Ctrl+Shift+J |
| ⌘\\ (dividir a tela) | Ctrl+Shift+\\ |
| ⌘↩ (salvar nota/prompt) | Ctrl+Enter |
| ⌥Space (anotar de qualquer lugar) | Alt+Espaço |
| ⌘⇧M (voz) | Ctrl+Shift+M |
| ⌘⇧R (recorte de tela) | Ctrl+Shift+R |
| ⌘C / ⌘V no terminal | **Ctrl+C copia se houver texto selecionado**; sem seleção, interrompe, como sempre. Ctrl+V cola. Ctrl+Shift+C também copia |
| ⌘K limpa o terminal | Ctrl+Shift+K |
| Terminal: zsh | Terminal: PowerShell |
| Finder / Safari | Explorador de Arquivos / navegador padrão |

Ctrl+T, Ctrl+J, Ctrl+F e Ctrl+R sozinhos continuam com o terminal, porque o Claude usa esses atalhos.

Fechar a janela não fecha a Bancada: ela continua no ícone ao lado do relógio, com os terminais rodando. Para sair de verdade, clique com o botão direito nesse ícone e escolha **Sair**.

## Limitações conhecidas (0.8)

- **Resposta de cartão depois que a conversa acabou:** no Mac, se o Claude que perguntou já fechou, a resposta é colada no terminal quando ele ainda é o programa aberto ali. No Windows não dá para saber com segurança qual programa está em primeiro plano, então a Bancada **não cola nada** e avisa. Responder com o Claude aberto funciona normalmente.
- **Acesso pelo celular:** funciona pelo Tailscale, como no Mac. Na primeira vez em que você ligar, o Firewall do Windows pergunta se a Bancada pode receber conexões. Ela só escuta no endereço do Tailscale.
- **Recorte de tela:** a Ferramenta de Captura não avisa a Bancada quando você cancela; ela espera até 30 s (ou o seu **Cancelar**).
- **Microfone no celular:** o navegador do celular só libera o microfone em HTTPS; pelo Tailscale a voz fica só no computador.
- **Ainda não testado num PC real:** tempo da voz, `hook.cmd` com nome de usuário acentuado, Controle Inteligente de Aplicativos e a atualização 0.8.0 → 0.8.1. Se algo falhar, **Ajustes → Problemas → Relatar problema**.

## Gerar o instalador (para quem desenvolve)

Dá para gerar no Mac ou no próprio Windows, com Node.js 20+:

```bash
npm ci --ignore-scripts      # o Windows usa os binários prontos do node-pty e do better-sqlite3
npm run dist:win             # → dist-win/: .exe + .exe.blockmap + latest.yml + SHA256SUMS.txt
npm run release:pack         # (depois do dist:mac também) junta em release/ só o que vai para a Release e assina os .yml
```

O `latest.yml`, o `latest.yml.sig` e o `.blockmap` são o que a atualização automática lê: sobem para a Release junto com o `.exe` (sem o `.sig`, ninguém atualiza). A chave que assina fica só na máquina de quem publica (`~/.config/bancada-assinatura/atualizacao-ed25519.pem`), nunca no repositório. O motor de voz vem do zip oficial do whisper.cpp, conferido por SHA-256 fixo. O instalador sai sem assinatura. Os módulos nativos (terminal e banco) já vêm compilados para Windows dentro dos pacotes, então não é preciso ter Visual Studio.
