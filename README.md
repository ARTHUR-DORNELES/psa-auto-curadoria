# Auto Curadoria — PSA Palestras

Produto self-service de curadoria de palestrantes. O cliente preenche um briefing e
recebe **3 nomes com justificativa**. O briefing vira negócio no HubSpot; a curadoria
em si é gerada por uma automação da PSA, não por este código.

## No ar

| | URL |
|---|---|
| Landing page | https://lps.profissionaissa.com/auto-curadoria |
| Ferramenta (briefing) | https://lps.profissionaissa.com/auto-curadoria-briefing |
| App / API | https://psa-auto-curadoria.vercel.app |

As duas primeiras são **landing pages do HubSpot** (portal `49656171`, domínio
`lps.profissionaissa.com`). Elas contêm quase nada: uma `<div>` e um `<script>` que
carrega o widget da Vercel.

```
LP:         <div id="psa-auto-curadoria-lp"></div>  + embed-lp.js
Ferramenta: <div id="psa-auto-curadoria"></div>     + embed.js
```

contentIds no HubSpot: LP `219641155329`, ferramenta `219641155635`.

## Como o fluxo funciona

```
cliente preenche o briefing (ferramenta.html)
        │
        ▼
POST /api/curar
        │  cria/atualiza contato + negócio no funil B2B
        │  grava observação com o briefing inteiro
        ▼
automação da PSA (dispara ao ver a observação)
        │  gera a curadoria e escreve os 5 nomes na
        │  propriedade de negócio ia_curadoria_nomes
        ▼
GET /api/resultado?id=...   (a página consulta a cada 8s)
        │  lê a propriedade, escolhe 3 dos 5, sanitiza
        ▼
página mostra as 3 indicações
```

**Este repositório não escolhe palestrante.** Ele registra o briefing, espera a
automação e apresenta o resultado. A geração dos nomes é externa.

### A regra dos 3 de 5

O arquivo da automação traz **5 nomes**: 1 permuta, 2 matriz, 2 melhores.
Vão 3 para o cliente: **1 de cada**. Sem permuta: **2 matriz + 1 melhores**.
Se faltar estoque numa categoria, completa com as outras — devolver 3 nomes importa
mais que respeitar a proporção. Implementado em `escolherTres()` (`api/_lib.js`).

### Refazer

O cliente pode refazer **1 vez** (`MAX_REFACOES`). Os 3 nomes recusados entram em
`descartados` e nunca voltam; uma observação nova é escrita no negócio pedindo outros
nomes. Enquanto sobrarem menos de 3 nomes inéditos na propriedade, a curadoria segue
"não pronta" e a página espera.

### Pedido de disponibilidade e orçamento

O cliente marca quais dos 3 quer e confirma **uma vez** — disponibilidade e orçamento
são o mesmo pedido, porque do outro lado são a mesma decisão. Prazo prometido: **24h**.

`POST /api/resultado?id=... { acao: 'disponibilidade', palestrantes: [...] }`

Além da observação, isso cria **um item de linha por palestrante** no negócio
(`criarItensDeLinha`), que é o que faz os nomes aparecerem na *consulta de palestrantes*
para o time disparar a pesquisa de agenda. O nome é casado com o produto do HubSpot por
`produtoPorNome()` (com fallback sem acento e índice em cache); quem não casar entra na
observação com aviso de **vincular à mão** — se ficasse só no log, ninguém checaria a
disponibilidade daquele nome.

**É de propósito que só possa ser enviado uma vez por curadoria.** Um segundo envio
duplicaria item de linha, e item duplicado dobra o valor do negócio e faz o time
pesquisar o mesmo palestrante duas vezes. Reenvio devolve o que já foi pedido
(`jaEnviado: true`), e o `GET` devolve `disponibilidade` para a tela já vir travada
quando o cliente recarrega o link.

## Nunca pode chegar ao cliente

Isto não é preferência de estilo, é o núcleo comercial da PSA. Há checagens
automáticas em `scripts/test-curadoria.mjs` impedindo regressão.

| Dado | Por quê |
|---|---|
| `permuta` / `matriz` / `casting` | revela que a PSA não paga cachê àquele palestrante e como a base é organizada |
| cachê exato | é a posição de negociação da PSA — o cliente vê **faixa** ("entre R$ 5 e 10 mil") |
| nº de contratações / fechamentos | com 1 briefing por macro tema, qualquer um mapeia o casting |

