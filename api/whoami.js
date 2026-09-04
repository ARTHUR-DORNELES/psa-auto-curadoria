import { cors } from './_lib.js';

// DIAGNÓSTICO TEMPORÁRIO: descobre QUAL app privado gera o HUBSPOT_TOKEN do ambiente
// e QUAIS escopos ele tem, sem nunca expor o token. Gate por e-mail PSA.
// Remover depois de identificar o app e habilitar o escopo de owners.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const auth = String(req.headers.authorization || '');
  const email = auth.startsWith('Bearer ') ? auth.slice(7).trim().toLowerCase() : '';
  if (!/@profissionaissa\.com(\.br)?$/i.test(email)) return res.status(401).json({ erro: 'e-mail @profissionaissa.com' });

  const tok = process.env.HUBSPOT_TOKEN || '';
  if (!tok) return res.status(500).json({ erro: 'HUBSPOT_TOKEN não está definido no ambiente' });
  try {
    const r = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(tok)}`);
    const j = await r.json();
    const scopes = Array.isArray(j.scopes) ? j.scopes : [];
    return res.status(200).json({
      httpStatus: r.status,
      app_id: j.app_id,
      hub_id: j.hub_id,
      criado_por: j.user,            // e-mail de quem criou o app privado
      token_type: j.token_type,
      tem_owners_read: scopes.some((s) => /owners/i.test(s)),
      total_scopes: scopes.length,
      scopes,
    });
  } catch (e) {
    return res.status(500).json({ erro: String(e.message || e).slice(0, 400) });
  }
}
