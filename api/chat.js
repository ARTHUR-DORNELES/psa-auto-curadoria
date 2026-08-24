import Anthropic from '@anthropic-ai/sdk';
import { lerCorpo, cors } from './_lib.js';
import {
  MACRO, ORCAMENTOS, FORMATOS, ESTADOS, CIDADES, MICRO,
  PUBLICO_ALVO, MOTIVACOES, SENTIMENTOS, DURACOES, VENDA_INGRESSO,
} from './_enums.js';

// Santiago: o curador que conduz o briefing por conversa. O Claude phraseia e extrai;
// o SERVIDOR é a autoridade dos enums (só aceita valor válido) e da completude.
const MODEL = 'claude-sonnet-5';

// espelha os obrigatórios do curar.js (+ estado, que lá é briefing.local)
const OBRIGATORIOS = ['nome', 'empresa', 'email', 'telefone', 'macroTema', 'publicoAlvo',
  'formato', 'data', 'horario', 'duracao', 'localEvento', 'estado', 'cidade', 'orcamento',
  'vendaIngresso', 'motivacao', 'sentimento'];

// campos de valor fechado -> validados contra a lista e travados no schema de saída
const ENUM = {
  macroTema: MACRO, formato: FORMATOS, orcamento: ORCAMENTOS, duracao: DURACOES,
  publicoAlvo: PUBLICO_ALVO, motivacao: MOTIVACOES, sentimento: SENTIMENTOS,
  vendaIngresso: VENDA_INGRESSO, estado: ESTADOS,
};

const rotuloCampo = {
  nome: 'nome do responsável', empresa: 'empresa', email: 'e-mail corporativo', telefone: 'telefone',
  macroTema: 'tema do evento', microTema: 'recorte do tema', publicoAlvo: 'público-alvo',
  formato: 'formato', data: 'data do evento', horario: 'horário', duracao: 'duração',
  localEvento: 'local do evento (nome do espaço)', estado: 'estado', cidade: 'cidade',
  orcamento: 'orçamento', vendaIngresso: 'evento com venda de ingresso?',
  motivacao: 'o que motivou a busca por esse tema', sentimento: 'como o público deve sair do evento',
  contexto: 'algum contexto extra (opcional)',
};

// subtemas do macro escolhido (MICRO é chaveado por "1".."25" = prefixo do macro)
const subtemasDe = macro => MICRO[String(macro || '').match(/^(\d+)\./)?.[1]] || [];

// widget que o front renderiza para captar o próximo campo
function widgetPara(campo, slots) {
  if (ENUM[campo]) return { campo, tipo: 'chips', opcoes: ENUM[campo] };
  if (campo === 'cidade') return { campo, tipo: 'busca', opcoes: CIDADES[slots.estado] || [] };   // autocomplete (lista grande)
  if (campo === 'microTema') return { campo, tipo: 'chips', opcoes: subtemasDe(slots.macroTema) };
  if (campo === 'data') return { campo, tipo: 'data' };
  if (campo === 'horario') return { campo, tipo: 'hora' };
  return { campo, tipo: 'texto' };
}

// backstop: a resposta do usuário ao widget é aceitável para aquele campo? (validação leve)
function aceitaBackstop(campo, val, slots) {
  if (ENUM[campo]) return ENUM[campo].includes(val);
  if (campo === 'cidade') return (CIDADES[slots.estado] || []).includes(val);
  if (campo === 'microTema') return subtemasDe(slots.macroTema).includes(val);
  if (campo === 'data') return /^\d{4}-\d{2}-\d{2}$/.test(val);
  if (campo === 'horario') return /^\d{1,2}:\d{2}$/.test(val);
  if (campo === 'email') return /\S+@\S+\.\S+/.test(val);
  if (campo === 'telefone') return val.replace(/\D/g, '').length >= 10;
  return true;   // nome, empresa, localEvento, contexto -> qualquer texto serve
}

// schema da saída estruturada — os enums fixos ficam TRAVADOS aqui (o Claude não inventa valor)
const propsCampos = {
  nome: { type: 'string' }, empresa: { type: 'string' }, email: { type: 'string' },
  telefone: { type: 'string' }, microTema: { type: 'string' },
  localEvento: { type: 'string' }, cidade: { type: 'string' },
  data: { type: 'string', description: 'YYYY-MM-DD' }, horario: { type: 'string', description: 'HH:MM' },
  contexto: { type: 'string' },
};
for (const [k, lista] of Object.entries(ENUM)) propsCampos[k] = { type: 'string', enum: lista };

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

