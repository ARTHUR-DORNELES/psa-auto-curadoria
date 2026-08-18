// Injeta em ferramenta.html os municípios do IBGE, agrupados por UF.
// Lista fechada evita "Sao Paulo", "S. Paulo" e "são paulo" virando três cidades
// diferentes no HubSpot — o campo é texto livre lá, ninguém normaliza depois.
//   node scripts/sync-cidades.mjs
import fs from 'node:fs';

// Bundlado no build, não buscado em runtime: a resposta do IBGE traz microrregião e
// mesorregião aninhadas em cada município (284 KB só para SP), e um fetch a terceiro
// no meio do formulário adiciona latência e um ponto de falha. Só os nomes, tudo
// junto, dá ~80 KB crus / ~24 KB comprimidos.
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

const municipios = async uf => {
  const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`);
  if (!r.ok) throw new Error(`${r.status} ao ler municípios de ${uf}`);
  const j = await r.json();
  if (!j.length) throw new Error(`${uf} voltou sem municípios`);
  // localeCompare com pt-BR para "Águas" não cair depois de "Zé Doca"
  return j.map(c => c.nome).sort((a, b) => a.localeCompare(b, 'pt-BR'));
};

const porUf = {};
for (const uf of UFS) porUf[uf] = await municipios(uf);

const html = fs.readFileSync('ferramenta.html', 'utf8');
// \r? porque em clone no Windows com core.autocrlf=true o arquivo vem com CRLF
const re = /const CIDADES = [\s\S]*?;\r?\n/;
if (!re.test(html)) throw new Error('não achei a const CIDADES em ferramenta.html');
fs.writeFileSync('ferramenta.html', html.replace(re, `const CIDADES = ${JSON.stringify(porUf)};\n`));

const total = Object.values(porUf).reduce((s, c) => s + c.length, 0);
const maior = Object.entries(porUf).sort((a, b) => b[1].length - a[1].length)[0];
console.log(`cidades: ${total} em ${UFS.length} estados`);
console.log(`maior: ${maior[0]} com ${maior[1].length}`);
