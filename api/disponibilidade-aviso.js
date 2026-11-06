import { redis, chave, chaveDeal, hs, lerCorpo, cors, respostasDisponibilidade } from './_lib.js';

// Aviso por e-mail quando um palestrante responde a disponibilidade.
//
// Gatilho: workflow de NEGÓCIO no HubSpot ("respostas_disponibilidade" mudou) chama esta rota
// com o id do negócio. A rota não confia no corpo: só usa o id do negócio, relê tudo do
// HubSpot e do Redis e avisa apenas respostas que ainda não foram avisadas (idempotente).
// Assim, chamar de novo (ou alguém de fora chamar) nunca gera e-mail repetido nem falso.
//
// O e-mail sai do HubSpot, no mesmo padrão do convite: a rota grava no CONTATO de quem criou
// a curadoria o resumo + o link e carimba `auto_curadoria_disp_aviso`; um workflow de contato
// (gatilho: essa propriedade mudou, reinscrição ligada) manda o e-mail.
const APP_URL = process.env.APP_URL || 'https://lps.profissionaissa.com/auto-curadoria-briefing';
const TTL = 60 * 60 * 24 * 90;

const assinatura = (r) => `${r.disponivel}|${r.valor}|${r.obs}`;
const linha = (nome, r) => {
  const st = r.disponivel === true ? 'disponível' : r.disponivel === false ? 'indisponível' : 'respondeu';
  return `${nome}: ${st}${r.disponivel !== false && r.valor ? `, ${r.valor}` : ''}`;
};

export async function avisarRespostas(dealId) {
  const id = await redis().get(chaveDeal(dealId));
  if (!id) return { ok: true, ignorado: 'negócio sem curadoria' };
  const bruto = await redis().get(chave(id));
  if (!bruto) return { ok: true, ignorado: 'curadoria expirada' };
  const reg = JSON.parse(bruto);
  const pedidos = reg.disponibilidade?.palestrantes || [];
  if (!pedidos.length) return { ok: true, ignorado: 'sem pedido de disponibilidade' };

  const respostas = await respostasDisponibilidade(dealId);
  const idPorNome = {};
  for (const i of reg.resultado?.indicacoes || []) idPorNome[i.nome] = String(i.id_contato || '');

  const avisados = reg.dispAvisados || {};
  const novas = [];
  for (const nome of pedidos) {
    const r = respostas[idPorNome[nome]];
    if (!r) continue;
    const a = assinatura(r);
    if (avisados[nome] === a) continue;
    novas.push({ nome, r, a });
  }
  if (!novas.length) return { ok: true, novas: 0 };

  const email = String(reg.usuario?.email || reg.briefing?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, erro: 'curadoria sem e-mail do autor' };

  const busca = await hs('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'], limit: 1,
  });
  let contatoId = busca.results?.[0]?.id;
  if (!contatoId) {
    const [first, ...rest] = String(reg.usuario?.nome || reg.briefing?.nome || '').trim().split(/\s+/);
    const c = await hs('/crm/v3/objects/contacts', 'POST', {
      properties: { email, ...(first ? { firstname: first } : {}), ...(rest.length ? { lastname: rest.join(' ') } : {}) },
    });
    contatoId = c.id;
  }

  const total = pedidos.length;
  const respondidas = pedidos.filter((n) => respostas[idPorNome[n]]).length;
  const evento = reg.briefing?.empresaPalestra || reg.briefing?.empresa || '';
  await hs(`/crm/v3/objects/contacts/${contatoId}`, 'PATCH', {
    properties: {
      auto_curadoria_disp_resumo: novas.map((n) => linha(n.nome, n.r)).join(' · '),
      auto_curadoria_disp_link: `${APP_URL}?id=${id}`,
      auto_curadoria_disp_status: `${respondidas} de ${total} palestrante${total === 1 ? '' : 's'} já ${respondidas === 1 ? 'respondeu' : 'responderam'}${evento ? ` (${evento})` : ''}`,
      auto_curadoria_disp_aviso: new Date().toISOString(),
    },
  });

  for (const n of novas) avisados[n.nome] = n.a;
  reg.dispAvisados = avisados;
  await redis().set(chave(id), JSON.stringify(reg), 'EX', TTL);
  return { ok: true, novas: novas.length, para: email };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });
  const b = await lerCorpo(req);
  const dealId = String(b.objectId || b.dealId || b.hs_object_id || req.query.dealId || '').replace(/\D/g, '');
  if (!dealId) return res.status(400).json({ ok: false, erro: 'informe o id do negócio' });
  try {
    return res.status(200).json(await avisarRespostas(dealId));
  } catch (e) {
    console.error('AVISO_DISP_FALHOU', dealId, e.message);
    return res.status(500).json({ ok: false, erro: 'falhou' });
  }
}
