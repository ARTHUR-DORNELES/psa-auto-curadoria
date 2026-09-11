import Anthropic from '@anthropic-ai/sdk';
import { lerCorpo, cors } from './_lib.js';
import {
  MACRO, ORCAMENTOS, FORMATOS, ESTADOS, CIDADES, MICRO,
  PUBLICO_ALVO, MOTIVACOES, SENTIMENTOS, DURACOES, VENDA_INGRESSO,
} from './_enums.js';

// Santiago: o curador que conduz o briefing por conversa. O Claude phraseia e extrai;
// o SERVIDOR é a autoridade dos enums (só aceita valor válido) e da completude.
const MODEL = 'claude-sonnet-5';

// espelha os obrigatórios do curar.js (+ estado, que lá é briefing.local). A DATA é
// opcional (pode ser "a definir"; só obrigatória ao solicitar disponibilidade).
const OBRIGATORIOS = ['nome', 'empresa', 'email', 'telefone', 'macroTema', 'publicoAlvo',
  'horario', 'duracao', 'localEvento', 'estado', 'cidade', 'orcamento',
  'vendaIngresso', 'motivacao', 'sentimento', 'palestranteDesejado', 'empresaPalestra'];

// campos de valor fechado -> validados contra a lista e travados no schema de saída
const ENUM = {
  macroTema: MACRO, formato: FORMATOS, orcamento: ORCAMENTOS, duracao: DURACOES,
  publicoAlvo: PUBLICO_ALVO, motivacao: MOTIVACOES, sentimento: SENTIMENTOS,
  vendaIngresso: VENDA_INGRESSO, estado: ESTADOS,
};
// campos que aceitam MAIS DE UM valor da lista (o evento pode ter vários públicos)
const MULTI = new Set(['publicoAlvo']);
const partesMulti = v => [...new Set(String(v || '').split(/\s*[,;|]\s*/).map(x => x.trim()).filter(Boolean))];
// campos com sugestões em chips MAS que aceitam texto livre ("Outro") — não travam na lista
const SUGESTAO = new Set(['motivacao', 'sentimento']);

const rotuloCampo = {
  nome: 'nome do responsável', empresa: 'empresa', email: 'e-mail corporativo', telefone: 'telefone',
  macroTema: 'tema do evento', microTema: 'recorte do tema', publicoAlvo: 'público-alvo',
  formato: 'formato', data: 'data do evento', horario: 'horário', duracao: 'duração',
  localEvento: 'local do evento (nome do espaço)', estado: 'estado', cidade: 'cidade',
  orcamento: 'orçamento', vendaIngresso: 'evento com venda de ingresso?',
  motivacao: 'o que motivou a busca por esse tema', sentimento: 'como o público deve sair do evento',
  palestranteDesejado: 'algum palestrante específico que já gostaria (se não tiver, tudo bem)',
  empresaPalestra: 'para qual empresa é essa palestra',
  contexto: 'algum contexto extra (opcional)',
};

// subtemas do macro escolhido (MICRO é chaveado por "1".."25" = prefixo do macro)
const subtemasDe = macro => MICRO[String(macro || '').match(/^(\d+)\./)?.[1]] || [];

// backstop de estilo: remove travessão que o modelo insista em usar
const semTravessao = s => String(s || '')
  .replace(/\s*[—–]\s*/g, ', ')
  .replace(/,\s*,/g, ',')
  .replace(/\s+([,.!?;:])/g, '$1')
  .replace(/\s{2,}/g, ' ')
  .trim();

// data do evento não pode ser retroativa (o evento é sempre no futuro)
const hojeISO = () => new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (UTC, perto o bastante)
const dataNoPassado = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso < hojeISO();

// widget que o front renderiza para captar o próximo campo
function widgetPara(campo, slots) {
  if (SUGESTAO.has(campo)) return { campo, tipo: 'chips-livre', opcoes: ENUM[campo] };   // chips + "Outro"
  if (MULTI.has(campo)) return { campo, tipo: 'chips-multi', opcoes: ENUM[campo] };
  if (ENUM[campo]) return { campo, tipo: 'chips', opcoes: ENUM[campo] };
  if (campo === 'cidade') return { campo, tipo: 'busca', opcoes: CIDADES[slots.estado] || [] };   // autocomplete (lista grande)
  if (campo === 'microTema') return { campo, tipo: 'chips', opcoes: subtemasDe(slots.macroTema) };
  if (campo === 'data') return { campo, tipo: 'data', min: hojeISO(), atalhos: ['A definir'] };   // trava datas passadas; "A definir" pula
  if (campo === 'horario') return { campo, tipo: 'hora' };
  // "já tem palestrante em mente?" -> texto livre com atalho "Não tenho"
  if (campo === 'palestranteDesejado') return { campo, tipo: 'texto', atalhos: ['Não tenho preferência'], placeholder: 'Nome do palestrante (ou toque em "Não tenho")' };
  return { campo, tipo: 'texto' };
}