Três camadas: `semTermosInternos()` e `semNumerosInternos()` lavam o texto que vem da
automação; `paraCliente()` remove `categoria` e o registro bruto antes de responder.

Uma versão anterior publicava *"269 contratações e 41 fechadas · ticket médio R$ 8.715"*
na justificativa — e o primeiro motivo aparece no teaser, que é grátis. Paywall não
protege dado; só a ausência do dado protege.

## Rodando local

```bash
npm install
cp .env.example .env      # peça os valores a quem cuida do projeto
npm test                  # 16 checagens, tudo offline
```

Os `.env` **nunca** vão para o repositório. Os valores estão nas variáveis de ambiente
do projeto na Vercel — peça acesso lá, não por e-mail ou chat.

### O passo de build que não pode ser esquecido

`embed.js` e `embed-lp.js` são **gerados** a partir de `ferramenta.html` e `index.html`.
Não edite os embeds à mão.

```bash
npm run embed     # regenera os dois
```

O `npm test` falha se os embeds estiverem fora de sincronia com os HTMLs. O build
escopa todo o CSS em `#psa-auto-curadoria` / `#psa-auto-curadoria-lp` — sem isso,
regras como `header{position:sticky}` vazariam e quebrariam o tema do HubSpot.

### Deploy

O projeto está conectado ao repositório: **`git push` na `main` publica**.
`vercel deploy --prod` também funciona.

## Scripts

| Comando | O que faz |
|---|---|
| `npm test` | 16 checagens (sanitização, regra dos 3, enums, CORS, telefone) |
| `npm run embed` | regenera `embed.js` e `embed-lp.js` |
| `npm run enums` | sincroniza `macro_tema` e `micro_tema` reais do HubSpot para dentro do formulário |
| `npm run cidades` | sincroniza a lista fechada de cidades (IBGE) usada no briefing |
| `npm run auditoria` | lista curadorias que não viraram negócio; `--corrigir` reprocessa |
| `npm run dataset` | regenera `data/palestrantes.js` (não versionado, ver abaixo) |

## Armadilhas do HubSpot

Cada uma destas custou tempo. Leia antes de mexer no CRM.

**O funil B2B remapeou os rótulos dos ids internos.** `closedwon` está rotulado
"Proposta enviada" e `closedlost` é "Em negociação". Ganho real é `1076664460`, perda
real é `1076664461`. Contar `closedwon` como ganho dá 9,3% de conversão; o número
correto é **1,9%**.

**Enums são valores exatos.** Escrever a lista de `micro_tema` à mão gera valor
inválido, o HubSpot **rejeita o negócio inteiro** e o lead se perde. Use `npm run enums`.
Sete macro temas não têm recorte cadastrado — nesses o campo desabilita sozinho.

**Propriedade de data só aceita meia-noite UTC exata** (`T00:00:00Z`). Com `T12:00`
retorna `INVALID_DATE`.

**Telefone precisa ir em E.164** (`+55...`) ou o contato é rejeitado inteiro.
`telefoneE164()` devolve string vazia quando não consegue inferir — perder o telefone
é melhor que perder o lead.

**Criar o negócio é fatal para o fluxo** (é a observação que dispara a automação), então
`criarNegocio()` descarta a propriedade recusada e tenta de novo em vez de perder o lead.
A observação leva o briefing completo de qualquer forma.

**Todo registro criado por API aparece como "criado via &lt;nome do private app&gt;".**
Hoje sai como *Reconciliação_Kiwify*, porque o token é emprestado de outro projeto.
Criar um private app próprio resolve.

### Mapeamento de propriedades

| Campo do formulário | Propriedade do negócio |
|---|---|
| Tema / Recorte | `macro_tema` / `micro_tema` |
| Público-alvo | `perfil_do_publico_participante__ganho_` |
| Formato | `formato_evento` |
| Data / Horário | `data_da_palestra_do_1o_palestrante` / `horario_da_palestra_do_1o_palestrante` |
| Duração | `duracao_do_evento` |
| Local / Estado / Cidade | `local_evento` / `estado_negocio` / `cidade` (lista fechada do IBGE, cascateia do estado) |
| Orçamento | `janeiro___orcamento` |
| Venda de ingresso | `evento_com_venda_de_ingresso_` |
| Motivo + sentimento + contexto | `objetivos_do_evento` (narrativa, como o time usa) |
| Nomes da IA Curadoria | `ia_curadoria_nomes` ← **a automação escreve aqui** |

