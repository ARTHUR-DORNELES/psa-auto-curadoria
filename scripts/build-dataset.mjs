// Constrói o banco de palestrantes da Auto Curadoria a partir do histórico de deals do HubSpot.
// Roda uma vez (ou quando quiser atualizar): node scripts/build-dataset.mjs
// Saída: data/palestrantes.js  (módulo ES, bundla direto na function)
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.HUBSPOT_TOKEN || readEnvToken();
if (!TOKEN) throw new Error('HUBSPOT_TOKEN não encontrado (env ou ../tbs-2026-dashboard/.env.local)');

function readEnvToken() {
  const p = path.resolve('../tbs-2026-dashboard/.env.local');
  if (!fs.existsSync(p)) return null;
  return (fs.readFileSync(p, 'utf8').match(/^HUBSPOT_TOKEN=(.+)$/m)?.[1] || '').trim().replace(/^"|"$/g, '');
}

const HS = 'https://api.hubapi.com';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function get(url) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1000 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}\n${await r.text()}`);
    return r.json();
  }
  throw new Error('rate limit persistente: ' + url);
}

// ── 1. roster oficial: as opções da própria propriedade ────────────────────
// Metade do roster vem com o label em slug ("giovane-gavio"), metade por extenso.
// Sem normalizar, o cliente recebe indicação com nome de URL.
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
// ponytail: acento perdido no slug não volta (Giovane Gavio, Joao Kepler).
// Se um dia a plataforma do palestrante expuser o nome de exibição, puxar de lá e cair aqui só no fallback.
function nomeLegivel(bruto) {
  const s = bruto.trim().replace(/\s+/g, ' ');
  if (/[A-ZÀ-Þ]/.test(s)) return s;                     // tem maiúscula: já é nome próprio
  return s
    .split(/[-.\s]+/)
    .filter(p => p && !/^\d+$/.test(p))                 // sufixo de desambiguação: everton-lima-219854
    .map(p => (MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

const rosterProp = await get(`${HS}/crm/v3/properties/deals/palestrante_principal_correta`);
const roster = new Map(); // value -> label
for (const o of rosterProp.options || []) if (!o.hidden) roster.set(o.value, nomeLegivel(o.label));
console.log(`roster: ${roster.size} palestrantes`);

// ── 2. varre os deals (list API pagina sem o teto de 10k do search) ────────
const PROPS = [
  'palestrante_principal_correta', 'macro_tema', 'micro_tema', 'tema_do_evento',
  'amount', 'dealstage', 'pipeline', 'publico_estimado', 'formato_evento',
  'cidade_uf_do_evento', 'closedate',
].join(',');

const stats = new Map(); // slug -> agregado
let after = null, pages = 0, seen = 0, withSpeaker = 0;

do {
  const url = `${HS}/crm/v3/objects/deals?limit=100&properties=${PROPS}${after ? `&after=${after}` : ''}`;
  const page = await get(url);
  for (const d of page.results) {
    seen++;
    const p = d.properties;
    const key = p.palestrante_principal_correta;
    if (!key || !roster.has(key)) continue;
    withSpeaker++;

    if (!stats.has(key)) {
      stats.set(key, {
        nome: roster.get(key), deals: 0, ganhos: 0,
        soma: 0, somaGanha: 0, publico: [],
        macro: {}, micro: {}, tema: {}, formato: {}, uf: {}, ultimo: null,
      });
    }
    const a = stats.get(key);
    a.deals++;
    const amount = parseFloat(p.amount || '0') || 0;
    if (amount > 0) a.soma += amount;
    // "ganho" = etapa fechada com ganho em qualquer pipeline
    if (/closedwon|1076664460|1105295876|1323081481|1326633124|1188294461|1372708683/.test(p.dealstage || '')) {
      a.ganhos++;
      if (amount > 0) a.somaGanha += amount;
    }
    const pub = parseInt(p.publico_estimado || '0', 10);
    if (pub > 0) a.publico.push(pub);
    for (const [campo, alvo] of [['macro_tema', 'macro'], ['micro_tema', 'micro'], ['tema_do_evento', 'tema'], ['formato_evento', 'formato'], ['cidade_uf_do_evento', 'uf']]) {
      const v = p[campo];
      if (v) a[alvo][v] = (a[alvo][v] || 0) + 1;
    }
    if (p.closedate && (!a.ultimo || p.closedate > a.ultimo)) a.ultimo = p.closedate;
  }
  after = page.paging?.next?.after || null;
  if (++pages % 50 === 0) console.log(`  ${pages} páginas · ${seen} deals · ${withSpeaker} com palestrante`);
} while (after);

console.log(`varredura: ${seen} deals, ${withSpeaker} com palestrante, ${stats.size} palestrantes ativos`);

// ── 3. compacta para o que a curadoria precisa ─────────────────────────────
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const mediana = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const palestrantes = [...stats.entries()]
  .map(([id, a]) => ({
    id,
    nome: a.nome,
    deals: a.deals,
    ganhos: a.ganhos,
    ticket: a.soma > 0 ? Math.round(a.soma / a.deals) : null,
    ticketGanho: a.ganhos > 0 && a.somaGanha > 0 ? Math.round(a.somaGanha / a.ganhos) : null,
    publicoMediano: mediana(a.publico),
    macro: top(a.macro, 3),
    micro: top(a.micro, 4),
    tema: top(a.tema, 3),
    formato: top(a.formato, 2),
    uf: top(a.uf, 3),
    ultimo: a.ultimo ? a.ultimo.slice(0, 10) : null,
  }))
  .filter(p => p.deals >= 2)              // 1 deal isolado não é sinal de curadoria
  .sort((a, b) => b.deals - a.deals);

const out = `// GERADO por scripts/build-dataset.mjs — não editar à mão.
// Fonte: histórico de deals do HubSpot (propriedade palestrante_principal_correta).
export const GERADO_EM = ${JSON.stringify(new Date().toISOString().slice(0, 10))};
export const PALESTRANTES = ${JSON.stringify(palestrantes)};
`;

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/palestrantes.js', out);

const comTicket = palestrantes.filter(p => p.ticket);
console.log(`\ndata/palestrantes.js: ${palestrantes.length} palestrantes (>=2 deals), ${(out.length / 1024).toFixed(0)} KB`);
console.log(`ticket médio geral: R$ ${Math.round(comTicket.reduce((s, p) => s + p.ticket, 0) / comTicket.length)}`);
console.log('top 5:', palestrantes.slice(0, 5).map(p => `${p.nome} (${p.deals})`).join(', '));