// backstop: a resposta do usuário ao widget é aceitável para aquele campo? (validação leve)
function aceitaBackstop(campo, val, slots) {
  if (SUGESTAO.has(campo)) return String(val || '').trim().length > 0;   // aceita qualquer texto
  if (MULTI.has(campo)) { const opts = ENUM[campo] || []; return partesMulti(val).some(p => opts.includes(p)); }
  if (ENUM[campo]) return ENUM[campo].includes(val);
  if (campo === 'cidade') return (CIDADES[slots.estado] || []).includes(val);
  if (campo === 'microTema') return subtemasDe(slots.macroTema).includes(val);
  if (campo === 'data') return /^\d{4}-\d{2}-\d{2}$/.test(val) && !dataNoPassado(val);
  if (campo === 'horario') return /^\d{1,2}:\d{2}$/.test(val);
  if (campo === 'email') return /\S+@\S+\.\S+/.test(val);
  if (campo === 'telefone') return val.replace(/\D/g, '').length >= 10;
  return true;   // nome, empresa, localEvento, contexto -> qualquer texto serve
}

// schema da saída estruturada — os enums fixos ficam TRAVADOS aqui (o Claude não inventa valor)
const propsCampos = {
  nome: { type: 'string' }, empresa: { type: 'string' }, email: { type: 'string' },
  telefone: { type: 'string' }, microTema: { type: 'string' },
  palestranteDesejado: { type: 'string' }, empresaPalestra: { type: 'string' },
  localEvento: { type: 'string' }, cidade: { type: 'string' },
  data: { type: 'string', description: 'YYYY-MM-DD' }, horario: { type: 'string', description: 'HH:MM' },
  contexto: { type: 'string' },
};
for (const [k, lista] of Object.entries(ENUM)) propsCampos[k] = { type: 'string', enum: lista };
// publicoAlvo aceita mais de um valor -> string livre (o servidor valida cada parte contra a lista)
propsCampos.publicoAlvo = { type: 'string', description: 'um ou mais públicos da lista, separados por vírgula' };
// motivacao/sentimento: as listas são só sugestões, o cliente pode escrever livre -> string
for (const k of SUGESTAO) propsCampos[k] = { type: 'string' };

const TURNO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mensagem', 'campos', 'proximoCampo', 'completo'],
  properties: {
    mensagem: { type: 'string', description: 'A próxima fala do Santiago, em pt-BR, calorosa e curta.' },
    campos: { type: 'object', additionalProperties: false, properties: propsCampos },
    proximoCampo: { type: 'string', description: 'A chave do próximo campo a captar, ou "" se acabou.' },
    completo: { type: 'boolean' },
  },
};

