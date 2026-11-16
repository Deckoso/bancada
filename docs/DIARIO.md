# Diário de mudanças da Bancada

Quem mexe no repositório escreve aqui, **com a entrada mais nova no topo**. Assim cada pessoa (e o Claude de cada uma)
sabe o que a outra fez sem precisar perguntar. Leia as últimas entradas antes de começar e escreva uma ao terminar
(regras em [`CLAUDE.md`](../CLAUDE.md)).

Formato:

```
## AAAA-MM-DD — quem (pessoa · Claude)
- **Mudou:** o quê, onde (arquivos/áreas principais) e o PR/commit.
- **Testado:** como (testes, app aberto, Windows/Mac).
- **Pendente:** o que ficou pela metade ou quebrado.
- **Para a outra pessoa:** o que precisa saber, revisar ou decidir ("pedir revisão de segurança" quando mexer em
  atualização, celular, arquivos ou hooks).
```

---

## 2026-11-16 — Deckoso (Victor · Claude)
- **Mudou:** versão **0.8.0** publicada (commit `bc84d29`, Release v0.8.0):
  - primeira abertura para qualquer pessoa;
  - Escritório fiel ao que roda em segundo plano;
  - voz no terminal (whisper.cpp local);
  - recorte de tela e foto do celular;
  - atualização automática com manifesto assinado (Windows e Mac universal);
  - Relatar problema;
  - medidor de limite;
  - hooks leves no Windows.

  Também este `CLAUDE.md` e este diário.
- **Testado:**
  - 280 testes;
  - app empacotado aberto numa casa limpa;
  - 1 hora seguida com terminais e agentes;
  - auditoria de segurança antes de publicar.
- **Pendente:**
  - teste num Windows real (hooks, voz, recorte, atualização 0.8.0 → 0.8.1);
  - no Mac, quem libera microfone e gravação de tela para a Bancada libera também para os programas dos terminais dela.
    Está avisado na tela e a solução está em aberto.
- **Para a outra pessoa:**
  - a partir daqui, trabalhe em branch + PR para o `main`;
  - Release e versão ficam com o Deckoso (a assinatura da atualização é dele).
