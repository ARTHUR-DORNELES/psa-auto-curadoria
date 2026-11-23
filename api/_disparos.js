// Resultado dos disparos da Essencial (e-mails de marketing do HubSpot): enviados, entregues,
// abertos, cliques. Pega os e-mails com "Essencial" no nome; a onda sai do nome ("Onda 3").
// WhatsApp do HubSpot não expõe leitura pela API: o relatório mede o clique pela UTM.
// Token: HUBSPOT_REPORT_TOKEN > token principal (reserva do Redis) > token extra (owners) > HUBSPOT_TOKEN, o primeiro que tiver o escopo.
import { ownersToken, redis, tokenPrincipal } from './_lib.js';

const HS = 'https://api.hubapi.com';
const CACHE = 'ac:rastro:disparos:v3';   // v2: + WhatsApp; v3: + ids de campanha dos e-mails

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

// WhatsApp (ação nativa do HubSpot, número Suporte Palestrante). O HubSpot NÃO expõe entregues/lidos
// por API: contamos os disparados pela lista estática de cada disparo (onda + categoria do contato) e
// o painel linka a página da mensagem no HubSpot, onde ficam entregues e lidos.
// Novo disparo de WhatsApp com lista própria? acrescente aqui.
const WPP_DISPAROS = [
  { lista: '33181', rotulo: 'WhatsApp dia 0 · 23/11', ondas: ['Onda 1', 'Onda 2'] },
];
const WPP_MSG = {   // categoria -> modelo e página da mensagem no HubSpot (entregues/lidos)
  'Perdeu por preço': { modelo: 'essencial_preco', pagina: '228413894672' },
  'Sumiu na conversa': { modelo: 'essencial_sumiu', pagina: '228413894674' },
  'Momento não era aquele': { modelo: 'essencial_momento', pagina: '228413894657' },
  'Fechou gratuito ou direto': { modelo: 'essencial_outro_caminho', pagina: '228413894569' },
  'Fechou com a concorrência': { modelo: 'essencial_concorrencia', pagina: '228413894539' },
};

export async function buscarWhats(tok) {
  const out = [];
  for (const d of WPP_DISPAROS) {
    const ids = [];
    let after = '';
    for (let pag = 0; pag < 40; pag++) {
      const r = await fetch(`${HS}/crm/v3/lists/${d.lista}/memberships?limit=250${after ? `&after=${after}` : ''}`, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HubSpot lista ${r.status}`);
      const j = await r.json();
      ids.push(...(j.results || []).map((x) => String(x.recordId)));
      after = j.paging?.next?.after;
      if (!after) break;
    }
    const grupos = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const r = await fetch(`${HS}/crm/v3/objects/contacts/batch/read`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties: ['essencial_onda', 'essencial_categoria'] }),
      });
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HubSpot contatos ${r.status}`);
      for (const c of (await r.json()).results || []) {
        const onda = c.properties?.essencial_onda || '', cat = c.properties?.essencial_categoria || '';
        const k = `${onda}|${cat}`;
        grupos.set(k, (grupos.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of grupos) {
      const [onda, cat] = k.split('|');
      const m = WPP_MSG[cat] || {};
      out.push({ disparo: d.rotulo, onda, categoria: cat, modelo: m.modelo || '', pagina: m.pagina ? `https://app.hubspot.com/whatsapp/49656171/details/${m.pagina}/performance` : '', disparados: n });
    }
  }
  return out.sort((a, b) => a.onda.localeCompare(b.onda) || a.categoria.localeCompare(b.categoria));
}

export async function resultadoDosDisparos() {
  const r = redis();
  const c = await r.get(CACHE);
  if (c) return JSON.parse(c);
  const toks = [process.env.HUBSPOT_REPORT_TOKEN, await tokenPrincipal().catch(() => null), await ownersToken().catch(() => null), process.env.HUBSPOT_TOKEN].filter(Boolean);
  let emails = null;
  for (const t of [...new Set(toks)]) { emails = await buscar(t); if (emails) break; }
  if (!emails) return { erro: 'O token do HubSpot do app não tem permissão para ler e-mails de marketing (escopo "content").' };
  let whats = null, whatsErro = '';
  try { for (const t of [...new Set(toks)]) { whats = await buscarWhats(t); if (whats) break; } }
  catch (e) { whatsErro = e.message.slice(0, 160); }
  if (!whats && !whatsErro) whatsErro = 'O token do HubSpot do app não lê listas/contatos.';
  const out = {
    emails: emails.map((e) => {
      const k = e.stats?.counters || {};
      const onda = (String(e.name).match(/onda\s*(\d+)/i) || [])[1];
      return {
        id: e.id, nome: e.name, assunto: e.subject || '', estado: e.state, tipo: e.type,
        campanhas: (e.allEmailCampaignIds || []).map(String),   // o HubSpot troca a UTM do link por utm_content=<id de campanha do e-mail>

        onda: onda ? `Onda ${onda}` : '', enviadoEm: e.publishDate || e.createdAt,
        enviados: k.sent || 0, entregues: k.delivered || 0, abertos: k.open || 0, cliques: k.click || 0,
        bounces: (k.bounce || 0) + (k.hardbounced || 0), descadastros: k.unsubscribed || 0,
      };
    }),
    whats: whats || [], whatsErro,
    em: Date.now(),
  };
  await r.set(CACHE, JSON.stringify(out), 'EX', 600);   // 10 min: o HubSpot conta com atraso mesmo
  return out;
}
