import { hs, cors, lerCorpo, redis } from './_lib.js';

// Cada líder escolhe seus liderados (self-service). O mapa líder -> [ownerIds] fica no Redis
// e o painel /aprovacoes usa isso p/ filtrar a fila (o líder vê só os pedidos do seu time).
// Acesso pelo e-mail corporativo (mesmo portão do painel de aprovações).

const DOMINIO_PSA = /@profissionaissa\.com(\.br)?$/i;
const chaveLider = (email) => `aprov:lider:${email}`;

function aprovadorEmail(req) {
  const auth = String(req.headers.authorization || '');
  let email = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!email) email = String(req.headers['x-aprovador'] || '').trim();
  return email.toLowerCase();
}

// Lista de usuários (owners) do HubSpot: [{id, nome, email}] + Set de e-mails p/ validar login.
let _ownersCache = null;
async function ownersList() {
  if (_ownersCache) return _ownersCache;
  const lista = [];
  const emails = new Set();
  let after = '';
  for (let i = 0; i < 30; i++) {
    const qs = `?limit=100&archived=false${after ? `&after=${after}` : ''}`;
    const r = await hs(`/crm/v3/owners/${qs}`, 'GET');
    for (const o of (r.results || [])) {
      const nome = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || `#${o.id}`;
      lista.push({ id: String(o.id), nome, email: (o.email || '').toLowerCase() });
      if (o.email) emails.add(String(o.email).toLowerCase());
    }
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  _ownersCache = { lista, emails };
  return _ownersCache;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;

  const email = aprovadorEmail(req);
  if (!DOMINIO_PSA.test(email)) return res.status(401).json({ erro: 'informe um e-mail @profissionaissa.com' });

  // valida contra os usuários reais do HubSpot; sem escopo de owners, o recurso não abre
  let owners;
  try { owners = await ownersList(); }
  catch (e) {
    console.error('lideranca: não consegui ler owners:', e.message);
    return res.status(503).json({ erro: 'o token do HubSpot ainda não tem permissão para ler usuários (escopo crm.objects.owners.read). Peça para habilitar.' });
  }
  if (!owners.emails.has(email)) return res.status(403).json({ erro: 'e-mail não é de um usuário do HubSpot da PSA' });

  if (req.method === 'GET') {
    let meus = [];
    try { meus = JSON.parse((await redis().get(chaveLider(email))) || '[]'); } catch (e) { meus = []; }
    return res.status(200).json({ eu: email, owners: owners.lista, meus });
  }

  if (req.method === 'POST') {
    const body = await lerCorpo(req);
    const ids = Array.isArray(body.liderados) ? body.liderados.map(String).filter((x) => /^\d+$/.test(x)) : null;
    if (!ids) return res.status(400).json({ erro: 'envie liderados: [ownerIds]' });
    // não deixa o líder marcar a si mesmo como liderado
    const valido = owners.lista.find((o) => o.email === email);
    const meuId = valido ? valido.id : '';
    const limpos = [...new Set(ids)].filter((id) => id !== meuId);
    await redis().set(chaveLider(email), JSON.stringify(limpos), 'EX', 60 * 60 * 24 * 365);
    return res.status(200).json({ ok: true, salvos: limpos.length });
  }

  res.status(405).json({ erro: 'método não suportado' });
}
