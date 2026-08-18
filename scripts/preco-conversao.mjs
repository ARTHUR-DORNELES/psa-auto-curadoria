// Conversão real por pipeline, via contagem direta (total do search, sem varrer tudo).
// node scripts/preco-conversao.mjs
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.HUBSPOT_TOKEN
  || (fs.readFileSync(path.resolve('../tbs-2026-dashboard/.env.local'), 'utf8').match(/^HUBSPOT_TOKEN=(.+)$/m)?.[1] || '').trim().replace(/^"|"$/g, '');

async function contar(filtros) {
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1, properties: ['dealname'], filterGroups: [{ filters: filtros }] }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()).total;
}

// funis de demanda de palestrante e suas etapas de ganho/perda
const FUNIS = [
  // ATENÇÃO: o funil B2B remapeou os rótulos dos ids internos —
  // 'closedwon' é "Proposta enviada" e 'closedlost' é "Em negociação". Ganho real é 1076664460.
  { nome: 'B2B (default)', id: 'default', ganho: ['1076664460'], perdido: ['1076664461'] },
  { nome: 'Demandas na plataforma', id: '881019761', ganho: ['1323081481'], perdido: ['1323081482'] },
  { nome: 'Demandas gratuitas', id: '883258246', ganho: ['1326633124'], perdido: ['1326633125'] },
  { nome: 'Mercado Livre/Partner', id: '807706157', ganho: ['1188294461'], perdido: ['1188294462'] },
];

let gTot = 0, pTot = 0, nTot = 0;
console.log('FUNIL                          total     ganhos   perdidos   conversão');
for (const f of FUNIS) {
  const base = { propertyName: 'pipeline', operator: 'EQ', value: f.id };
  const n = await contar([base]);
  const g = await contar([base, { propertyName: 'dealstage', operator: 'IN', values: f.ganho }]);
  const p = await contar([base, { propertyName: 'dealstage', operator: 'IN', values: f.perdido }]);
  nTot += n; gTot += g; pTot += p;
  const conv = g + p ? (g / (g + p) * 100).toFixed(1) + '%' : '—';
  console.log(f.nome.padEnd(28) + String(n).padStart(7) + String(g).padStart(11) + String(p).padStart(11) + conv.padStart(12));
}

const conv = gTot / (gTot + pTot);
console.log('\nTOTAL'.padEnd(28) + String(nTot).padStart(7) + String(gTot).padStart(11) + String(pTot).padStart(11) + (conv * 100).toFixed(1).padStart(11) + '%');
console.log(`abertos (nem ganho nem perdido): ${nTot - gTot - pTot}`);

// valor de um briefing de entrada, com o ticket ganho mediano medido antes
const TICKET = 7650;
console.log(`\nvalor esperado de UM briefing de entrada (ticket ganho mediano R$ ${TICKET.toLocaleString('pt-BR')} × conversão ${(conv * 100).toFixed(1)}%):`);
for (const c of [0.2, 0.25, 0.3]) {
  console.log(`  comissão ${(c * 100).toFixed(0)}%: R$ ${(TICKET * conv * c).toFixed(0)}`);
}
console.log('\nAtenção: essa conversão é de TODA a demanda de entrada (fria, sem qualificação).');
console.log('Um cliente que preenche briefing de 3 passos e paga não converte a essa taxa — é o piso, não a estimativa.');