Negócio nasce no funil `default`, etapa `decisionmakerboughtin`, com nome
`AUTO CURADORIA | Nome - Empresa - DD/MM/AAAA` (segue o padrão do funil, onde já existe
o prefixo `CURADORIA |`).

### Formato de `ia_curadoria_nomes`

JSON é o preferido:

```json
[{ "nome": "Fulano", "categoria": "permuta", "perfil": "...",
   "porque": ["motivo 1", "motivo 2"], "atencao": "..." }]
```

Mas o parser também lê o formato de texto que a automação usa hoje:

```
Matriz: Alsones Balestrin
  - motivo
  - motivo

Melhor geral: Cristiano Machado
  - motivo
```

Categoria aceita variação de caixa, acento e plural (`Permuta`, `MELHORES`,
`Melhor geral`, `top`). Cuidado: a primeira versão do parser só aceitava uma palavra
antes dos dois-pontos e devolvia **1 nome de 3**, porque "Melhor geral" tem duas.

## Variáveis de ambiente

Só os nomes. Valores ficam na Vercel.

| Nome | Para quê |
|---|---|
| `HUBSPOT_TOKEN` | private app com escopo de contatos, negócios e notas |
| `REDIS_URL` | guarda briefing e resultado por 90 dias |
| `PRECO_CENTAVOS` | preço em centavos (default `19700` = R$ 197) |
| `CHECKOUT_URL` | **vazio hoje.** Vazio = curadoria liberada sem pagar. Preencher reativa o paywall sem tocar em código |
| `WEBHOOK_SECRET` | token do `/api/webhook` de confirmação de pagamento |
| `PROP_CURADORIA_NOMES` | nome da propriedade dos nomes (default `ia_curadoria_nomes`) |
| `MAX_REFACOES` | refações permitidas (default `1`) |
| `ORIGENS_EXTRA` | domínios extra liberados no CORS, separados por vírgula |

`API_BASE` e `URL_FERRAMENTA` são só do build local dos embeds.

CORS libera apenas domínios da PSA e `hs-sites.com` — a allowlist está em
`api/_lib.js` e é testada contra domínio sósia (`profissionaissa.com.br.evil.com`).

## `data/palestrantes.js` — não versionado

Extrato de 423 palestrantes com cachê, volume e taxa de fechamento, agregado de 76 mil
deals do HubSpot. **Fora do repositório de propósito**: é o núcleo comercial da PSA.

Nenhum código em produção depende dele hoje — o motor local de curadoria foi removido
quando a automação assumiu a geração dos nomes. Regenere com `npm run dataset` se
precisar dos números para análise.

## Preço

**R$ 197, 100% creditável no cachê.** Racional: fica em ≤4% do cachê em todas as faixas
onde está 80% do casting (cachê mediano R$ 6.186). Um briefing frio vale R$ 29–44 em
comissão esperada (ticket ganho mediano R$ 7.650 × conversão 1,9% × comissão 20–30%).

**Ainda não validado por teste.** O número saiu de um heurístico, não de medição de
disposição a pagar. Validar exige instrumentar o funil por ~2 semanas.

`scripts/preco-analise.mjs` e `scripts/preco-conversao.mjs` recalculam a base.

## Pendências

- [ ] **Checkout.** `CHECKOUT_URL` vazia; hoje a curadoria sai liberada. O webhook
      (`/api/webhook`) já é agnóstico de gateway (Kiwify e Stripe).
- [ ] **Private app próprio no HubSpot**, para os registros pararem de aparecer como
      criados pela integração da reconciliação do Kiwify.
- [ ] **Confirmar que a automação sobrescreve `ia_curadoria_nomes` numa refação.**
      Se ela repetir os mesmos nomes, o filtro de descartados derruba tudo e a página
      fica esperando (comportamento correto, cliente sem resultado).
- [ ] **FAQ da LP** aguardando texto novo.
- [ ] Medir abandono na espera de 3,8 min do formulário.
- [ ] **Palestrantes sem produto correspondente no HubSpot** não geram item de linha e
      precisam de vínculo manual. Vale medir a frequência: se for alta, o casamento por
      nome não basta e o certo é a automação já devolver o id do produto.
