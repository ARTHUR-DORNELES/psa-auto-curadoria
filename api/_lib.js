import Redis from 'ioredis';
import { MACRO } from './_enums.js';

// canoniza o macro tema pela lista oficial, casando pelo número ("19." -> "19. LIDERANÇA").
// Conserta mojibake gravado (ex.: "19. LIDERAN�A") sem depender do texto corrompido.
const _canonMacro = (v) => {
  const s = String(v || '').trim();
  const n = (s.match(/^\s*(\d+)\s*\./) || [])[1];
  if (n) { const hit = MACRO.find((m) => (String(m).match(/^\s*(\d+)\s*\./) || [])[1] === n); if (hit) return hit; }
  return s;
};

// R$ 197, 100% creditável no cachê. Escolhido para ficar ≤4% do cachê em todas as
// faixas onde está 80% do casting (cachê mediano R$ 6.186). Ainda não validado —
// ver scripts/preco-conversao.mjs e a instrumentação do funil.
export const PRECO_CENTAVOS = Number(process.env.PRECO_CENTAVOS || 19700);
export const CHECKOUT_URL = process.env.CHECKOUT_URL || '';

// Funil de Vendas B2B. Atenção: este funil remapeou os rótulos dos ids internos —
// `closedwon` aqui é "Proposta enviada" e `closedlost` é "Em negociação".
// A etapa de entrada é decisionmakerboughtin ("Reunião agendada / Qualificado").
const PIPELINE = 'default';
const STAGE_NOVO = 'decisionmakerboughtin';

// Pipeline "Auto Curadoria" (paywall). A compra pelo checkout cai em "Pago"; ao gerar
// a curadoria, o negócio vira "Utilizado" e não pode mais liberar acesso.
const PIPE_AUTOCURADORIA = '928503985';
const STAGE_PAGO = '1423408703';
const STAGE_UTILIZADO = '1423413584';

const HS = 'https://api.hubapi.com';

let _redis;
export function redis() {
  if (!_redis) _redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  return _redis;
}

export const chave = id => `autocuradoria:${id}`;
// vínculo negócio -> id da curadoria, para o gate reencontrar a curadoria pelo CPF/CNPJ
// (sem depender de o cliente ter guardado o link). Mesma validade do registro: 90 dias.
export const chaveDeal = dealId => `autocuradoria:deal:${dealId}`;
// projeto = evento com vários palestrantes: agrupa 1 curadoria por macro tema (mesmo briefing).
export const chaveProjeto = pid => `autocuradoria:projeto:${pid}`;

// ── normalização ───────────────────────────────────────────────────────────
const semAcento = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();


/**
 * Rede de segurança: o prompt proíbe cifra e contagem, mas modelo escorrega.
 * Nada de valor em reais nem de contagem de contratos chega ao cliente.
 */
// Vocabulário de bastidor: como o nome entrou na lista é decisão comercial da PSA.
// "Permuta" entrega que não pagamos cachê àquele palestrante; "matriz" e "casting"
// expõem como a base é organizada. Nada disso é assunto do cliente.
const INTERNOS = /\b(permutas?|matriz(es)?|casting( pr[óo]prio)?|cota de permuta|banco interno)\b/gi;

