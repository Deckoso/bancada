# Bancada no Windows

A partir da versão 0.7 a Bancada também roda no Windows 10 (versão 1809 ou mais nova) e no Windows 11, em PCs de 64 bits (x64).

## Instalar

1. Baixe `Bancada-Setup-<versão>-windows-x64.exe` na página de [versões](https://github.com/Deckoso/bancada/releases).
2. Dê dois cliques no arquivo. A instalação é só para o seu usuário, não pede senha de administrador e termina sozinha. A Bancada abre no fim.
3. **"O Windows protegeu o computador"**: esse aviso aparece porque a Bancada ainda não tem certificado de assinatura (custa caro e é anual). Clique em **Mais informações → Executar assim mesmo**. Ele só aparece na primeira vez.
4. Ficam um atalho na Área de Trabalho e outro no menu Iniciar. A Bancada é instalada em `%LOCALAPPDATA%\Programs\Bancada`, e os seus dados ficam em `%APPDATA%\Bancada`.

Para desinstalar, vá em **Configurações → Aplicativos → Bancada → Desinstalar**. Os seus dados (projetos, notas) continuam em `%APPDATA%\Bancada`. Para apagar tudo, apague também essa pasta.

## Conectar uma IA

**Ajustes → Assistentes de IA → Instalar** e depois **Entrar na minha conta**, igual ao Mac. A Bancada usa os instaladores oficiais para Windows:

| IA | Instalador | Onde fica |
|---|---|---|
| Claude | `https://claude.ai/install.ps1` | `%USERPROFILE%\.local\bin\claude.exe` |
| Codex | `https://chatgpt.com/codex/install.ps1` | onde o instalador da OpenAI puser (a Bancada procura nos lugares conhecidos) |
| Google (agy) | `https://antigravity.google/cli/install.ps1` | `%LOCALAPPDATA%\agy\bin\agy.exe` |

**Recomendado:** instale também o [Git para Windows](https://git-scm.com/downloads/win). Com ele o Claude roda os comandos pelo Git Bash, como no Mac, e as abas **Arquivos** e **Mudanças** mostram o git. Sem ele o Claude usa o PowerShell, o que também funciona.

## O que muda em relação ao Mac

| No Mac | No Windows |
|---|---|
| ⌘1 … ⌘5 (projeto em foco) | Ctrl+1 … Ctrl+5 |
| ⌘T (novo terminal) | Ctrl+Shift+T |
| ⌘J (Hoje) | Ctrl+Shift+J |
| ⌘\\ (dividir a tela) | Ctrl+Shift+\\ |
| ⌘↩ (salvar nota/prompt) | Ctrl+Enter |
| ⌥Space (anotar de qualquer lugar) | Alt+Espaço |
| ⌘C / ⌘V no terminal | **Ctrl+C copia se houver texto selecionado**; sem seleção, interrompe, como sempre. Ctrl+V cola. Ctrl+Shift+C também copia |
| ⌘K limpa o terminal | Ctrl+Shift+K |
| Terminal: zsh | Terminal: PowerShell |
| Finder / Safari | Explorador de Arquivos / navegador padrão |

Ctrl+T, Ctrl+J, Ctrl+F e Ctrl+R sozinhos continuam com o terminal, porque o Claude usa esses atalhos.

Fechar a janela não fecha a Bancada: ela continua no ícone ao lado do relógio, com os terminais rodando. Para sair de verdade, clique com o botão direito nesse ícone e escolha **Sair**.

## Limitações conhecidas (0.7)

- **Resposta de cartão depois que a conversa acabou:** no Mac, se o Claude que perguntou já fechou, a resposta é colada no terminal quando ele ainda é o programa aberto ali. No Windows não dá para saber com segurança qual programa está em primeiro plano, então a Bancada **não cola nada** e avisa. Responder com o Claude aberto funciona normalmente.
- **Acesso pelo celular:** funciona pelo Tailscale, como no Mac. Na primeira vez em que você ligar, o Firewall do Windows pergunta se a Bancada pode receber conexões. Ela só escuta no endereço do Tailscale. Algumas mensagens da página do celular ainda dizem "Mac".
- **Sem atualização automática:** para atualizar, baixe o instalador novo e rode-o por cima. Os dados continuam.

## Gerar o instalador (para quem desenvolve)

Dá para gerar no Mac ou no próprio Windows, com Node.js 20+:

```bash
npm ci --ignore-scripts      # o Windows usa os binários prontos do node-pty e do better-sqlite3
npm run dist:win             # → dist-win/Bancada-Setup-<versão>-windows-x64.exe
```

O instalador sai sem assinatura. Os módulos nativos (terminal e banco) já vêm compilados para Windows dentro dos pacotes, então não é preciso ter Visual Studio.
