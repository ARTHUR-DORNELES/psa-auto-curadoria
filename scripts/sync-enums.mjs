// Injeta em ferramenta.html os enums REAIS do HubSpot (macro e micro tema).
// Lista escrita à mão vira valor inválido e o HubSpot rejeita o negócio inteiro.
//   node scripts/sync-enums.mjs
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.HUBSPOT_TOKEN
  || (fs.readFileSync(path.resolve('../tbs-2026-dashboard/.env.local'), 'utf8').match(/^HUBSPOT_TOKEN=(.+)$/m)[1]).trim().replace(/^"|"$/g, '');

const opcoes = async prop => {
  const r = await fetch(`https://api.hubapi.com/crm/v3/properties/deals/${prop}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`${r.status} ao ler ${prop}`);
  return (await r.json()).options.filter(o => !o.hidden).map(o => o.value);
};

const macro = await opcoes('macro_tema');
const micro = await opcoes('micro_tema');

// micro casa com macro pelo prefixo numérico ("16.2 ..." pertence ao macro "16. VENDAS")
const porMacro = {};
for (const v of micro) {
  const n = (v.match(/^(\d+)\./) || [])[1];
  if (!n) continue;
  (porMacro[n] = porMacro[n] || []).push(v);
}

const html = fs.readFileSync('ferramenta.html', 'utf8');
const trocar = (texto, marca, valor) => {
  const re = new RegExp(`const ${marca} = [\\s\\S]*?;\\n`);
  if (!re.test(texto)) throw new Error(`não achei a const ${marca} em ferramenta.html`);
  return texto.replace(re, `const ${marca} = ${valor};\n`);
};

let saida = trocar(html, 'MACRO', JSON.stringify(macro));
saida = trocar(saida, 'MICRO', JSON.stringify(porMacro, null, 0));
fs.writeFileSync('ferramenta.html', saida);

const semMicro = macro.filter(m => !porMacro[(m.match(/^(\d+)\./) || [])[1]]);
console.log(`macro_tema: ${macro.length} opções`);
console.log(`micro_tema: ${micro.length} opções em ${Object.keys(porMacro).length} grupos`);
console.log(`macros sem recorte: ${semMicro.map(m => m.replace(/^\d+\.\s*/, '')).join(', ') || '(nenhum)'}`);
