// Resultado dos disparos da Essencial (e-mails de marketing do HubSpot): enviados, entregues,
// abertos, cliques. Pega os e-mails com "Essencial" no nome; a onda sai do nome ("Onda 3").
// WhatsApp do HubSpot não expõe leitura pela API: o relatório mede o clique pela UTM.
// Token: HUBSPOT_REPORT_TOKEN > token principal (reserva do Redis) > token extra (owners) > HUBSPOT_TOKEN, o primeiro que tiver o escopo.
import { ownersToken, redis, tokenPrincipal } from './_lib.js';

const HS = 'https://api.hubapi.com';
const CACHE = 'ac:rastro:disparos';

async function buscar(tok) {
  const emails = [];
  let after = '';
  for (let pag = 0; pag < 6; pag++) {   // os 600 mais recentes bastam
    const r = await fetch(`${HS}/marketing/v3/emails?limit=100&includeStats=true&sort=-createdAt${after ? `&after=${after}` : ''}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 401 || r.status === 403) return null;
    if (!r.ok) throw new Error(`HubSpot e-mails ${r.status}`);
    const j = await r.json();
    for (const e of j.results || []) if (/essencial/i.test(e.name || '')) emails.push(e);
    after = j.paging?.next?.after;
    if (!after) break;
  }
  return emails;
}

export async function resultadoDosDisparos() {
  const r = redis();
  const c = await r.get(CACHE);
  if (c) return JSON.parse(c);
  const toks = [process.env.HUBSPOT_REPORT_TOKEN, await tokenPrincipal().catch(() => null), await ownersToken().catch(() => null), process.env.HUBSPOT_TOKEN].filter(Boolean);
  let emails = null;
  for (const t of [...new Set(toks)]) { emails = await buscar(t); if (emails) break; }
  if (!emails) return { erro: 'O token do HubSpot do app não tem permissão para ler e-mails de marketing (escopo "content").' };
  const out = {
    emails: emails.map((e) => {
      const k = e.stats?.counters || {};
      const onda = (String(e.name).match(/onda\s*(\d+)/i) || [])[1];
      return {
        id: e.id, nome: e.name, assunto: e.subject || '', estado: e.state, tipo: e.type,
        onda: onda ? `Onda ${onda}` : '', enviadoEm: e.publishDate || e.createdAt,
        enviados: k.sent || 0, entregues: k.delivered || 0, abertos: k.open || 0, cliques: k.click || 0,
        bounces: (k.bounce || 0) + (k.hardbounced || 0), descadastros: k.unsubscribed || 0,
      };
    }),
    em: Date.now(),
  };
  await r.set(CACHE, JSON.stringify(out), 'EX', 600);   // 10 min: o HubSpot conta com atraso mesmo
  return out;
}