export function semTermosInternos(texto) {
  return String(texto || '')
    .replace(/\b(indicad[oa]|selecionad[oa]|escolhid[oa])\s+(por|via|como|de)\s+(permutas?|matriz(es)?)\b/gi, 'indicado pela curadoria PSA')
    .replace(INTERNOS, 'nosso portfólio')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function semNumerosInternos(texto) {
  return String(texto || '')
    // o número não pode terminar em separador, senão o filtro come a pontuação da frase
    .replace(/R\$\s?\d[\d.]*(?:,\d+)?(?:\s?(?:mil|k|milh(?:ão|ões)))?/gi, 'valor sob proposta')
    // \w não cobre acento em JS: "contratações" quebrava o filtro por causa do "ç"
    .replace(/\b\d{2,}\s+(contrata\p{L}*|eventos?|palestras?|fechad\p{L}*|deals?)/giu, 'diversas $1')
    .replace(/\b\d{2,}\s+(?=pessoas|participantes)/giu, 'centenas de ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}


// ── HubSpot ────────────────────────────────────────────────────────────────
async function hs(caminho, metodo, corpo) {
  const r = await fetch(`${HS}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`HubSpot ${r.status} ${caminho}: ${texto}`);
  return texto ? JSON.parse(texto) : {};
}

/**
 * HubSpot rejeita o contato inteiro se o telefone não estiver em E.164.
 * Número irreconhecível vira campo vazio — perder o telefone é melhor que perder o lead.
 */
export function telefoneE164(bruto) {
  const d = String(bruto || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;          // DDD + número
  if (d.length === 8 || d.length === 9) return '';                    // sem DDD, não dá para inferir
  return d.length > 8 ? `+${d}` : '';                                 // internacional já com DDI
}

/** Cria/atualiza o contato e abre o negócio no funil da plataforma. */
export async function registrarNoHubspot(briefing, resultado, id) {
  const [primeiro, ...resto] = (briefing.nome || '').trim().split(/\s+/);

  const props = {
    email: briefing.email,
    firstname: primeiro || '',
    lastname: resto.join(' '),
    phone: telefoneE164(briefing.telefone),
    company: briefing.empresa || '',
  };

  let contatoId;
  try {
    contatoId = (await hs('/crm/v3/objects/contacts', 'POST', { properties: props })).id;
  } catch (e) {
    if (!/409|already exists/i.test(e.message)) throw e;
    const existente = e.message.match(/Existing ID:\s*(\d+)/)?.[1];
    contatoId = existente;
    if (contatoId) await hs(`/crm/v3/objects/contacts/${contatoId}`, 'PATCH', { properties: props });
  }

  const negocio = await criarNegocio({
      // padrão do funil B2B ("Nome - Empresa - data") com marcador de origem,
      // no mesmo formato do prefixo "CURADORIA |" que o time já usa
      dealname: [
        'AUTO CURADORIA |',
        [primeiro, briefing.empresa, dataBR(briefing.data)].filter(Boolean).join(' - '),
      ].join(' ').slice(0, 240),
      pipeline: PIPELINE,
      dealstage: STAGE_NOVO,
      macro_tema: briefing.macroTema || undefined,
      micro_tema: briefing.microTema || undefined,
      janeiro___orcamento: briefing.orcamento || undefined,
      formato_evento: briefing.formato || undefined,
      estado_negocio: briefing.local || undefined,
      local_evento: briefing.localEvento || undefined,
      cidade: briefing.cidade || undefined,
      perfil_do_publico_participante__ganho_: briefing.publicoAlvo || undefined,
      horario_da_palestra_do_1o_palestrante: briefing.horario || undefined,
      duracao_do_evento: briefing.duracao || undefined,
      evento_com_venda_de_ingresso_: briefing.vendaIngresso || undefined,
      // o time preenche este campo com narrativa, não com rótulo — então entrega
      // as três respostas de objetivo juntas, no formato que eles já leem
      objetivos_do_evento: [
        briefing.motivacao && `Motivo da busca: ${briefing.motivacao}.`,
        briefing.sentimento && `Como o público deve sair: ${briefing.sentimento}.`,
        briefing.briefing?.trim() && `Contexto do cliente: ${briefing.briefing.trim()}`,
      ].filter(Boolean).join(' ').slice(0, 4000) || undefined,
      // propriedade de data no HubSpot só aceita meia-noite UTC exata
      data_da_palestra_do_1o_palestrante: briefing.data ? Date.parse(`${briefing.data}T00:00:00Z`) : undefined,
      descreva_o_macro_tema: briefing.briefing?.slice(0, 4000) || undefined,
  }, contatoId);

  await nota(negocio.id, notaDoBriefing(briefing, resultado, id));

  return { contatoId, negocioId: negocio.id };
}

/**
 * Fluxo unificado (paywall): em vez de abrir um negócio novo no B2B, joga o briefing no
 * PRÓPRIO negócio "Pago" da Auto Curadoria — o que liberou o acesso. Atualiza as props do
 * briefing + o nome, MANTÉM a etapa (segue "Pago" até a geração consumir para "Utilizado")
 * e adiciona a observação, que é o que dispara a automação (o webhook lê as notas do
 * negócio). Tolera prop recusada igual ao criarNegocio: enum inválido não trava o fluxo.
 */
// Monta as propriedades do negócio a partir do briefing (mesmo mapa usado ao anexar
// no negócio existente e ao criar um negócio por curadoria).
function _propsBriefing(briefing) {
  const [primeiro] = (briefing.nome || '').trim().split(/\s+/);
  const props = {
    dealname: ['AUTO CURADORIA |', [primeiro, briefing.empresa, dataBR(briefing.data)].filter(Boolean).join(' - ')].join(' ').slice(0, 240),
    macro_tema: briefing.macroTema || undefined,
    micro_tema: briefing.microTema || undefined,
    janeiro___orcamento: briefing.orcamento || undefined,
    formato_evento: briefing.formato || undefined,
    estado_negocio: briefing.local || undefined,
    local_evento: briefing.localEvento || undefined,
    cidade: briefing.cidade || undefined,
    perfil_do_publico_participante__ganho_: briefing.publicoAlvo || undefined,
    horario_da_palestra_do_1o_palestrante: briefing.horario || undefined,
    duracao_do_evento: briefing.duracao || undefined,
    evento_com_venda_de_ingresso_: briefing.vendaIngresso || undefined,
    objetivos_do_evento: [
      briefing.motivacao && `Motivo da busca: ${briefing.motivacao}.`,
      briefing.sentimento && `Como o público deve sair: ${briefing.sentimento}.`,
      briefing.briefing?.trim() && `Contexto do cliente: ${briefing.briefing.trim()}`,
    ].filter(Boolean).join(' ').slice(0, 4000) || undefined,
    data_da_palestra_do_1o_palestrante: briefing.data ? Date.parse(`${briefing.data}T00:00:00Z`) : undefined,
    descreva_o_macro_tema: briefing.briefing?.slice(0, 4000) || undefined,
  };
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
}

export async function anexarBriefingAoNegocio(dealId, briefing, id) {
  let props = _propsBriefing(briefing);

  // PATCH tolerando prop recusada — nunca mexe em pipeline/dealstage (segue "Pago").
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    try {
      await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: props });
      break;
    } catch (e) {
      const recusadas = [...e.message.matchAll(/"name\\?":\\?"([a-z0-9_]+)\\?"/g)].map((m) => m[1])
        .filter((p) => p in props && p !== 'dealname');
      if (!recusadas.length) throw e;
      for (const p of recusadas) delete props[p];
      console.error('BRIEFING_PROP_RECUSADA', recusadas.join(','), '— seguindo sem ela');
    }
  }

  // a observação dispara a automação (o workflow enrola o negócio com nota conhecida)
  await nota(dealId, notaDoBriefing(briefing, null, id));
  return { negocioId: dealId };
}

const dataBR = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : '');

/**
 * Cria o negócio tolerando propriedade recusada.
 * Sem negócio não existe curadoria (é a observação que dispara a automação), então
 * uma opção de enum que mudou no HubSpot não pode custar o lead: a propriedade
 * problemática é descartada e o valor continua na observação, que leva tudo.
 */
async function criarNegocio(properties, contatoId) {
  const associations = contatoId ? [{
    to: { id: contatoId },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
  }] : undefined;

  let props = { ...properties };
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    try {
      return await hs('/crm/v3/objects/deals', 'POST', { properties: props, associations });
    } catch (e) {
      const recusadas = [...e.message.matchAll(/"name\\?":\\?"([a-z0-9_]+)\\?"/g)].map(m => m[1])
        .filter(p => p in props && !['dealname', 'pipeline', 'dealstage'].includes(p));
      if (!recusadas.length) throw e;
      for (const p of recusadas) delete props[p];
      console.error('NEGOCIO_PROP_RECUSADA', recusadas.join(','), '— criando sem ela');
    }
  }
  throw new Error('negócio recusado mesmo após descartar propriedades');
}

// Etapas da pipeline Auto Curadoria resolvidas PELO NOME (label), em runtime e em cache.
// Assim o time cria "Curadorias criadas"/"Curadorias finalizadas" no HubSpot sem eu
// precisar caçar ids — o código acha pelo nome. Devolve null se a etapa ainda não existe
// (o negócio então cai na etapa padrão da pipeline, sem quebrar).
const NOME_STAGE = { criada: 'Curadorias criadas', finalizada: 'Curadorias finalizadas', perdido: 'Negócio perdido' };
let _stagesCache = null;
async function stageIdPorNome(nome) {
  try {
    if (!_stagesCache) {
      const p = await hs(`/crm/v3/pipelines/deals/${PIPE_AUTOCURADORIA}`, 'GET');
      _stagesCache = {};
      for (const s of (p.stages || [])) _stagesCache[String(s.label || '').trim().toLowerCase()] = s.id;
    }
    return _stagesCache[String(nome).trim().toLowerCase()] || null;
  } catch (e) { console.error('stageIdPorNome falhou:', e.message); return null; }
}

// Cria um NEGÓCIO NOVO por curadoria (etapa "Curadorias criadas"), associado ao contato
// assinante, com o briefing e a observação que dispara a automação. É o negócio onde a
// curadoria daquela solicitação vai viver (substitui reaproveitar o negócio da assinatura).
export async function criarNegocioCuradoria(contatoId, briefing, id, notaExtra = '') {
  const props = _propsBriefing(briefing);
  const criada = await stageIdPorNome(NOME_STAGE.criada);
  if (!criada) console.error('etapa "Curadorias criadas" não encontrada na pipeline — negócio criado na etapa padrão');
  const deal = await criarNegocio(
    { ...props, pipeline: PIPE_AUTOCURADORIA, ...(criada ? { dealstage: criada } : {}) },
    contatoId,
  );
  // a observação dispara a automação. Na refação, `notaExtra` traz o bloco NAO_REPETIR.
  await nota(deal.id, notaDoBriefing(briefing, null, id) + (notaExtra ? '\n\n' + notaExtra : ''));
  return { negocioId: deal.id };
}

// Aciona a automação da IA Curadoria DIRETO pelo webhook de produção do n8n, com o negócio.
// Usado na REFAÇÃO: uma 2ª observação no mesmo negócio não re-dispara o gatilho do HubSpot,
// então a ferramenta chama o webhook na mão (mesmo payload do gatilho: { hs_object_id }).
// Assim a refação regenera no MESMO negócio, sem criar um segundo. Nunca lança.
const N8N_WEBHOOK_CURADORIA = process.env.N8N_WEBHOOK_CURADORIA
  || 'https://n8n.profissionaissa.tchat.telnet23.com.br/webhook/39000a02-7787-4f11-a722-93a3575c1667';
export async function dispararWebhookCuradoria(dealId) {
  if (!dealId) return false;
  try {
    await fetch(N8N_WEBHOOK_CURADORIA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hs_object_id: String(dealId) }),
    });
    return true;
  } catch (e) { console.error('dispararWebhookCuradoria falhou:', e.message); return false; }
}

// Move o negócio da curadoria para "Curadorias finalizadas" (após a refação). Nunca lança.
export async function finalizarCuradoria(dealId) {
  if (!dealId) return false;
  try {
    const fin = await stageIdPorNome(NOME_STAGE.finalizada);
    if (!fin) { console.error('etapa "Curadorias finalizadas" não encontrada — negócio não movido'); return false; }
    await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: { dealstage: fin } });
    return true;
  } catch (e) { console.error('finalizarCuradoria falhou:', e.message); return false; }
}

// "Deletar" na visão do cliente = ARQUIVAR: move o negócio para "Negócio perdido" e ele some
// da lista (a lista só olha criadas/finalizadas). Reversível — o negócio continua no HubSpot.
// Nunca lança.
export async function arquivarCuradoria(dealId) {
  if (!dealId) return false;
  try {
    const perdido = await stageIdPorNome(NOME_STAGE.perdido);
    if (!perdido) { console.error('etapa "Negócio perdido" não encontrada — negócio não arquivado'); return false; }
    await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: { dealstage: perdido } });
    return true;
  } catch (e) { console.error('arquivarCuradoria falhou:', e.message); return false; }
}

// Salva os palestrantes que o cliente PEDIU e que NÃO existem na base (lista fechada). É demanda:
// nomes que a PSA poderia passar a representar. Guarda em dois lugares: nota no negócio (o time vê
// na hora) e um acumulador central no Redis (ranking de demanda por nome). Nunca lança.
export async function registrarNomesNaoEncontrados(dealId, nomes, meta = {}) {
  const lista = [...new Set((nomes || []).map((n) => String(n || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!lista.length) return;
  const em = new Date().toISOString();
  // acumulador: ZINCRBY conta quantas vezes cada nome foi pedido; hash guarda o último contexto
  try {
    for (const nome of lista) {
      await redis().zincrby('auto-curadoria:nao-encontrados', 1, nome);
      await redis().hset('auto-curadoria:nao-encontrados:meta', nome.toLowerCase(),
        JSON.stringify({ nome, ultimaEmpresa: meta.empresa || '', em, curadoria: meta.curadoria || '' }));
    }
  } catch (e) { console.error('acumulador nao-encontrados falhou:', e.message); }
  // nota no negócio
  try {
    if (dealId) {
      await nota(dealId, [
        'AUTO CURADORIA — palestrante(s) solicitado(s) pelo cliente e NÃO encontrado(s) na base:',
        ...lista.map((n) => `- ${n}`),
        meta.empresa ? `Evento para: ${meta.empresa}.` : '',
        'Avaliar cadastro/representação desses nomes.',
      ].filter(Boolean).join('\n'));
    }
  } catch (e) { console.error('nota nao-encontrados falhou:', e.message); }
}

// Ação do cliente sobre UMA curadoria da lista dele (finalizar/arquivar), com checagem de dono:
// o CPF/CNPJ informado tem de bater com o contato que criou a curadoria. Nunca lança.
export async function acaoCuradoria(bruto, uuid, acao) {
  const doc = normalizaDocumento(bruto);
  if (!doc) return { ok: false, erro: 'documento inválido' };
  if (!uuid || !['finalizar', 'arquivar'].includes(acao)) return { ok: false, erro: 'ação inválida' };
  try {
    const cru = await redis().get(chave(uuid));
    if (!cru) return { ok: false, erro: 'curadoria não encontrada' };
    let reg; try { reg = JSON.parse(cru); } catch (e) { return { ok: false, erro: 'curadoria corrompida' }; }
    const dealId = reg?.hubspot?.negocioId;
    if (!dealId) return { ok: false, erro: 'curadoria sem negócio associado' };
    // dono: os contatos do CPF/CNPJ têm de incluir o contato que criou esta curadoria
    const contatos = await hs('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: doc.tipo, operator: 'EQ', value: doc.valor }] }],
      properties: [doc.tipo], limit: 100,
    });
    const ids = (contatos.results || []).map((c) => String(c.id));
    if (!reg.contatoId || !ids.includes(String(reg.contatoId))) return { ok: false, erro: 'sem permissão' };
    const ok = acao === 'finalizar' ? await finalizarCuradoria(dealId) : await arquivarCuradoria(dealId);
    return { ok };
  } catch (e) { console.error('acaoCuradoria falhou:', e.message); return { ok: false, erro: 'falha ao processar' }; }
}

/**
 * Tudo o que o lead preencheu, em texto, dentro do negócio.
 * É desta nota que a automação de curadoria vai ler o briefing.
 */
export function notaDoBriefing(b, resultado, id) {
  const linhas = [
    'AUTO CURADORIA — BRIEFING DO CLIENTE',
    `id: ${id}`,
    '',
    '— CONTATO —',
    `Responsável: ${b.nome}`,
    `Empresa: ${b.empresa}`,
    `E-mail: ${b.email}`,
    `Telefone: ${b.telefone || 'não informado'}`,
    '',
    '— EVENTO —',
    `Tema: ${b.macroTema || 'não informado'}`,
    ...(b.macroTemaSecundario ? [`TEMA_SECUNDARIO: [${b.macroTemaSecundario}]`] : []),
    `Recorte do tema: ${b.microTema || 'não informado'}`,
    `Empresa da palestra: ${b.empresaPalestra || 'não informado'}`,
    `Público-alvo: ${b.publicoAlvo || 'não informado'}`,
    `Formato: ${b.formato || 'não informado'}`,
    `Data: ${dataBR(b.data) || 'a definir'}`,
    `Horário: ${b.horario || 'não informado'}`,
    `Duração do evento: ${b.duracao || 'não informado'}`,
    `Local do evento: ${b.localEvento || 'não informado'}`,
    `Cidade: ${b.cidade || 'não informado'}`,
    `Estado: ${b.local || 'não informado'}`,
    `Orçamento: ${b.orcamento || 'não informado'}`,
    `Evento com venda de ingresso: ${b.vendaIngresso || 'não informado'}`,
    '',
    '— OBJETIVO —',
    `O que motivou a busca: ${b.motivacao || 'não informado'}`,
    `Como o público deve sair: ${b.sentimento || 'não informado'}`,
    `Palestrante desejado pelo cliente: ${b.palestranteDesejado || 'sem preferência informada'}`,
    `Contexto adicional: ${b.briefing?.trim() || '(não preencheu)'}`,
  ];

  if (b.utm && Object.keys(b.utm).length) {
    linhas.push('', '— ORIGEM —', ...Object.entries(b.utm).map(([k, v]) => `${k}: ${v}`));
  }

  if (resultado?.indicacoes?.length) {
    linhas.push('', '— INDICAÇÕES GERADAS —', `Leitura: ${resultado.leitura}`, '');
    resultado.indicacoes.forEach((i, n) => {
      linhas.push(
        `${n + 1}. ${i.nome} (${i.aderencia})`,
        ...i.porque.map(p => `   · ${p}`),
        `   Atenção: ${i.atencao}`,
        i.dados ? `   [interno] ${i.dados.deals} contratações · ${i.dados.ganhos} fechadas · ticket médio R$ ${(i.dados.ticket || 0).toLocaleString('pt-BR')} · plateia mediana ${i.dados.publicoMediano || 'n/i'}` : '',
        '',
      );
    });
  }

  return linhas.filter(l => l !== undefined).join('\n');
}

/** Anota no negócio. Usado para o resultado da curadoria e para cada ação do cliente. */
export async function nota(negocioId, texto) {
  const n = await hs('/crm/v3/objects/notes', 'POST', {
    properties: { hs_note_body: texto.replace(/\n/g, '<br>'), hs_timestamp: Date.now() },
  });
  await hs(`/crm/v4/objects/notes/${n.id}/associations/deals/${negocioId}`, 'PUT', [
    { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 },
  ]);
  return n.id;
}

/**
 * A página vive num domínio da PSA no HubSpot e a curadoria roda aqui.
 * Libera só os domínios da PSA (mais ORIGENS_EXTRA por env) — nada de '*',
 * porque estes endpoints leem e escrevem no CRM.
 */
const ORIGENS = [
  /^https:\/\/([a-z0-9-]+\.)*profissionaissa\.com(\.br)?$/,
  /^https:\/\/([a-z0-9-]+\.)*psapalestras\.com\.br$/,
  /^https:\/\/([a-z0-9-]+\.)*hs-sites\.com$/,          // preview de landing page do HubSpot
  /^https:\/\/psa-auto-curadoria[a-z0-9-]*\.vercel\.app$/,
  /^https:\/\/psasite\.vercel\.app$/,
];

export function cors(req, res) {
  const origem = req.headers.origin || '';
  const extra = (process.env.ORIGENS_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ORIGENS.some(r => r.test(origem)) || extra.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Quantas indicações vão para o cliente. Tunável por env sem mexer no código.
export const N_INDICACOES = Number(process.env.N_INDICACOES || 5);

/**
 * Escolhe as indicações que vão para o cliente a partir do arquivo da IA Curadoria.
 * No máximo UM nome PEDIDO pelo cliente (categoria 'pedido') entra, na frente. Depois vem
 * a curadoria: N=5 na mistura 1 permuta + 2 matriz + 2 melhor geral (sem permuta, 2 matriz
 * + 2 melhores, completando o que faltar na ordem melhores → matriz → permuta).
 * Total = até 1 pedido + até N. Devolver o máximo importa mais que a proporção exata.
 */
export function escolherIndicacoes(lista, n = N_INDICACOES) {
  const porCategoria = cat => lista.filter(x => x.categoria === cat);
  const pedidos = porCategoria('pedido').slice(0, 1);   // só um pedido do cliente
  const permuta = porCategoria('permuta');
  const matriz = porCategoria('matriz');
  const melhores = porCategoria('melhores');

  const cota = permuta.length
    ? { permuta: 1, matriz: 2, melhores: 2 }
    : { permuta: 0, matriz: 2, melhores: 2 };

  const mix = [
    ...permuta.slice(0, cota.permuta),
    ...matriz.slice(0, cota.matriz),
    ...melhores.slice(0, cota.melhores),
  ];
  // completa a mistura até N com o que sobrou, sem repetir
  if (mix.length < n) {
    const sobra = [...melhores, ...matriz, ...permuta].filter(x => !mix.includes(x));
    mix.push(...sobra.slice(0, n - mix.length));
  }

  // pedidos (todos) na frente, depois a mistura (até N); dedup por nome
  const vistos = new Set();
  const out = [];
  for (const x of [...pedidos, ...mix.slice(0, n)]) {
    const k = String(x.nome || '').toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(x);
  }
  return out;
}

/**
 * Anexa a foto de cada palestrante (por id_contato). Ordem: a propriedade
 * `mande_uma_foto_bem_bonita_pra_gente_` (URL limpa) e, se não houver, a 1ª imagem
 * da wiki do palestrante (a foto de perfil). Sem foto -> `foto` fica vazio (o front
 * mostra uma silhueta). Nunca lança: foto é enfeite, não pode derrubar o resultado.
 */
// URL que serve imagem direta. Exclui favicons, SVG e os redirects do HubSpot
// (signed-url-redirect/form-integrations devolvem HTML, não a imagem).
const _ehImagem = u => /^https?:\/\//i.test(u)
  && !/favicons|google\.com\/s2|\.svg(\?|$)|signed-url-redirect|form-integrations/i.test(u);

// redes sociais que extraímos do verbete (ordem de exibição no card fica no front)
const _REDES = [
  ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/[^"'\s?<>]+/ig],
  ['linkedin', /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^"'\s?<>]+/ig],
  ['youtube', /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^"'\s?<>]+/ig],
  ['facebook', /https?:\/\/(?:www\.)?facebook\.com\/[^"'\s?<>]+/ig],
  ['tiktok', /https?:\/\/(?:www\.)?tiktok\.com\/[^"'\s?<>]+/ig],
];
// exclui as redes da PRÓPRIA PSA (se aparecerem em header/footer do verbete)
const _ehRedePSA = u => /psa\.talk|profissionais-sa|profissionaissa|thebestspeaker/i.test(u);

// lê o verbete UMA vez: foto de perfil (1ª imagem) + redes sociais do palestrante
async function _dadosDaWiki(url) {
  const out = { foto: '', redes: {} };
  if (!/^https?:\/\//i.test(url)) return out;
  try {
    const html = await fetch(url, { signal: AbortSignal.timeout(4500) }).then(r => (r.ok ? r.text() : ''));
    out.foto = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m => m[1]).find(_ehImagem) || '';
    for (const [rede, re] of _REDES) {
      const hit = (html.match(re) || []).find(u => !_ehRedePSA(u));
      if (hit) out.redes[rede] = hit;
    }
  } catch (e) { /* verbete off/erro -> sem foto/redes */ }
  return out;
}

export async function anexarFotos(indicacoes) {
  const ids = [...new Set((indicacoes || []).map(i => String(i.id_contato || '').trim()).filter(x => /^\d+$/.test(x)))];
  if (!ids.length) return indicacoes;

  const byId = {};
  try {
    const r = await hs('/crm/v3/objects/contacts/batch/read', 'POST', {
      properties: ['mande_uma_foto_bem_bonita_pra_gente_', 'palestrante_wiki_url'],
      inputs: ids.map(id => ({ id })),
    });
    for (const c of (r.results || [])) byId[c.id] = c.properties || {};
  } catch (e) { console.error('batch de contatos p/ foto falhou:', e.message); }

  await Promise.all((indicacoes || []).map(async (ind) => {
    const p = byId[String(ind.id_contato || '')] || {};
    // verbete: foto de perfil + redes sociais (uma busca só)
    const wiki = await _dadosDaWiki(String(p.palestrante_wiki_url || '').trim());
    // 1) foto da WIKI (curada e confiável); 2) fallback: foto do cadastro (URL de imagem direta)
    if (wiki.foto) ind.foto = wiki.foto;
    else { const direta = String(p.mande_uma_foto_bem_bonita_pra_gente_ || '').trim(); if (_ehImagem(direta)) ind.foto = direta; }
    // redes sociais do palestrante (só as que o verbete tem)
    if (wiki.redes && Object.keys(wiki.redes).length) ind.redes = wiki.redes;
  }));
  return indicacoes;
}

// Propriedade de negócio onde a automação grava os 5 nomes da IA Curadoria.
// Nome configurável para não travar o produto numa escolha minha.
export const PROP_NOMES = process.env.PROP_CURADORIA_NOMES || 'ia_curadoria_nomes';

// Limpa os nomes já publicados no negócio (antes de uma REFAÇÃO): sem isso, um nome que
// sobrou da rodada anterior (a automação grava ~6, mostramos 5) apareceria na hora como se
// fosse a refação, antes de o n8n regenerar. Zera para a tela esperar os nomes novos. Nunca lança.
export async function limparNomesDoNegocio(dealId) {
  if (!dealId) return false;
  try {
    await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: { [PROP_NOMES]: '' } });
    return true;
  } catch (e) { console.error('limparNomesDoNegocio falhou:', e.message); return false; }
}

/**
 * Lê do negócio o que a automação da IA Curadoria deixou.
 * `nomes` é a fonte da verdade; o link fica só como referência interna.
 */
export async function curadoriaDoNegocio(negocioId) {
  const d = await hs(`/crm/v3/objects/deals/${negocioId}?properties=ia_curadoria_link,${PROP_NOMES}`, 'GET');
  return {
    link: d.properties?.ia_curadoria_link || null,
    nomesBruto: d.properties?.[PROP_NOMES] || null,
  };
}

/**
 * Interpreta o conteúdo da propriedade. Aceita JSON (formato preferido) e,
 * como rede, texto em linhas "categoria: nome" — automação que escreve texto
 * puro não pode derrubar a entrega.
 */
export function lerNomes(bruto) {
  if (!bruto || !String(bruto).trim()) return [];
  const texto = String(bruto).trim();

  // Ponto único de entrada do texto da automação: tudo que vem daqui é lavado
  // antes de existir no sistema. O nome do palestrante é o único campo intocado.
  const limpar = t => semTermosInternos(semNumerosInternos(t));

  const normalizar = n => {
    const cru = [n.valor, n.cache, n.cachê, n.perfil, n.atencao, n.atenção,
      Array.isArray(n.porque) ? n.porque.join(' ') : n.porque, n.justificativa]
      .filter(Boolean).join(' ');
    return {
      nome: String(n.nome || n.name || n.palestrante || '').trim(),
      categoria: categoriaCanonica(n.categoria || n.tipo || n.origem || ''),
      // extraído ANTES de limpar: o filtro de cifras apagaria o número
      faixa: faixaDeValor(valorEmReais(cru)),
      // valor de venda EXATO da automação (mostrado ao cliente por decisão do time).
      // Não passa pelo semNumerosInternos; troca o traço do intervalo por "a".
      valorVenda: String(n.valor_venda ?? n.valorVenda ?? n.valor_de_venda ?? '')
        .replace(/\s*[–—-]\s*/, ' a ').replace(/\s{2,}/g, ' ').trim(),
      perfil: limpar(n.perfil),
      porque: comFaixa(
        (Array.isArray(n.porque) ? n.porque.filter(Boolean).map(String)
          : String(n.porque || n.justificativa || '').split('\n'))
          .map(s => limpar(s)).filter(Boolean),
        faixaDeValor(valorEmReais(cru)),
      ),
      atencao: limpar(n.atencao || n.atenção),
      aderencia: String(n.aderencia || '').trim(),
      // Caminho A: a IA Curadoria entrega o id do contato no HubSpot junto do nome.
      // O disparo de disponibilidade usa isso para achar o contato certo sem casar por
      // nome (que é furado: no HubSpot o Drauzio é firstname "Dr" / lastname "Drauzio
      // Varella"). Nunca vai para o cliente — paraCliente() o remove.
      id_contato: String(n.id_contato ?? n.idContato ?? n.contactId ?? '').trim(),
    };
  };

  try {
    const j = JSON.parse(texto);
    const lista = Array.isArray(j) ? j : (j.nomes || j.palestrantes || j.indicacoes || []);
    return lista.map(normalizar).filter(n => n.nome);
  } catch {
    return lerTextoDaAutomacao(texto, normalizar);
  }
}

// Formato que a automação de fato escreve:
//   Permuta: Fulano de Tal
//     - motivo
//     - motivo
//   Melhor geral: Beltrano
//     - motivo
// A categoria pode ter mais de uma palavra ("Melhor geral"), e os motivos vêm
// como marcadores nas linhas seguintes até o próximo cabeçalho.
const RE_CABECALHO = /^\s*(pedido(?:\s+do\s+cliente)?|permutas?|matriz(?:es)?|melhor(?:es)?(?:\s+geral)?|top(?:\s+\w+)?)\s*[:\-—]\s*(.+?)\s*$/i;
const RE_MOTIVO = /^\s*[-–—•*]\s+(.+?)\s*$/;

function lerTextoDaAutomacao(texto, normalizar) {
  const blocos = [];
  let atual = null;

  for (const linha of texto.split('\n')) {
    // Caminho A no formato texto: id do contato opcional no fim do cabeçalho,
    // ex. "Permuta: Fulano de Tal [id:140227412350]". Extraído antes de casar a
    // categoria para não sujar o nome; retrocompatível (linha sem id continua valendo).
    let idContato = '';
    const semId = linha.replace(/\s*\[id:\s*(\d+)\s*\]\s*$/i, (_m, g) => { idContato = g; return ''; });
    const cab = semId.match(RE_CABECALHO);
    if (cab) {
      if (atual) blocos.push(atual);
      atual = { categoria: cab[1], nome: cab[2], id_contato: idContato, porque: [] };
      continue;
    }
    // linha "Valor de venda: R$ X – R$ Y" (vem logo abaixo do cabeçalho)
    const vv = linha.match(/^\s*valor\s+de\s+venda\s*[:\-]\s*(.+?)\s*$/i);
    if (vv && atual) { atual.valor_venda = vv[1]; continue; }
    const motivo = linha.match(RE_MOTIVO);
    if (motivo && atual) atual.porque.push(motivo[1]);
  }
  if (atual) blocos.push(atual);

  return blocos
    .map(b => normalizar({ ...b, porque: b.porque.join('\n') }))
    .filter(n => n.nome && n.categoria);
}

/**
 * Ajusta os motivos agora que a faixa aparece no card.
 * O filtro de cifras deixa "valor sob proposta" no meio da frase; com a faixa
 * disponível, ela entra no lugar. Motivo que só falava do preço é descartado —
 * repetir o que o card já mostra rouba espaço de argumento de verdade.
 */
function comFaixa(motivos, faixa) {
  return motivos
    .map(m => (faixa ? m.replace(/valor sob proposta/gi, faixa) : m))
    .filter(m => {
      if (!faixa) return true;
      const semValor = m.replace(faixa, '').replace(/[^\wÀ-ÿ]/g, ' ').trim();
      return semValor.split(/\s+/).filter(p => p.length > 2).length >= 3;
    });
}

/**
 * Primeiro valor em reais encontrado no texto da automação.
 * Aceita "R$ 8.500", "R$ 8.500,00", "R$ 12 mil", "R$ 1,2 milhão".
 */
export function valorEmReais(texto) {
  // "milh..." antes de "mil": na alternância o primeiro que casa vence, e "mil"
  // é prefixo de "milhão" — invertido, R$ 1,2 milhão viraria R$ 1.200.
  const m = String(texto || '').match(/R\$\s?(\d[\d.]*(?:,\d+)?)\s*(milh(?:ão|ões)|mil|k)?/i);
  if (!m) return null;
  const numero = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(numero)) return null;
  const escala = /^(mil|k)$/i.test(m[2] || '') ? 1000 : /milh/i.test(m[2] || '') ? 1e6 : 1;
  return Math.round(numero * escala);
}

/**
 * Converte o cachê numa faixa. O cliente se localiza sem que a PSA entregue o
 * valor exato — que é a posição de negociação dela.
 */
export function faixaDeValor(reais) {
  if (!reais || reais <= 0) return null;
  if (reais <= 5000) return 'até R$ 5 mil';
  if (reais <= 10000) return 'entre R$ 5 e 10 mil';
  if (reais <= 20000) return 'entre R$ 10 e 20 mil';
  if (reais <= 50000) return 'entre R$ 20 e 50 mil';
  if (reais <= 100000) return 'entre R$ 50 e 100 mil';
  return 'acima de R$ 100 mil';
}

const categoriaCanonica = v => {
  const s = String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (s.startsWith('pedido')) return 'pedido';   // nome que o cliente pediu explicitamente
  if (s.startsWith('permut')) return 'permuta';
  if (s.startsWith('matriz')) return 'matriz';
  if (s.startsWith('melhor') || s.startsWith('top')) return 'melhores';
  return s;
};

export function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((ok, falha) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 1e6) falha(new Error('corpo grande demais')); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { falha(e); } });
  });
}

/**
 * Versão do resultado que pode sair para o cliente.
 * `dados` guarda o registro bruto do palestrante (contratações, ticket, plateia) —
 * serve para a nota interna no HubSpot e para auditoria, e não pode ir no JSON da
 * resposta, senão vaza no devtools mesmo sem aparecer na tela.
 */
export function paraCliente(resultado) {
  return {
    leitura: resultado.leitura,
    incompleto: resultado.incompleto || false,   // veio com menos de 3 (curador completa)
    // `categoria` diz se o nome veio de permuta — saber que a PSA não paga cachê
    // àquele palestrante é informação comercial nossa, não do cliente.
    indicacoes: resultado.indicacoes.map(({ dados, id, categoria, id_contato, ...visivel }) => visivel),
  };
}

/** O que o cliente vê antes de pagar: perfil e primeira linha, o resto fica no cofre. */
export function teaser(resultado) {
  return {
    leitura: resultado.leitura,
    indicacoes: resultado.indicacoes.map(i => ({
      perfil: i.perfil,
      aderencia: i.aderencia,
      primeiroMotivo: i.porque[0],
      motivosOcultos: i.porque.length - 1,
    })),
  };
}

/**
 * Palestrante não é registro próprio no CRM: é opção do dropdown do negócio, e no
 * comercial existe como PRODUTO — os 32 mil itens de linha do portal todos carregam
 * hs_product_id. Para criar item de linha da Auto Curadoria, então, é preciso achar
 * o produto do nome indicado.
 *
 * Resolvido em runtime, e não num mapa gerado no build, porque a base de produtos é
 * feita à mão e muda todo dia (3.579 produtos para ~590 palestrantes do roster, com
 * "TANIA GENGO", "Kátia Stocco Smole" e "Danilo" convivendo). Mapa gerado nasceria
 * velho; busca por nome erra igual, mas erra na hora e dá para avisar.
 *
 * Quando não resolve — zero resultado ou mais de um — devolve null em vez de chutar:
 * vincular o palestrante errado faz o time pesquisar disponibilidade de outra pessoa.
 */
// Chave de comparação de nome: reusa semAcento e ainda achata pontuação e espaço
// repetido, para "Maria  De Souza-Lima" e "maria de souza lima" caírem no mesmo lugar.
export const chaveDeNome = s => semAcento(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim();

const CHAVE_INDICE = 'auto-curadoria:produtos';

/**
 * Índice chaveDeNome -> ids de produto, para a segunda tentativa do match.
 * Existe porque o nome que a curadoria mostra vem do slug do dropdown de negócio, e o
 * slug perdeu o acento — `build-dataset.mjs` documenta isso ("Giovane Gavio",
 * "Joao Kepler"). O EQ da API compara o valor gravado, então acento faltando derruba
 * boa parte da base; comparar sem acento resolve a classe inteira de uma vez.
 *
 * Cacheado 24h no Redis que o app já usa: montar custa ~36 páginas e só vale uma vez
 * por dia. Índice incompleto NÃO é cacheado — 24h com metade dos produtos faria o
 * match falhar para nome que existe, e ninguém entenderia por quê.
 */
async function indiceDeProdutos() {
  const cache = await redis().get(CHAVE_INDICE);
  if (cache) return JSON.parse(cache);

  const idx = {};
  let after, paginas = 0, completo = false;
  const limite = Date.now() + 8000;          // a requisição do cliente não pode expirar aqui
  do {
    const r = await hs(`/crm/v3/objects/products?limit=100&properties=name${after ? `&after=${after}` : ''}`, 'GET');
    for (const p of r.results || []) {
      const k = chaveDeNome(p.properties?.name);
      if (k) (idx[k] = idx[k] || []).push(p.id);
    }
    after = r.paging?.next?.after;
    if (!after) completo = true;
  } while (after && ++paginas < 60 && Date.now() < limite);

  if (completo) await redis().set(CHAVE_INDICE, JSON.stringify(idx), 'EX', 60 * 60 * 24);
  return idx;
}

export async function produtoPorNome(nome) {
  const busca = String(nome || '').trim();
  if (!busca) return null;

  // 1ª tentativa: nome exato. Resolve a maioria numa chamada, sem montar índice.
  const r = await hs('/crm/v3/objects/products/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: busca }] }],
    properties: ['name'],
    limit: 2,
  });
  if (r.total === 1) return r.results[0].id;

  // 2ª tentativa: sem acento e sem pontuação, contra o índice.
  const ids = (await indiceDeProdutos())[chaveDeNome(busca)] || [];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Cria um item de linha por palestrante selecionado, associado ao negócio.
 * Sem preço: ao vincular hs_product_id o HubSpot copia o cachê do produto, que é
 * como o time já faz. Quantidade 1, igual ao padrão do portal.
 *
 * Nunca lança: o pedido do cliente não pode falhar porque a base de produtos está
 * suja. Devolve o que vinculou e o que não, para a nota dizer ao time o que sobrou
 * para vincular à mão.
 */
export async function criarItensDeLinha(negocioId, nomes) {
  const vinculados = [], semProduto = [];
  for (const nome of nomes) {
    try {
      const produtoId = await produtoPorNome(nome);
      if (!produtoId) { semProduto.push(nome); continue; }
      await hs('/crm/v3/objects/line_items', 'POST', {
        properties: { hs_product_id: produtoId, quantity: '1' },
        associations: [{
          to: { id: String(negocioId) },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }],
        }],
      });
      vinculados.push(nome);
    } catch (e) {
      console.error(`item de linha de ${nome} falhou:`, e.message);
      semProduto.push(nome);
    }
  }
  return { vinculados, semProduto };
}

/* ── Disparo da pesquisa de disponibilidade (WhatsApp) ──────────────────────
 * Reaproveita o pipeline do palestrantes-app: grava os campos pesq_* + o gatilho
 * pesq_disparar=true NO CONTATO do palestrante; o workflow "disparo whats palestrante"
 * (HubSpot) espera ~5min, envia o WhatsApp e cria o tíquete. Aqui NÃO criamos tíquete
 * nem enviamos WhatsApp — só fazemos o staging.
 *
 * A identidade vem do id_contato que a IA Curadoria grava junto do nome (Caminho A),
 * então não há casamento de nome no HubSpot.
 */
const CONTACT_TRIGGER = 'pesq_disparar';

const _fmtDataBR = v => {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : (s || '-');
};

// controle de duplicidade, no MESMO formato do palestrantes-app ("dealId=assinatura")
function _parseSigs(text) {
  const map = {};
  String(text || '').split('\n').forEach(l => {
    const i = l.indexOf('=');
    if (i > 0) map[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  });
  return map;
}
const _serializeSigs = map => Object.keys(map).map(k => `${k}=${map[k]}`).join('\n');

// para E.164 (+55…); vazio quando não dá para inferir — igual à filosofia do resto do app
function _normalizePhone(v) {
  let s = String(v || '').trim();
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  s = s.replace(/\D/g, '');
  if (!s) return '';
  if (s.startsWith('55') && (s.length === 12 || s.length === 13)) return `+${s}`;
  if (s.length === 10 || s.length === 11) return `+55${s}`;
  return `+${s}`;
}

/**
 * Dispara a pesquisa de disponibilidade para cada palestrante escolhido.
 * `indicacoes` são os objetos escolhidos (têm nome + id_contato). Nunca lança:
 * o pedido do cliente não pode falhar por causa do disparo. Devolve o que disparou,
 * o que não tinha contato e o que já estava disparado (dedup).
 */
export async function dispararDisponibilidade(negocioId, indicacoes, briefing, datas) {
  const disparados = [], semContato = [], semTelefone = [], jaDisparado = [], falhas = [];

  // dados do evento — iguais para todos os palestrantes deste negócio, montados uma vez
  const local = [
    briefing.localEvento,
    [briefing.cidade, briefing.local].filter(Boolean).join('/'), // briefing.local = ESTADO
  ].filter(Boolean).join(' — ');
  const tema = [briefing.macroTema, briefing.microTema].filter(Boolean).join(' — ');
  // o palestrante precisa saber PARA QUAL empresa é a palestra (empresaPalestra); só se
  // o cliente não informou, cai na empresa que fez o briefing (a compradora).
  const empresaCliente = (briefing.empresaPalestra || briefing.empresa || '').trim();
  const obs = [
    datas ? `Datas desejadas: ${datas}.` : '',
    `Solicitado por ${empresaCliente} via Auto Curadoria.`.replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join(' ');

  // a data do evento pode não estar no briefing ("a definir"); nesse caso usamos a data
  // que o cliente informou ao solicitar disponibilidade (datas, já em DD/MM/AAAA).
  const _dataEvento = _fmtDataBR(briefing.data);
  const ev = {
    pesq_cliente: empresaCliente || '-',
    pesq_formato: briefing.formato || '-',
    pesq_tema: tema || '-',
    pesq_publico: briefing.publicoAlvo || '-',
    pesq_data: (_dataEvento && _dataEvento !== '-') ? _dataEvento : (String(datas || '').trim() || '-'),
    pesq_horario: briefing.horario || '-',
    pesq_local: local || '-',
    pesq_duracao: briefing.duracao || '-',
    pesq_ingresso: briefing.vendaIngresso || '-',
    pesq_obs: obs || '-',
  };
  const resumo = [
    `🤝 Cliente: ${ev.pesq_cliente}`,
    `🎟️ Formato do evento: ${ev.pesq_formato}`,
    `🎯 Tema: ${ev.pesq_tema}`,
    `👥 Perfil do público: ${ev.pesq_publico}`,
    `📅 Data: ${ev.pesq_data}`,
    `🕐 Horário: ${ev.pesq_horario}`,
    `📍 Local: ${ev.pesq_local}`,
    `⏱️ Duração: ${ev.pesq_duracao}`,
    `🎫 Venda de ingresso: ${ev.pesq_ingresso}`,
    `📝 Observações: ${ev.pesq_obs}`,
  ].join('\n');
  const sig = `${ev.pesq_data}||${ev.pesq_local}`;

  // dono do negócio → o workflow copia para dono_negocio do tíquete (opcional)
  let dealOwner = '';
  try {
    const d = await hs(`/crm/v3/objects/deals/${negocioId}?properties=hubspot_owner_id`, 'GET');
    dealOwner = String(d.properties?.hubspot_owner_id || '').trim();
  } catch (e) { console.error('leitura do dono do negócio falhou:', e.message); }

  for (const ind of indicacoes) {
    const contatoId = String(ind.id_contato || '').trim();
    if (!/^\d+$/.test(contatoId)) { semContato.push(ind.nome); continue; }
    try {
      // lê estado atual: assinaturas (dedup) + telefone do próprio contato do palestrante
      let atual = {};
      try {
        const c = await hs(
          `/crm/v3/objects/contacts/${contatoId}?properties=pesq_assinaturas,phone,hs_whatsapp_phone_number`,
          'GET',
        );
        atual = c.properties || {};
      } catch (e) { console.error(`leitura do contato ${contatoId} falhou:`, e.message); }

      const sigs = _parseSigs(atual.pesq_assinaturas || '');
      // dedup: mesma data+local já disparada para este palestrante+negócio? não repete
      if (sigs[String(negocioId)] === sig) { jaDisparado.push(ind.nome); continue; }

      const phone = _normalizePhone(atual.phone);
      const temWhats = String(atual.hs_whatsapp_phone_number || '').trim();
      if (!phone && !temWhats) { semTelefone.push(ind.nome); continue; }

      const props = {
        ...ev,
        pesq_deal_id: String(negocioId),
        pesq_resumo: resumo,
        pesq_assinaturas: _serializeSigs({ ...sigs, [String(negocioId)]: sig }),
        [CONTACT_TRIGGER]: 'true',
      };
      // reescreve phone (E.164) p/ o fluxo de correção do número rodar antes do envio,
      // como o card faz; só quando há telefone no contato
      if (phone) props.phone = phone;
      if (dealOwner) props.pesq_deal_owner = dealOwner;

      // PATCH tolerante: se o HubSpot recusar alguma propriedade (ex.: pesq_deal_owner é
      // um select SEM opções e rejeita qualquer valor -> 400 derrubava o disparo inteiro
      // em negócios com dono), descarta a recusada e reenvia. NUNCA dropa o gatilho.
      for (let tentativa = 0; tentativa < 6; tentativa++) {
        try {
          await hs(`/crm/v3/objects/contacts/${contatoId}`, 'PATCH', { properties: props });
          break;
        } catch (err) {
          const recusadas = [...err.message.matchAll(/"name\\?":\\?"([a-z0-9_]+)\\?"/g)].map(m => m[1])
            .filter(p => p in props && p !== CONTACT_TRIGGER);
          if (!recusadas.length) throw err;
          for (const p of recusadas) delete props[p];
          console.error('PESQ_PROP_RECUSADA', recusadas.join(','), '— disparo segue sem ela');
        }
      }
      disparados.push(ind.nome);
    } catch (e) {
      console.error(`disparo de disponibilidade de ${ind.nome} (${contatoId}) falhou:`, e.message);
      falhas.push(ind.nome);
    }
  }

  return { disparados, semContato, semTelefone, jaDisparado, falhas };
}

// valor numérico do tíquete -> "R$ 15.000" (0/inválido -> vazio)
const _valorBRL = v => { const n = Math.round(Number(v)); return (!n || isNaN(n)) ? '' : 'R$ ' + n.toLocaleString('pt-BR'); };

/* Respostas de disponibilidade dos palestrantes, para mostrar no card do cliente.
 * Lê a propriedade `respostas_disponibilidade` do PRÓPRIO negócio (o tool já lê
 * negócio — sem depender de escopo de tickets). A automação do HubSpot, quando o
 * palestrante responde no tíquete, grava lá um JSON { <id_contato>: {d,v,o} }
 * (d=disponibilidade, v=valor_total, o=observação). Por-negócio: sem staleness.
 * Nunca lança — a resposta é enfeite do card, não pode derrubar o resultado. */
export async function respostasDisponibilidade(negocioId) {
  const out = {};   // { <id_contato>: { disponivel, valor, obs } }
  if (!negocioId) return out;
  try {
    const d = await hs(`/crm/v3/objects/deals/${negocioId}?properties=respostas_disponibilidade`, 'GET');
    const raw = String(d.properties?.respostas_disponibilidade || '').trim();
    if (!raw) return out;
    let mapa;
    try { mapa = JSON.parse(raw); } catch (e) { return out; }
    for (const [cid, r] of Object.entries(mapa || {})) {
      const disp = String(r?.d || '').trim().toLowerCase();
      const obs = String(r?.o || '').trim();
      if (!disp && !obs) continue;
      out[String(cid)] = {
        disponivel: disp === 'disponivel' ? true : (disp === 'indisponivel' ? false : null),
        valor: _valorBRL(r?.v),
        obs,
      };
    }
  } catch (e) { console.error('respostasDisponibilidade falhou:', e.message); }
  return out;
}

/* ── Paywall por CPF/CNPJ ────────────────────────────────────────────────────
 * Acesso à Auto Curadoria é liberado só para quem tem um negócio "Pago" na pipeline
 * Auto Curadoria. O CPF/CNPJ (informado na entrada) casa com o contato comprador
 * (propriedades `cpf`/`cnpj`), e o negócio "Pago" associado é o crédito. Ao gerar a
 * curadoria, esse negócio vira "Utilizado".
 */

// só dígitos -> {tipo:'cpf'|'cnpj', valor} ou null. 11 díg = CPF, 14 = CNPJ.
export function normalizaDocumento(bruto) {
  const d = String(bruto || '').replace(/\D/g, '');
  if (d.length === 11) return { tipo: 'cpf', valor: d };
  if (d.length === 14) return { tipo: 'cnpj', valor: d };
  return null;
}

/**
 * Acha o negócio "Pago" MAIS ANTIGO (fila) na pipeline Auto Curadoria para um CPF/CNPJ.
 * Casa o documento no contato (cpf ou cnpj), depois busca o negócio Pago associado.
 * Devolve { dealId, contatoId, doc } ou null (sem compra liberada).
 */
// Base compartilhada: acha o negócio da pipeline Auto Curadoria numa etapa, casado pelo
// CPF/CNPJ (no contato) e associado a ele. `direction` escolhe o mais antigo/recente.
async function _negocioAutoCuradoriaPorDoc(bruto, stage, direction, extraProps = []) {
  const doc = normalizaDocumento(bruto);
  if (!doc) return null;

  // 1) contatos com esse cpf/cnpj (o checkout grava só dígitos, ex.: "01608209016")
  const contatos = await hs('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: doc.tipo, operator: 'EQ', value: doc.valor }] }],
    properties: [doc.tipo],
    limit: 100,
  });
  const ids = (contatos.results || []).map((c) => c.id);
  if (!ids.length) return null;

  // 2) negócio na etapa pedida, associado a esses contatos. Cada contato = filterGroup (OR), até 5.
  const deals = await hs('/crm/v3/objects/deals/search', 'POST', {
    filterGroups: ids.slice(0, 5).map((cid) => ({
      filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: PIPE_AUTOCURADORIA },
        { propertyName: 'dealstage', operator: 'EQ', value: stage },
        { propertyName: 'associations.contact', operator: 'EQ', value: cid },
      ],
    })),
    sorts: [{ propertyName: 'createdate', direction }],
    properties: ['dealname', 'dealstage', 'createdate', ...extraProps],
    limit: 1,
  });
  const d = (deals.results || [])[0];
  return d ? { dealId: d.id, contatoId: ids[0], doc, props: d.properties || {} } : null;
}

// Negócio "Pago" MAIS ANTIGO (fila): libera o acesso e é o crédito que a geração consome.
export async function creditoPagoPorDocumento(bruto) {
  return _negocioAutoCuradoriaPorDoc(bruto, STAGE_PAGO, 'ASCENDING');
}

// Assinatura: o negócio "Pago" vale como acesso por 1 ANO a partir da data de pagamento
// (usa `closedate`; cai no `createdate` se vazio). Ativa => curadorias ILIMITADAS. Passado
// 1 ano e ainda "Pago", expira preguiçoso (move p/ "Utilizado"). Nunca lança.
const ANO_MS = 365 * 24 * 60 * 60 * 1000;
export async function assinaturaAtivaPorDocumento(bruto) {
  const found = await _negocioAutoCuradoriaPorDoc(bruto, STAGE_PAGO, 'DESCENDING', ['closedate']);
  if (!found) return null;
  const dataPag = found.props.closedate || found.props.createdate || '';
  // HubSpot devolve datas como epoch em ms (string só de dígitos); Date.parse disso dá NaN.
  const raw = String(dataPag).trim();
  const ts = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw);
  // sem data legível -> considera ativa (não travar acesso por falta de campo)
  const ativa = Number.isFinite(ts) ? (Date.now() - ts) < ANO_MS : true;
  const vence = Number.isFinite(ts) ? new Date(ts + ANO_MS).toISOString() : null;
  if (!ativa) {
    try { await hs(`/crm/v3/objects/deals/${found.dealId}`, 'PATCH', { properties: { dealstage: STAGE_UTILIZADO } }); }
    catch (e) { console.error('expiração da assinatura falhou:', e.message); }
  }
  return { dealId: found.dealId, contatoId: found.contatoId, doc: found.doc, ativa, vence };
}

/**
 * Decisão do gate a partir do CPF/CNPJ (o CPF vira a chave da curadoria):
 *  - 'novo'     : tem compra "Pago" -> briefing novo
 *  - 'retomar'  : só "Utilizado", mas a curadoria ainda tem refação -> retomar (devolve id)
 *  - 'esgotado' : "Utilizado" sem refação, ou a curadoria expirou -> checkout
 *  - 'nenhum'   : nada -> checkout
 *  - 'invalido' : documento mal formado
 */
// dados do contato comprador (já temos no HubSpot) p/ pré-preencher o briefing
export async function dadosContato(contatoId) {
  if (!contatoId) return {};
  try {
    const c = await hs(`/crm/v3/objects/contacts/${contatoId}?properties=firstname,lastname,email,phone,company`, 'GET');
    const p = c.properties || {};
    const nome = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
    return { nome, empresa: (p.company || '').trim(), email: (p.email || '').trim(), telefone: (p.phone || '').trim() };
  } catch (e) {
    console.error('dadosContato falhou:', e.message);
    return {};
  }
}

/**
 * Lista TODAS as curadorias visíveis de um CPF/CNPJ (negócios "Utilizado" da pipeline
 * Auto Curadoria com a sessão viva no Redis), da mais recente pra mais antiga. Cada item
 * traz { id, label } para o cliente escolher qual ver. Nunca lança.
 */
export async function listarCuradorias(bruto) {
  const doc = normalizaDocumento(bruto);
  if (!doc) return [];
  try {
    const contatos = await hs('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: doc.tipo, operator: 'EQ', value: doc.valor }] }],
      properties: [doc.tipo], limit: 100,
    });
    const ids = (contatos.results || []).map((c) => c.id);
    if (!ids.length) return [];
    // curadorias = negócios nas etapas "Curadorias criadas"/"Curadorias finalizadas" (por nome).
    // Se as etapas ainda não existem, cai no legado "Utilizado" (compat. com curadorias antigas).
    const [stCriada, stFinal] = await Promise.all([
      stageIdPorNome(NOME_STAGE.criada), stageIdPorNome(NOME_STAGE.finalizada),
    ]);
    const stagesCuradoria = [stCriada, stFinal].filter(Boolean);
    const stageFiltro = stagesCuradoria.length
      ? { propertyName: 'dealstage', operator: 'IN', values: stagesCuradoria }
      : { propertyName: 'dealstage', operator: 'EQ', value: STAGE_UTILIZADO };
    const deals = await hs('/crm/v3/objects/deals/search', 'POST', {
      filterGroups: ids.slice(0, 5).map((cid) => ({
        filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: PIPE_AUTOCURADORIA },
          stageFiltro,
          { propertyName: 'associations.contact', operator: 'EQ', value: cid },
        ],
      })),
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      properties: ['dealname', 'createdate', 'dealstage'],
      limit: 100,
    });
    const out = [];
    const vistos = new Set();
    for (const d of (deals.results || [])) {
      const uuid = await redis().get(chaveDeal(d.id));
      if (!uuid || vistos.has(uuid)) continue;
      const bruto2 = await redis().get(chave(uuid));
      if (!bruto2) continue;
      let reg; try { reg = JSON.parse(bruto2); } catch (e) { continue; }
      vistos.add(uuid);
      const b = reg.briefing || {};
      // rótulo = empresa do evento + data do evento (a definir quando o briefing não teve data).
      const empresa = String(b.empresaPalestra || b.empresa || '').trim();
      const nome = String(b.nome || '').trim();
      const label = [empresa || nome || 'Curadoria', dataBR(b.data) ? `evento ${dataBR(b.data)}` : 'evento a definir'].join(' · ');
      const finalizada = !!stFinal && String(d.properties?.dealstage) === String(stFinal);
      out.push({ id: uuid, label, criadoEm: reg.criadoEm || null, finalizada });
    }
    return out;
  } catch (e) { console.error('listarCuradorias falhou:', e.message); return []; }
}

export async function decidirAcesso(bruto) {
  if (!normalizaDocumento(bruto)) return { modo: 'invalido' };
  const assin = await assinaturaAtivaPorDocumento(bruto);
  const curadorias = await listarCuradorias(bruto);
  const ativa = !!(assin && assin.ativa);

  // Assinante ATIVO monta curadorias ILIMITADAS: sempre pode criar nova (podeNova) e ver as
  // antigas. Assinatura expirada: ainda vê as antigas, mas para criar nova precisa renovar.
  if (curadorias.length) {
    return { modo: 'escolher', curadorias, podeNova: ativa, contatoId: assin ? assin.contatoId : '' };
  }
  if (ativa) return { modo: 'novo', contatoId: assin.contatoId };
  // sem curadorias: assinatura existente porém expirada -> esgotado (renovar); nada -> nenhum
  return { modo: assin ? 'esgotado' : 'nenhum' };
}

/**
 * Consome o crédito: move o negócio para "Utilizado". Idempotente e nunca lança —
 * só move se ainda estiver "Pago" na pipeline certa (evita reconsumir numa refação
 * ou mexer num negócio de outra pipeline). Devolve true se moveu.
 */
export async function consumirCredito(dealId) {
  if (!dealId) return false;
  try {
    const d = await hs(`/crm/v3/objects/deals/${dealId}?properties=pipeline,dealstage`, 'GET');
    const p = d.properties || {};
    if (p.pipeline !== PIPE_AUTOCURADORIA || p.dealstage !== STAGE_PAGO) return false;
    await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: { dealstage: STAGE_UTILIZADO } });
    return true;
  } catch (e) {
    console.error('consumirCredito falhou:', e.message);
    return false;
  }
}
