import { hs, cors, lerCorpo } from './_lib.js';

// Painel de APROVAÇÕES da pesquisa de disponibilidade (palestrantes-app).
// O card do HubSpot, em vez de disparar, grava no negócio:
//   pesq_aprov_status = 'pendente'  + pesq_aprov_dados = JSON com o staging por palestrante.
// Aqui o gestor vê os pendentes (com o gerente do dono), aprova (dispara de verdade) ou reprova.
// Basic Auth (default PSA:PSA2030, trocável por env APROVACOES_AUTH).

const STATUS = 'pesq_aprov_status';
const DADOS = 'pesq_aprov_dados';

function autorizado(req) {
  const cred = process.env.APROVACOES_AUTH || 'PSA:PSA2030';
  const auth = String(req.headers.authorization || '');
  const enviado = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
  return enviado === cred;
}

// dono do negócio + time(s) do dono (o "gerente da área" é resolvido pela hierarquia de times)
const _ownerCache = new Map();
async function donoInfo(ownerId) {
  if (!ownerId) return null;
  if (_ownerCache.has(ownerId)) return _ownerCache.get(ownerId);
  try {
    const o = await hs(`/crm/v3/owners/${ownerId}`, 'GET');
    const nome = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || `#${ownerId}`;
    const times = (o.teams || []).map(t => t.name).filter(Boolean);
    const info = { id: ownerId, nome, email: o.email || '', times };
    _ownerCache.set(ownerId, info);
    return info;
  } catch (e) { const info = { id: ownerId, nome: `#${ownerId}`, email: '', times: [] }; _ownerCache.set(ownerId, info); return info; }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!autorizado(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="aprovacoes"');
    return res.status(401).json({ erro: 'não autorizado' });
  }

  if (req.method === 'GET') {
    try {
      const busca = await hs('/crm/v3/objects/deals/search', 'POST', {
        filterGroups: [{ filters: [{ propertyName: STATUS, operator: 'EQ', value: 'pendente' }] }],
        properties: ['dealname', 'hubspot_owner_id', STATUS, DADOS],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100,
      }).catch((e) => { throw e; });

      const itens = [];
      for (const d of (busca.results || [])) {
        const p = d.properties || {};
        let dados = {}; try { dados = JSON.parse(p[DADOS] || '{}'); } catch (e) {}
        const dono = await donoInfo(p.hubspot_owner_id);
        itens.push({
          dealId: d.id, dealname: p.dealname || `Negócio ${d.id}`,
          dono: dono ? dono.nome : '', area: dono && dono.times.length ? dono.times.join(', ') : '',
          gerente: dados.gerente || (dono && dono.times[0]) || '',   // gerente da área (hierarquia); fallback = time do dono
          solicitante: dados.solicitante || '', em: dados.em || '',
          palestrantes: (dados.palestrantes || []).map(x => x.nome).filter(Boolean),
          url: `https://app.hubspot.com/contacts/49656171/record/0-3/${d.id}`,
        });
      }
      return res.status(200).json({ total: itens.length, itens });
    } catch (e) {
      const msg = String(e.message || e);
      if (/PROPERTY_DOESNT_EXIST|does not exist|pesq_aprov/i.test(msg)) {
        return res.status(200).json({ total: 0, itens: [], aviso: 'As propriedades pesq_aprov_status / pesq_aprov_dados ainda não existem no HubSpot.' });
      }
      console.error('aprovacoes GET falhou:', msg);
      return res.status(500).json({ erro: 'falha ao listar aprovações' });
    }
  }

  if (req.method === 'POST') {
    const { dealId, acao } = await lerCorpo(req);
    if (!dealId || !['aprovar', 'reprovar'].includes(acao)) return res.status(400).json({ erro: 'dealId e ação (aprovar/reprovar) obrigatórios' });
    try {
      if (acao === 'reprovar') {
        await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: { [STATUS]: 'reprovado' } });
        return res.status(200).json({ ok: true, status: 'reprovado' });
      }
      // APROVAR: lê o staging guardado e aplica em cada contato (dispara), depois marca aprovado
      const deal = await hs(`/crm/v3/objects/deals/${dealId}?properties=${DADOS},${STATUS}`, 'GET');
      let dados = {}; try { dados = JSON.parse((deal.properties || {})[DADOS] || '{}'); } catch (e) {}
      const palestrantes = Array.isArray(dados.palestrantes) ? dados.palestrantes : [];
      const disparados = [], falhas = [];
      for (const pal of palestrantes) {
        const cid = String(pal.contactId || '').trim();
        if (!/^\d+$/.test(cid)) { falhas.push(pal.nome || cid); continue; }
        try {
          await hs(`/crm/v3/objects/contacts/${cid}`, 'PATCH', { properties: { ...(pal.props || {}), pesq_disparar: 'true' } });
          disparados.push(pal.nome || cid);
        } catch (e) { console.error('disparo (aprovação) falhou p/', cid, e.message); falhas.push(pal.nome || cid); }
      }
      await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: { [STATUS]: 'aprovado' } });
      return res.status(200).json({ ok: true, status: 'aprovado', disparados, falhas });
    } catch (e) {
      console.error('aprovacoes POST falhou:', e.message);
      return res.status(500).json({ erro: 'falha ao processar a aprovação' });
    }
  }

  res.status(405).json({ erro: 'método não suportado' });
}
