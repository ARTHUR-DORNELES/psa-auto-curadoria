import { cors, lerCorpo, redis, CHAVE_OWNERS_TOKEN, CHAVE_HS_PRINCIPAL, CHAVE_DIST_SECRET } from './_lib.js';
import { lerSessao, ehSuper } from './_auth.js';

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
    // Segredo da distribuição do SAL (psa-ia-board /api/dist-recomenda). Só super admin logado.
    if (body.distSecret) {
      const sess = await lerSessao(body.sessao).catch(() => null);
      if (!sess || sess.suporte || !ehSuper(sess.email)) return res.status(403).json({ erro: 'só super admin logado' });
      const v = String(body.valor || '').trim();
      if (!v) return res.status(400).json({ erro: 'valor vazio' });
      // valida sem distribuir nada: sem dealId o board responde 400 (aceito) ou 401 (segredo errado)
      const r = await fetch('https://psa-ia-board.vercel.app/api/dist-recomenda', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${v}` }, body: '{}' });
      if (r.status === 401 || r.status === 403) return res.status(400).json({ erro: 'o board recusou esse segredo', detalhe: `HTTP ${r.status}` });
      await redis().set(CHAVE_DIST_SECRET, v);
      return res.status(200).json({ ok: true, board: r.status });
    }
    // Token PRINCIPAL reserva (vale no lugar do HUBSPOT_TOKEN da Vercel). Só super admin logado.
    if (body.principal) {
      const sess = await lerSessao(body.sessao).catch(() => null);
      if (!sess || sess.suporte || !ehSuper(sess.email)) return res.status(403).json({ erro: 'só super admin logado' });
      if (body.limpar) { await redis().del(CHAVE_HS_PRINCIPAL); return res.status(200).json({ ok: true, limpo: true }); }
      const tk = String(body.token || '').trim();
      if (!/^pat-/.test(tk)) return res.status(400).json({ erro: 'cole um token de app privado (começa com pat-)' });
      for (const u of ['/crm/v3/objects/contacts?limit=1', '/crm/v3/objects/deals?limit=1']) {
        const r = await fetch(`https://api.hubapi.com${u}`, { headers: { Authorization: `Bearer ${tk}` } });
        if (r.status !== 200) return res.status(400).json({ erro: `o token não lê ${u.split('/')[4]}`, detalhe: `HTTP ${r.status}` });
      }
      await redis().set(CHAVE_HS_PRINCIPAL, tk);
      console.log('token principal reserva: configurado por', sess.email);
      return res.status(200).json({ ok: true });
    }
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
