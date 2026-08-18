// Base para precificar a Auto Curadoria: distribuição de orçamento da demanda real,
// conversão por faixa e valor de um lead. node scripts/preco-analise.mjs
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.HUBSPOT_TOKEN
  || (fs.readFileSync(path.resolve('../tbs-2026-dashboard/.env.local'), 'utf8').match(/^HUBSPOT_TOKEN=(.+)$/m)?.[1] || '').trim().replace(/^"|"$/g, '');

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const get = async url => {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1000 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }
};

const GANHO = /closedwon|1076664460|1105295876|1323081481|1326633124|1188294461|1372708683/;
const PERDIDO = /closedlost|1076664461|1059939760|1323081482|1326633125|1188294462|1372708684/;

const PROPS = 'janeiro___orcamento,amount,dealstage,pipeline,palestrante_principal_correta,publico_estimado,createdate';

const faixas = new Map();
let after = null, pages = 0, total = 0;

do {
  const p = await get(`https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=${PROPS}${after ? `&after=${after}` : ''}`);
  for (const d of p.results) {
    total++;
    const pr = d.properties;
    // só demanda de palestrante (B2B/plataforma) — TBS/ecommerce não é o mesmo produto
    if (!['default', '881019761', '883258246', '807706157'].includes(pr.pipeline)) continue;
    const faixa = pr.janeiro___orcamento || '(não informado)';
    if (!faixas.has(faixa)) faixas.set(faixa, { n: 0, ganhos: 0, perdidos: 0, somaGanha: 0, valores: [] });
    const f = faixas.get(faixa);
    f.n++;
    const v = parseFloat(pr.amount || '0') || 0;
    if (GANHO.test(pr.dealstage || '')) { f.ganhos++; if (v > 0) { f.somaGanha += v; f.valores.push(v); } }
    else if (PERDIDO.test(pr.dealstage || '')) f.perdidos++;
  }
  after = p.paging?.next?.after || null;
  if (++pages % 100 === 0) console.error(`  ${pages} páginas...`);
} while (after);

const ORDEM = ['Até R$5.000,00', 'De R$5.001,00 até R$10.000,00', 'De R$10.001,00 até R$20.000,00',
  'De R$20.001,00 até R$50.000,00', 'De R$50.001,00 até R$100.000,00', 'Mais de R$100.001,00', '(não informado)'];
const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const comFaixa = [...faixas.entries()].filter(([k]) => k !== '(não informado)');
const totalComFaixa = comFaixa.reduce((s, [, v]) => s + v.n, 0);
const totalDemanda = [...faixas.values()].reduce((s, v) => s + v.n, 0);

console.log(`\n${total} deals varridos · ${totalDemanda} são demanda de palestrante · ${totalComFaixa} com faixa de orçamento declarada\n`);
console.log('FAIXA DE ORÇAMENTO                    n      % da demanda   ganhos   conversão   ticket ganho (mediana)');
for (const k of ORDEM) {
  const f = faixas.get(k);
  if (!f) continue;
  const fechados = f.ganhos + f.perdidos;
  const conv = fechados ? (f.ganhos / fechados * 100) : null;
  console.log(
    k.padEnd(36) +
    String(f.n).padStart(6) +
    (k === '(não informado)' ? '           —' : (f.n / totalComFaixa * 100).toFixed(1).padStart(11) + '%') +
    String(f.ganhos).padStart(9) +
    (conv === null ? '          —' : (conv.toFixed(1) + '%').padStart(11)) +
    (f.valores.length ? ('R$ ' + med(f.valores).toLocaleString('pt-BR')).padStart(22) : '                     —')
  );
}

const todosGanhos = comFaixa.flatMap(([, v]) => v.valores);
const gTot = comFaixa.reduce((s, [, v]) => s + v.ganhos, 0);
const pTot = comFaixa.reduce((s, [, v]) => s + v.perdidos, 0);
console.log(`\nconversão geral (ganho / fechados): ${(gTot / (gTot + pTot) * 100).toFixed(1)}%  (${gTot} ganhos, ${pTot} perdidos)`);
console.log(`ticket ganho mediano: R$ ${med(todosGanhos).toLocaleString('pt-BR')} · médio: R$ ${Math.round(todosGanhos.reduce((a, b) => a + b, 0) / todosGanhos.length).toLocaleString('pt-BR')}`);

// valor esperado de um briefing, se a comissão embutida for 20–30% do cachê
const tk = med(todosGanhos), conv = gTot / (gTot + pTot);
console.log(`\nvalor esperado de UM briefing qualificado (ticket mediano × conversão × comissão):`);
for (const com of [0.2, 0.25, 0.3]) {
  console.log(`  comissão ${(com * 100).toFixed(0)}%: R$ ${Math.round(tk * conv * com).toLocaleString('pt-BR')}`);
}
