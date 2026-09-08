import { cors, lerCorpo, redis, CHAVE_OWNERS_TOKEN } from './_lib.js';

// Recebe/guarda o token dedicado de leitura de usuários (owners) SEM precisar do Vercel.
// Gate: e-mail @profissionaissa.com. Só guarda se o token realmente ler owners (valida antes).
// O token nunca é devolvido; GET só diz se está configurado.
const DOMINIO_PSA = /@profissionaissa\.com(\.br)?$/i;
function emailDe(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim().toLowerCase() : '';
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const email = emailDe(req);
  if (!DOMINIO_PSA.test(email)) return res.status(401).json({ erro: 'informe um e-mail @profissionaissa.com' });

  if (req.method === 'GET') {
    let temRedis = false;
    try { temRedis = !!(await redis().get(CHAVE_OWNERS_TOKEN)); } catch (e) {}
    const via = process.env.HUBSPOT_OWNERS_TOKEN ? 'env' : (temRedis ? 'redis' : null);
    return res.status(200).json({ definido: !!via, via });
  }

  if (req.method === 'POST') {
    const body = await lerCorpo(req);
    if (body.limpar) {
      try { await redis().del(CHAVE_OWNERS_TOKEN); } catch (e) {}
      return res.status(200).json({ ok: true, limpo: true });
    }
    const token = String(body.token || '').trim();
    if (!/^pat-/.test(token)) return res.status(400).json({ erro: 'cole um token de app privado (começa com pat-)' });
    // valida: o token PRECISA conseguir ler owners, senão não adianta guardar
    try {
      const r = await fetch('https://api.hubapi.com/crm/v3/owners/?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      if (r.status !== 200) {
        const t = await r.text();
        return res.status(400).json({ erro: 'esse token não consegue ler usuários (owners). Confira se o escopo crm.objects.owners.read está marcado.', detalhe: `HTTP ${r.status} ${t.slice(0, 200)}` });
      }
    } catch (e) {
      return res.status(502).json({ erro: 'não consegui validar o token agora, tente de novo', detalhe: String(e.message || e).slice(0, 200) });
    }
    try {
      await redis().set(CHAVE_OWNERS_TOKEN, token);   // persistente
      console.log('owners-token: configurado por', email);
      return res.status(200).json({ ok: true, leOwners: true });
    } catch (e) {
      return res.status(500).json({ erro: 'falha ao guardar o token', detalhe: String(e.message || e).slice(0, 200) });
    }
  }

  res.status(405).json({ erro: 'método não suportado' });
}