function sistema(faltando, slots, pularTema, continuacao, pularExtra, evento) {
  const enumTxt = Object.entries(ENUM)
    .map(([k, l]) => `- ${k} (${rotuloCampo[k]}): ${l.join(' | ')}`).join('\n');
  const subs = subtemasDe(slots.macroTema);
  const primeiroNome = String(slots.nome || '').trim().split(/\s+/)[0] || '';
  return [
    'Você é o Santiago, curador da PSA Palestras responsável por esta demanda. Você conduz,',
    'por uma conversa curta e calorosa, o briefing do evento de um cliente que já comprou a Auto',
    'Curadoria. Fale em pt-BR, no máximo 2 frases por vez, tom humano e profissional, sem',
    'listar campos como formulário.',
    '',
    'Escreva SEM travessão ("—" ou "–"): use vírgula, ponto ou reticências no lugar.',
    'Você SÓ conduz este briefing. NUNCA responda perguntas fora dele nem dê opiniões,',
    'recomendações de palestrantes, preços, nem qualquer outro assunto. Se o cliente perguntar',
    'algo fora do briefing, diga em uma frase curta que a curadoria cuida disso depois e volte',
    'para a pergunta atual.',
    '',
    continuacao
      ? 'A conversa JÁ começou e você JÁ cumprimentou o cliente. NÃO se apresente nem cumprimente de novo. No seu primeiro turno aqui, vá direto: faça UMA pergunta ABERTA convidando o cliente a descrever o evento com as próprias palavras, algo como "me conta um pouco sobre o evento que você está planejando?".'
      : 'Se a conversa está começando (sem histórico), APRESENTE-SE (é o Santiago, curador responsável) e faça UMA pergunta ABERTA convidando o cliente a descrever o evento com as próprias palavras, algo como "me conta um pouco sobre o evento que você está planejando?".',
    (!continuacao && primeiroNome)
      ? `O cliente se chama ${primeiroNome}. Na PRIMEIRA mensagem, cumprimente-o pelo primeiro nome, comece por "Oi, ${primeiroNome}!".`
      : '',
    'O app vai mostrar uma caixa de texto livre (não botões) pra essa primeira resposta. Dessa',
    'descrição, EXTRAIA o máximo de campos de uma vez. Depois disso, pergunte só o que faltar.',
    'NÃO liste campos nem faça várias perguntas nessa abertura.',
    'Se o relato vier curto, NÃO insista nem peça mais detalhes, apenas siga para os campos que faltam.',
    '',
    'IMPORTANTE: nome, empresa, e-mail e telefone do cliente JÁ os temos (aparecem em "Já captado").',
    'NUNCA pergunte esses dados. Vá direto para as perguntas do EVENTO (público, formato, data etc.).',
    pularTema
      ? 'IMPORTANTE: o TEMA do evento JÁ foi definido antes. NUNCA pergunte o tema (macroTema) nem o recorte do tema (microTema).'
      : '',
    pularExtra
      ? `IMPORTANTE: NÃO pergunte também: ${pularExtra}. Esses já foram definidos fora da conversa.`
      : '',
    evento
      ? 'CONTEXTO: isto é um EVENTO (com um ou mais palestrantes), NÃO uma palestra única. Sempre se refira ao que está sendo planejado como "o evento", nunca como "a palestra".'
      : 'CONTEXTO: isto é uma palestra única. Refira-se a ela como "a palestra".',
    '',
    'Regras:',
    '- A cada mensagem do cliente, EXTRAIA para "campos" tudo o que der (pode ser vários campos numa frase).',
    '- Para os campos de valor fechado abaixo, use EXATAMENTE um dos valores da lista (o app mostra',
    '  botões pro cliente escolher; nunca invente valor fora da lista):',
    enumTxt,
    '- EXCEÇÃO: publicoAlvo pode ter MAIS DE UM valor (o evento pode ter vários públicos). Quando houver mais de um, liste todos separados por vírgula, usando só valores exatos da lista.',
    subs.length ? `- Recortes do tema escolhido (microTema, opcional): ${subs.join(' | ')}` : '',
    '- data no formato YYYY-MM-DD; horario no formato HH:MM.',
    '- SEMPRE pergunte a DATA do evento (proximoCampo="data") — é uma pergunta importante do fluxo, NÃO pule. Pergunte a DATA ANTES do horário.',
    '  Se o cliente ainda não tiver data definida, ele pode tocar em "A definir": aí deixe "data" vazia e siga em frente.',
    '- Pergunte UM ÚNICO campo por vez. Sua mensagem deve perguntar SÓ o campo atual — NUNCA mencione nem combine o próximo campo na mesma frase. Ex.: pergunte o HORÁRIO; só na rodada seguinte pergunte a DURAÇÃO. NÃO faça "horário e duração?" nem "formato e data?" numa pergunta só. Em "proximoCampo" devolva a chave do único próximo campo — que deve ser EXATAMENTE o campo que a sua mensagem está perguntando.',
    '- "microTema" e "contexto" são opcionais, pode pular se o cliente não quiser detalhar.',
    '- Perto do fim, faça também estas duas perguntas (uma por vez): (a) se o cliente já tem',
    '  um palestrante específico em mente (campo palestranteDesejado); se ele não tiver, tudo bem,',
    '  registre algo como "não tem preferência"; (b) para qual empresa é esse evento/palestra (campo empresaPalestra).',
    '- Quando TODOS os obrigatórios estiverem captados, mande uma mensagem de fechamento curta',
    '  ("perfeito, é só isso que eu precisava — vou montar sua curadoria") e devolva completo=true.',
    '',
    '',
    'RESPONDA SEMPRE apenas com um JSON válido (nada antes nem depois), nesta forma exata:',
    '{"mensagem":"sua fala aqui","campos":{...só os campos captados nesta rodada...},"proximoCampo":"chave do próximo campo ou \\"\\"","completo":false}',
    'Chaves possíveis em "campos": nome, empresa, email, telefone, macroTema, microTema, publicoAlvo, formato, data, horario, duracao, localEvento, estado, cidade, orcamento, vendaIngresso, motivacao, sentimento, palestranteDesejado, empresaPalestra, contexto. Só inclua as que captou nesta rodada; use o valor EXATO das listas fechadas.',
    '',
    `Campos obrigatórios ainda faltando: ${faltando.length ? faltando.map(c => rotuloCampo[c] || c).join(', ') : '(nenhum — pode fechar)'}.`,
    `Já captado: ${Object.keys(slots).filter(k => slots[k]).map(k => `${k}=${slots[k]}`).join('; ') || '(nada ainda)'}.`,
    '',
    'IMPORTANTE: sua resposta INTEIRA é só o JSON — começa com { e termina com }. Nada de texto fora do JSON.',
  ].filter(Boolean).join('\n');
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  const { historico = [], slots = {}, campoRespondido = '', pular = [], continuacao = false, evento = false } = await lerCorpo(req);
  // campos definidos FORA do chat (por palestrante/aba num evento): tema, recorte, orçamento.
  // O Santiago não pergunta esses.
  const pularSet = new Set(pular);
  const OBRIG = OBRIGATORIOS.filter(c => !pularSet.has(c));
  // campos que o Santiago PODE perguntar (obrigatórios + os opcionais formato/data/microTema).
  // Sem isso, ao perguntar um opcional o servidor forçava o widget pro próximo obrigatório e
  // a resposta caía no campo errado (ex.: perguntava formato/data mas mostrava seletor de hora).
  const PERGUNTAVEIS = new Set([...OBRIG, ...['formato', 'data', 'microTema'].filter(c => !pularSet.has(c))]);
  const pularTema = pularSet.has('macroTema');
  const pularExtra = [...pularSet].filter(c => c !== 'macroTema' && c !== 'microTema').map(c => rotuloCampo[c] || c).join(', ');
  const mensagens = (historico.length ? historico : [{ role: 'user', content: 'Vamos começar.' }])
    .map(m => ({ role: m.role === 'santiago' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) }));
  const faltando = OBRIG.filter(c => !slots[c]);

  try {
    const client = new Anthropic({ timeout: 26000, maxRetries: 0 });
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      thinking: { type: 'disabled' },          // chat de briefing: rápido, sem raciocínio extenso
      system: sistema(faltando, slots, pularTema, continuacao, pularExtra, evento),
      messages: mensagens,
    });

    // o modelo devolve JSON no texto (a validação de enum é feita no servidor abaixo).
    // Rede de segurança: se ele escorregar e responder texto puro, usa o texto como
    // mensagem e segue — nunca quebra a conversa.
    const bruto = (r.content.find(b => b.type === 'text') || {}).text || '';
    let out;
    try {
      const a = bruto.indexOf('{'), z = bruto.lastIndexOf('}');
      out = JSON.parse(a >= 0 && z > a ? bruto.slice(a, z + 1) : bruto);
    } catch {
      out = { mensagem: bruto, campos: {}, proximoCampo: '', completo: false };
    }

    // valida + mescla os campos (defesa em profundidade — o schema já trava os enums)
    const novos = {};
    const est = out.campos?.estado || slots.estado;
    for (const [k, v] of Object.entries(out.campos || {})) {
      const val = String(v ?? '').trim();
      if (!val) continue;
      if (SUGESTAO.has(k)) { novos[k] = val; continue; }   // sugestão + texto livre: aceita como veio
      if (MULTI.has(k)) {   // um ou mais valores da lista -> guarda só os válidos, juntos
        const opts = ENUM[k] || [];
        const parts = partesMulti(val).filter(p => opts.includes(p));
        if (parts.length) novos[k] = parts.join(', ');
        continue;
      }
      if (ENUM[k] && !ENUM[k].includes(val)) continue;
      if (k === 'cidade' && !(CIDADES[est] || []).includes(val)) continue;
      if (k === 'microTema' && !subtemasDe(out.campos?.macroTema || slots.macroTema).includes(val)) continue;
      if (k === 'data' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) continue;
      if (k === 'data' && dataNoPassado(val)) continue;   // não captura data retroativa
      novos[k] = val;
    }
    const slots2 = { ...slots, ...novos };
    // relato de abertura: a pessoa descreveu o evento com as próprias palavras.
    // Guardamos o texto cru como contexto (detalhe pro curador) — o modelo já extraiu
    // os campos estruturados acima.
    const ultUser = () => String(([...historico].reverse().find(m => m.role === 'user') || {}).content || '').trim();
    if (campoRespondido === 'relato') {
      const v = ultUser();
      if (v) {
        slots2._relato = true;
        slots2.contexto = slots2.contexto ? `${slots2.contexto}\n${v}` : v;
      }
    } else if (campoRespondido && !slots2[campoRespondido] && out.proximoCampo !== campoRespondido) {
      // captura determinística: se o modelo não pegou o campo que o widget pediu, usa a
      // resposta do usuário (o widget perguntou exatamente aquele campo).
      // EXCEÇÃO: se o Santiago está RE-perguntando o mesmo campo (proximoCampo === campoRespondido),
      // é porque a resposta não serviu (ex.: pedimos o NOME DO ESPAÇO e veio a cidade "são paulo sp").
      // Capturar à força aqui marcaria o campo como resolvido e faria o fluxo pular pro próximo
      // (o widget saltava do local pro orçamento). Então NÃO captura: deixa o campo em aberto.
      const v = ultUser();
      if (v && aceitaBackstop(campoRespondido, v, slots2)) slots2[campoRespondido] = v;
    }

    // data retroativa: o evento é sempre no futuro. Se o cliente ofereceu uma data que já
    // passou (pelo seletor ou no texto), NÃO captura, sinaliza e pede uma data futura.
    const dataOferecida = dataNoPassado(String(out.campos?.data || '').trim())
      ? String(out.campos.data).trim()
      : (campoRespondido === 'data' && dataNoPassado(ultUser()) ? ultUser() : '');
    if (dataOferecida && !slots2.data) {
      return res.status(200).json({
        mensagem: `Opa, essa data (${dataOferecida.split('-').reverse().join('/')}) já passou. O evento é pra frente, então me confirma uma data futura, por favor.`,
        slots: slots2,
        widget: widgetPara('data', slots2),
        completo: false,
      });
    }

    // a DATA é perguntada sempre (mesmo sendo opcional responder): marca quando já foi perguntada
    // (o cliente respondeu ao widget de data, com uma data ou com "A definir").
    if (campoRespondido === 'data' || slots2.data) slots2._dataOk = true;
    const faltando2 = OBRIG.filter(c => !slots2[c]);
    const dataPendente = !pularSet.has('data') && !slots2._dataOk;   // ainda não perguntamos a data
    const completo = faltando2.length === 0 && !dataPendente;

    // o SERVIDOR decide o próximo campo/widget. Na abertura (cliente ainda não descreveu
    // o evento), mostra um campo LIVRE pra pessoa contar tudo de uma vez.
    let prox = '', widget = null, msgForcada = '';
    if (!completo) {
      const clienteFalou = historico.some(m => m.role === 'user');
      if (!slots2._relato && !clienteFalou) {
        widget = { campo: 'relato', tipo: 'texto', multilinha: true,
          placeholder: 'Conte com suas palavras: que evento é, pra quem, quando e onde, formato, e o que motivou a busca por esse tema…' };
      } else {
        // campo que o Santiago quer perguntar (respeita opcionais formato/data/microTema), ou o próximo obrigatório
        let alvo = (out.proximoCampo && PERGUNTAVEIS.has(out.proximoCampo) && !slots2[out.proximoCampo])
          ? out.proximoCampo
          : faltando2[0];
        // a DATA vem ANTES do horário: se vamos perguntar horário/duração (ou acabaram os
        // obrigatórios) e a data ainda não foi perguntada, pergunta a DATA primeiro.
        if (dataPendente && (alvo === 'horario' || alvo === 'duracao' || !alvo)) alvo = 'data';
        // se o SERVIDOR forçou a data (o Santiago não estava perguntando isso), troca a mensagem
        if (alvo === 'data' && out.proximoCampo !== 'data') {
          msgForcada = 'E você já tem uma data em mente pro evento? Se ainda não definiu, é só tocar em "A definir".';
        }
        prox = alvo;
        widget = widgetPara(prox, slots2);
      }
    }

    return res.status(200).json({ mensagem: semTravessao(msgForcada || out.mensagem || ''), slots: slots2, widget, completo });
  } catch (e) {
    console.error('CHAT_FALHOU', e.message);
    return res.status(200).json({ mensagem: 'Tive um probleminha aqui do meu lado. Pode repetir, por favor?', slots, widget: null, erro: true });
  }
}
