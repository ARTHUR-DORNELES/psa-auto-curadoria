import Redis from 'ioredis';

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
const HS = 'https://api.hubapi.com';

let _redis;
export function redis() {
  if (!_redis) _redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  return _redis;
}

export const chave = id => `autocuradoria:${id}`;

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
    `Recorte do tema: ${b.microTema || 'não informado'}`,
    `Público-alvo: ${b.publicoAlvo || 'não informado'}`,
    `Formato: ${b.formato || 'não informado'}`,
    `Data: ${dataBR(b.data) || 'a definir'}`,
    `Horário: ${b.horario || 'não informado'}`,
    `Duração da palestra: ${b.duracao || 'não informado'}`,
    `Local do evento: ${b.localEvento || 'não informado'}`,
    `Cidade: ${b.cidade || 'não informado'}`,
    `Estado: ${b.local || 'não informado'}`,
    `Orçamento: ${b.orcamento || 'não informado'}`,
    `Evento com venda de ingresso: ${b.vendaIngresso || 'não informado'}`,
    '',
    '— OBJETIVO —',
    `O que motivou a busca: ${b.motivacao || 'não informado'}`,
    `Como o público deve sair: ${b.sentimento || 'não informado'}`,
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

/**
 * Escolhe as 3 indicações que vão para o cliente a partir das 5 do arquivo da IA Curadoria.
 * Regra: 1 permuta + 1 matriz + 1 melhores.
 * Sem permuta no arquivo: 2 matriz + 1 melhores.
 * Falta de estoque em qualquer categoria é coberta pelas outras, na ordem melhores → matriz → permuta,
 * porque devolver menos de 3 nomes é pior do que desrespeitar a proporção.
 */
export function escolherTres(cinco) {
  const porCategoria = cat => cinco.filter(n => n.categoria === cat);
  const permuta = porCategoria('permuta');
  const matriz = porCategoria('matriz');
  const melhores = porCategoria('melhores');

  const cota = permuta.length
    ? { permuta: 1, matriz: 1, melhores: 1 }
    : { permuta: 0, matriz: 2, melhores: 1 };

  const escolhidos = [
    ...permuta.slice(0, cota.permuta),
    ...matriz.slice(0, cota.matriz),
    ...melhores.slice(0, cota.melhores),
  ];

  // completa com o que sobrou, sem repetir
  if (escolhidos.length < 3) {
    const sobra = [...melhores, ...matriz, ...permuta].filter(n => !escolhidos.includes(n));
    escolhidos.push(...sobra.slice(0, 3 - escolhidos.length));
  }

  return escolhidos.slice(0, 3);
}

// Propriedade de negócio onde a automação grava os 5 nomes da IA Curadoria.
// Nome configurável para não travar o produto numa escolha minha.
export const PROP_NOMES = process.env.PROP_CURADORIA_NOMES || 'ia_curadoria_nomes';

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
      perfil: limpar(n.perfil),
      porque: comFaixa(
        (Array.isArray(n.porque) ? n.porque.filter(Boolean).map(String)
          : String(n.porque || n.justificativa || '').split('\n'))
          .map(s => limpar(s)).filter(Boolean),
        faixaDeValor(valorEmReais(cru)),
      ),
      atencao: limpar(n.atencao || n.atenção),
      aderencia: String(n.aderencia || '').trim(),
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
const RE_CABECALHO = /^\s*(permutas?|matriz(?:es)?|melhor(?:es)?(?:\s+geral)?|top(?:\s+\w+)?)\s*[:\-—]\s*(.+?)\s*$/i;
const RE_MOTIVO = /^\s*[-–—•*]\s+(.+?)\s*$/;

function lerTextoDaAutomacao(texto, normalizar) {
  const blocos = [];
  let atual = null;

  for (const linha of texto.split('\n')) {
    const cab = linha.match(RE_CABECALHO);
    if (cab) {
      if (atual) blocos.push(atual);
      atual = { categoria: cab[1], nome: cab[2], porque: [] };
      continue;
    }
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
    // `categoria` diz se o nome veio de permuta — saber que a PSA não paga cachê
    // àquele palestrante é informação comercial nossa, não do cliente.
    indicacoes: resultado.indicacoes.map(({ dados, id, categoria, ...visivel }) => visivel),
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
