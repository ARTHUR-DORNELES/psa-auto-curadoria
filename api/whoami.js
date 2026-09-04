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

  // impressão digital MASCARADA p/ casar com o Vercel e o "Mostrar token" de cada app privado.
  // Nunca devolve o token inteiro.
  const fingerprint = {
    inicio: tok.slice(0, 15),   // ex.: "pat-na1-2582xxx"
    fim: tok.slice(-4),
    tamanho: tok.length,
  };

  // tenta confirmar o portal (não expõe nada sensível)
  let portal = null;
  try {
    const r = await fetch('https://api.hubapi.com/account-info/v3/details', { headers: { Authorization: `Bearer ${tok}` } });
    if (r.ok) { const j = await r.json(); portal = { portalId: j.portalId, tipo: j.accountType, timeZone: j.timeZone }; }
  } catch (e) { /* ignora */ }

  // tenta descobrir o appId (abre o app por link direto: /private-apps/<portal>/<appId>)
  let integracao = null;
  try {
    const r = await fetch('https://api.hubapi.com/integrations/v1/me', { headers: { Authorization: `Bearer ${tok}` } });
    const t = await r.text();
    integracao = { status: r.status, body: t.slice(0, 300) };
  } catch (e) { integracao = { erro: String(e.message || e).slice(0, 200) }; }

  return res.status(200).json({ fingerprint, portal, integracao });
}
