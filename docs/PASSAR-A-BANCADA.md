# Passar a Bancada para outra pessoa

## 1. Gerar o arquivo (no seu Mac)
```
npm run share
```
Sai `dist-share/Bancada-0.3.0-mac-arm64.zip`. Mande por AirDrop, Drive ou WhatsApp.

- Funciona em Mac com chip Apple (M1 ou mais novo).
- **Nada pessoal vai junto:** notas, projetos, contas e conversas ficam na pasta de dados de cada Mac, fora do app.

## 2. Primeira abertura (no Mac da pessoa)
1. Dê dois cliques no `.zip` e arraste a **Bancada** para a pasta **Aplicativos**.
2. Abra a Bancada. O Mac avisa que não conseguiu verificar o desenvolvedor: clique em **OK**.
3. Abra **Ajustes do Sistema → Privacidade e Segurança**, desça até "Bancada foi bloqueada…" e clique em **Abrir Mesmo Assim**. Confirme com a senha ou o Touch ID.
4. Pronto. Das próximas vezes, abre direto.

**Por que esse passo existe:** o app tem assinatura local, não a da Apple. Para pular esse passo é preciso uma conta de desenvolvedor Apple (US$ 99/ano), para assinar e "notarizar" o app.

## 3. Dentro da Bancada
1. Escolha **"Estou começando"**.
2. No cartão da IA que a pessoa assina, clique em **Instalar** e depois em **Entrar na minha conta**. O navegador abre no site oficial: entrar e autorizar.
3. Clique em **Continuar**. A Bancada cria **Documentos › Bancada › Meu primeiro projeto** e abre a IA nessa pasta.
4. Na primeira vez, a IA pergunta em inglês se você confia na pasta:
   - **Claude:** seta ↓ até "Yes, I trust this folder" e Enter;
   - **Codex:** Enter.
5. Escreva o pedido em português, por exemplo: *"crie uma página com um relógio grande e me mostre como abrir"*.

## Se algo der errado
| Sintoma | O que fazer |
|---|---|
| "a Bancada está danificada" | O arquivo foi gerado sem `npm run share` (assinatura quebrada). Gere de novo pelo script. |
| Instalar falhou | Normalmente é falta de internet. O registro aparece no próprio cartão; clique em **Testar** e tente de novo. |
| "não conectado" depois do login | Clique em **Testar**. Se continuar, **Entrar na minha conta** de novo. Confira se a assinatura da IA está ativa. |
| A IA fechou na pergunta de confiança | Aperte Enter no terminal para reabrir e escolha a opção de confiar. |
