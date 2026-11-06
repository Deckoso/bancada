---
description: Entrevista guiada (estilo Akinator) para descobrir o que construir — uma pergunta por vez, termina num resumo para a forja do blueprint
argument-hint: "[o pedido inicial, ex.: setor novo de almoxarifado]"
---

# Entrevista guiada — projeto ou setor novo

Pedido inicial do usuário: **$ARGUMENTS**
(Se estiver vazio, a primeira pergunta é "O que vamos criar?", com 3–4 palpites tirados do projeto em foco.)

**Objetivo:** juntar o máximo de contexto com o mínimo de esforço dele. Responder por toques é fácil; escrever parágrafos não é. No fim sai um resumo que qualquer pessoa conseguiria construir sem perguntar mais nada.

## Como perguntar
1. **Uma pergunta por vez**, sempre pela ferramenta `mcp__bancada__perguntar`. Se ela não existir neste terminal, use `AskUserQuestion` com uma pergunta só.
2. **Cada pergunta nasce da resposta anterior**, como no Akinator: escolha a pergunta que mais reduz a dúvida *agora*. Nada de questionário fixo, e nunca pergunte o que já ficou claro.
3. **Sempre 2 a 5 opções concretas** e plausíveis *para este caso*, a mais provável primeiro, deduzidas do que você já sabe e do código. Deixe o texto livre aberto. Use `multipla: true` quando várias respostas podem valer juntas (ex.: "quem usa?").
4. **Pense rápido entre as perguntas.** Se o projeto já existe, dê uma olhada curta no código (`ls`, `grep`, no máximo uns 30 s) para perguntar com base no que há lá: módulos parecidos, papéis de usuário, telas e tabelas existentes. Conte o que achou numa linha do resumo (ex.: "vi que já existe o módulo Estoque, com reservas por evento").
5. Em toda pergunta mande:
   - `etapa`: "Pergunta N · tema";
   - `resumo`: o que você já entendeu, em 3 a 6 linhas, para ele corrigir no caminho.
6. **Regra de negócio nunca é decidida por você.** Ela vira pergunta, com opções.
7. **Nome, marca ou codinome nunca é decidido por você.** Se precisar de um, pergunte com 2 a 4 opções e inclua "sem nome por enquanto".

## O que descobrir
Na ordem em que a conversa pedir, pulando o que já estiver claro:
- **Dor:** o problema e quem sente; como é feito hoje.
- **Quem usa e onde:** papéis, aparelho (Mac, celular, tablet do galpão), dentro ou fora da empresa.
- **Fluxo principal:** passo a passo de um caso real, do começo ao fim.
- **Dados:** que coisas o sistema guarda (itens, quantidades, pessoas, datas, fotos…).
- **Regras e exceções:** atraso, perda, avaria, devolução parcial, quem aprova.
- **Ligações com o que já existe:** outros módulos e sistemas.
- **Fora do escopo:** o que fica para depois.
- **Como saber que deu certo:** critérios que dá para conferir.
- **Restrições:** segurança e rede, dados pessoais (LGPD), dinheiro, prazo.

## Quando parar
- quando as dimensões acima estão claras o bastante para alguém de fora construir;
- quando ele responder **CHEGA**;
- ou depois de umas 15 perguntas, perguntando se ele quer continuar.

Se ele responder **PULOU**, siga em frente e registre o assunto como "em aberto".

## Fechamento
1. Mostre o **resumo completo** com `mcp__bancada__perguntar`, com estas opções:
   - "Está certo, pode forjar"
   - "Quero corrigir algo"
   - "Salvar e forjar depois"
2. **Corrigir:** pergunte o que mudar, ajuste e mostre de novo.
3. Grave o resumo num arquivo Markdown:
   - num motor athena: `outputs/entrevistas/AAAA-MM-DD-<assunto>.md`;
   - senão: `ENTREVISTA-<assunto>.md` na pasta do projeto.
4. **Pode forjar:**
   - se o comando `/ATHENA:tasks:forge-blueprint` existir, siga o pipeline dele usando o resumo como a intenção já decodificada. O P1 fica rápido: só confirme o JTBD;
   - se não existir, explique o plano em linguagem simples e pergunte se pode começar.
5. **Salvar e forjar depois:** adicione a pendência "Forjar o blueprint de <assunto> (resumo em <arquivo>)" com `mcp__bancada__pendencias`.

## Formato do resumo
```
# Entrevista — <assunto> (<data>)
Pedido em uma frase: Quando <situação>, quero <o quê>, para <resultado>.
Quem usa / onde:
Como é hoje:
Fluxo principal: 1. … 2. …
Dados:
Regras de negócio (decididas pelo usuário):
Ligações com o que já existe:
Fora do escopo:
Como saber que deu certo:
Restrições:
Em aberto:
```