function sistema(faltando, slots) {
  const enumTxt = Object.entries(ENUM)
    .map(([k, l]) => `- ${k} (${rotuloCampo[k]}): ${l.join(' | ')}`).join('\n');
  const subs = subtemasDe(slots.macroTema);
  const primeiroNome = String(slots.nome || '').trim().split(/\s+/)[0] || '';
  return [
    'Você é o Santiago, curador da PSA Palestras responsável por esta demanda. Você conduz,',
    'por uma conversa curta e calorosa, o briefing do evento de um cliente que já comprou a Auto',
    'Curadoria. Fale em pt-BR, no máximo 2 frases por vez, tom humano e profissional — nada de',
    'listar campos como formulário.',
    '',
    'Se a conversa está começando (sem histórico), APRESENTE-SE: diga que é o Santiago, curador',
    'responsável, e que vai fazer algumas perguntas rápidas pra montar a melhor curadoria. Depois',
    'faça a primeira pergunta.',
    primeiroNome
      ? `O cliente se chama ${primeiroNome}. Na PRIMEIRA mensagem, cumprimente-o pelo primeiro nome — comece por "Oi, ${primeiroNome}!".`
      : '',
    '',
    'IMPORTANTE: nome, empresa, e-mail e telefone do cliente JÁ os temos (aparecem em "Já captado").',
    'NUNCA pergunte esses dados. Vá direto para as perguntas do EVENTO (tema, público, formato, data etc.).',
    '',
    'Regras:',
    '- A cada mensagem do cliente, EXTRAIA para "campos" tudo o que der (pode ser vários campos numa frase).',
    '- Para os campos de valor fechado abaixo, use EXATAMENTE um dos valores da lista (o app mostra',
    '  botões pro cliente escolher; nunca invente valor fora da lista):',
    enumTxt,
    subs.length ? `- Recortes do tema escolhido (microTema, opcional): ${subs.join(' | ')}` : '',
    '- data no formato YYYY-MM-DD; horario no formato HH:MM.',
    '- Pergunte UM assunto por vez. Em "proximoCampo" devolva a chave do próximo campo a captar.',
    '- "microTema" e "contexto" são opcionais — pode pular se o cliente não quiser detalhar.',
    '- Quando TODOS os obrigatórios estiverem captados, mande uma mensagem de fechamento curta',
    '  ("perfeito, é só isso que eu precisava — vou montar sua curadoria") e devolva completo=true.',
    '',
    '',
    'RESPONDA SEMPRE apenas com um JSON válido (nada antes nem depois), nesta forma exata:',
    '{"mensagem":"sua fala aqui","campos":{...só os campos captados nesta rodada...},"proximoCampo":"chave do próximo campo ou \\"\\"","completo":false}',
    'Chaves possíveis em "campos": nome, empresa, email, telefone, macroTema, microTema, publicoAlvo, formato, data, horario, duracao, localEvento, estado, cidade, orcamento, vendaIngresso, motivacao, sentimento, contexto. Só inclua as que captou nesta rodada; use o valor EXATO das listas fechadas.',
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

  const { historico = [], slots = {}, campoRespondido = '' } = await lerCorpo(req);
  const mensagens = (historico.length ? historico : [{ role: 'user', content: 'Vamos começar.' }])
    .map(m => ({ role: m.role === 'santiago' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) }));
  const faltando = OBRIGATORIOS.filter(c => !slots[c]);

  try {
    const client = new Anthropic({ timeout: 26000, maxRetries: 0 });
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      thinking: { type: 'disabled' },          // chat de briefing: rápido, sem raciocínio extenso
      system: sistema(faltando, slots),
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
      if (ENUM[k] && !ENUM[k].includes(val)) continue;
      if (k === 'cidade' && !(CIDADES[est] || []).includes(val)) continue;
      if (k === 'microTema' && !subtemasDe(out.campos?.macroTema || slots.macroTema).includes(val)) continue;
      if (k === 'data' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) continue;
      novos[k] = val;
    }
    const slots2 = { ...slots, ...novos };
    // captura determinística: se o modelo não pegou o campo que o widget pediu, usa a
    // resposta do usuário (o widget perguntou exatamente aquele campo).
    if (campoRespondido && !slots2[campoRespondido]) {
      const ult = [...historico].reverse().find(m => m.role === 'user');
      const v = String((ult && ult.content) || '').trim();
      if (v && aceitaBackstop(campoRespondido, v, slots2)) slots2[campoRespondido] = v;
    }
    const faltando2 = OBRIGATORIOS.filter(c => !slots2[c]);
    const completo = faltando2.length === 0;

    // o SERVIDOR decide o próximo campo (não confia cegamente no modelo) e o widget
    let prox = '';
    if (!completo) {
      prox = faltando2.includes(out.proximoCampo) ? out.proximoCampo : faltando2[0];
    }
    const widget = prox ? widgetPara(prox, slots2) : null;

    return res.status(200).json({ mensagem: out.mensagem || '', slots: slots2, widget, completo });
  } catch (e) {
    console.error('CHAT_FALHOU', e.message);
    return res.status(200).json({ mensagem: 'Tive um probleminha aqui do meu lado. Pode repetir, por favor?', slots, widget: null, erro: true });
  }
}
