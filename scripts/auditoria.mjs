// Lista curadorias que não viraram negócio no HubSpot — e, com --corrigir, reprocessa.
// Rode depois de qualquer mexida no CRM ou se o time reclamar de lead que não apareceu.
//   node scripts/auditoria.mjs
//   node scripts/auditoria.mjs --corrigir
import Redis from 'ioredis';
import { registrarNoHubspot, chave } from '../api/_lib.js';

const corrigir = process.argv.includes('--corrigir');
const r = new Redis(process.env.REDIS_URL);

const chaves = await r.keys('autocuradoria:*');
const registros = [];
for (const k of chaves) registros.push(JSON.parse(await r.get(k)));
registros.sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));

const orfaos = registros.filter(x => !x.hubspot?.negocioId);

console.log(`${registros.length} curadorias · ${registros.length - orfaos.length} com negócio · ${orfaos.length} sem negócio`);
const pagosOrfaos = orfaos.filter(x => x.pago);
if (pagosOrfaos.length) console.log(`\n⚠  ${pagosOrfaos.length} PAGAS sem negócio no CRM — prioridade máxima`);

for (const x of orfaos) {
  console.log(`\n${x.criadoEm.slice(0, 16)} · ${x.id}${x.pago ? ' · PAGO' : ''}`);
  console.log(`  ${x.briefing.empresa} · ${x.briefing.email} · ${x.briefing.tema}`);
  console.log(`  erro: ${x.hubspotErro || '(não registrado — falha anterior à instrumentação)'}`);

  if (corrigir) {
    try {
      const hubspot = await registrarNoHubspot(x.briefing, x.resultado, x.id);
      await r.set(chave(x.id), JSON.stringify({ ...x, hubspot, hubspotErro: null }), 'EX', 60 * 60 * 24 * 90);
      console.log(`  → corrigido: negócio ${hubspot.negocioId}`);
    } catch (e) {
      console.log(`  → ainda falha: ${e.message.slice(0, 200)}`);
    }
  }
}

if (orfaos.length && !corrigir) console.log('\nrode com --corrigir para reprocessar no HubSpot');
await r.quit();
