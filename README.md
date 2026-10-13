# Flashcards

App de flashcards com repetição espaçada que roda no navegador e pode ser instalado no iPhone como PWA. Funciona offline, guarda tudo no próprio aparelho e lê baralhos exportados do Anki.

## Instalar no iPhone

1. Abra o endereço do app no **Safari**.
2. Toque em **Compartilhar** e depois em **Adicionar à Tela de Início**.
3. Abra o app pelo ícone novo. A partir daí ele funciona sem internet.

## Trazer baralhos do Anki

1. No Anki do computador: **Arquivo → Exportar**.
2. Formato **Pacote de baralho do Anki (.apkg)**, com a mídia incluída. Marque "incluir informações de agendamento" se quiser manter o seu progresso.
3. Envie o arquivo para o iPhone (iCloud Drive, AirDrop, e-mail).
4. No app: **Ajustes → Importar baralho (.apkg)**.

Importar o mesmo baralho outra vez atualiza o texto dos cartões e mantém o progresso que você já tem no app.

## O que o app faz

- Estudo com os quatro botões do Anki (Errei, Difícil, Bom, Fácil) e o mesmo modelo de agendamento: etapas de aprendizado de 1 e 10 minutos, depois intervalos em dias que crescem conforme a facilidade do cartão.
- Limites diários de cartões novos e de revisões.
- Criação e edição de cartões: básico, básico com invertido e omissão de palavras, com imagens.
- Áudio e imagens dos baralhos importados.
- Backup completo em um arquivo `.zip`, com restauração.

## Limitações

- Não há sincronização com o AnkiWeb nem com o Anki do computador. O caminho é exportar e importar arquivos.
- Os dados ficam no armazenamento do navegador. Salve backups: o iOS pode apagar dados de sites que ficam muito tempo sem uso.
- JavaScript dentro dos modelos de cartão não é executado, e fórmulas em LaTeX/MathJax aparecem como texto.
- Pacotes muito grandes (centenas de MB) podem não caber na memória do celular na hora de importar.

## Desenvolvimento

Não há etapa de build: são arquivos estáticos.

```bash
npx serve .          # ou qualquer servidor estático
node test/run.mjs    # testes do agendador, da renderização e da importação
```

Ao alterar qualquer arquivo do app, aumente `VERSION` em `sw.js` para que os aparelhos instalados baixem a versão nova.

Bibliotecas incluídas em `vendor/`: [sql.js](https://github.com/sql-js/sql.js) (MIT), [fflate](https://github.com/101arrowz/fflate) (MIT) e [fzstd](https://github.com/101arrowz/fzstd) (MIT).

Este projeto é independente e não tem vínculo com o Anki.
