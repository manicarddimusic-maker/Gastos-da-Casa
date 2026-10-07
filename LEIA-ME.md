# Gastos da Casa: como colocar no ar (passo a passo)

Você vai criar o app uma vez só. Depois ele abre pelo ícone no iPhone, com senha, em tela cheia, sem depender do Claude.

Custo: o Railway cobra por uso (costuma ficar em poucos dólares por mês para um app pequeno como este). Confira o preço atual em railway.com/pricing.

## 1. Guardar o código no GitHub
1. Crie uma conta em github.com (se ainda não tiver).
2. Clique em **New repository**. Nome: `gastos-da-casa`. Marque **Private** (privado). Crie.
3. Na página do repositório, clique em **uploading an existing file** e arraste TODOS os arquivos desta pasta (menos a pasta `node_modules`, se existir). Clique em **Commit changes**.

## 2. Criar o app no Railway
1. Entre em railway.com e faça login com sua conta do GitHub.
2. **New Project** > **Deploy from GitHub repo** > escolha `gastos-da-casa`.
3. Aguarde terminar a primeira construção (pode dar erro de senha ausente, é normal; vamos configurar já).

## 3. Guardar os dados com segurança (escolha UMA opção)
**Opção A (recomendada): banco Postgres**
1. No projeto, clique em **+ New** > **Database** > **Add PostgreSQL**.
2. Clique no serviço do app > **Variables** > **New Variable** > **Add Reference** > escolha `DATABASE_URL` do Postgres.

**Opção B: volume**
1. No serviço do app: **Settings** > **Volumes** > **Add Volume**, caminho `/data`.
2. Em **Variables**, crie `DATA_DIR` com o valor `/data`.

## 4. Definir as senhas
No serviço do app > **Variables** > crie `APP_PASSWORDS` com as senhas separadas por vírgula, sem espaços. Para destravar com **Ana** ou **Guilherme**, o valor é:

`Ana,Guilherme`

Cada senha precisa ter pelo menos 3 letras. Maiúsculas e minúsculas contam (digite com a inicial maiúscula). Para trocar ou acrescentar alguém, é só mudar esse valor no Railway. Senhas curtas como nomes são fáceis de adivinhar; o app bloqueia por 10 minutos depois de 8 tentativas erradas seguidas, mas se quiser mais segurança, use uma senha maior.

## 5. Gerar o endereço
Serviço do app > **Settings** > **Networking** > **Generate Domain**. Abra o endereço que aparecer, digite a senha e pronto.

## 6. Instalar no iPhone
1. Abra o endereço no **Safari** (precisa ser o Safari).
2. Toque no botão de compartilhar (quadrado com seta) > **Adicionar à Tela de Início** > **Adicionar**.
3. O ícone "Gastos" aparece na tela. Abra por ele: tela cheia, sem barra do navegador.

## Anexos nos pagamentos
Em cada linha há o botão **Anexar** (clipe). Dentro dele dá para juntar print, PDF, Excel, vídeo ou qualquer arquivo (até 40 MB cada, 30 por pagamento). No iPhone, o botão **+ Adicionar arquivos** abre Fotos, Arquivos ou a câmera. No Mac, também dá para arrastar o arquivo até a linha ou colar um print com ⌘V. Os arquivos ficam no mesmo banco Postgres dos lançamentos (e somem se a linha for excluída). Se o banco encher, o Railway avisa no painel do Postgres.

## Relatório em PDF
No topo do app, o botão **Relatório** abre a janela de relatório. Escolha o período (Mês aberto, Ano todo, Tudo, ou De/Até com mês e ano), marque se quer os **lançamentos detalhados** e os **comprovantes** (os prints e fotos anexados aparecem dentro do PDF) e toque em **Abrir PDF** ou **Baixar PDF**. O PDF traz capa, resumo (salário, lançado, pago, disponível, a pagar), parcelas em andamento, custos fixos e variáveis com data de pagamento, maiores gastos e lista de anexos; em vários meses, também o gráfico mês a mês, a tabela comparativa e o ranking de gastos. Até 36 meses por relatório. Ele é gerado na hora, no servidor, só com a sessão aberta.

## Fotos da casa e das cachorras
As fotos ficam na pasta `views/fotos` e só aparecem depois de digitar a senha.

## Dúvidas comuns
- **Esqueci a senha:** troque o valor de `APP_PASSWORDS` no Railway e o app reinicia sozinho.
- **Os dados somem?** Não, desde que você tenha feito o passo 3.
- **Sair do app:** botão "Sair" no rodapé.
