// Gera os widgets embutíveis na landing page do HubSpot a partir dos HTMLs soltos.
// Os HTMLs continuam sendo a fonte única — nada é mantido em dois lugares.
//   node scripts/build-embed.mjs
import fs from 'node:fs';

const API = process.env.API_BASE || 'https://psa-auto-curadoria.vercel.app';

// Duas páginas, dois links. A LP vende e manda para a ferramenta; a ferramenta é
// uma página própria (com header e rodapé dela). Tentei página única antes: o CSS
// da LP é escopado na raiz dela, então mover só o <footer> para outra raiz o deixa
// sem estilo. Markup e escopo têm de morar na mesma raiz.
// Slug plano, não aninhado: o HubSpot aceita salvar `auto-curadoria/comecar` mas
// serve a página de erro nele (que responde 200 — não dá para confiar só no status).
const URL_FERRAMENTA = process.env.URL_FERRAMENTA || '/auto-curadoria-briefing';

const ALVOS = [
  // a ferramenta: form + curadoria + paywall
  { fonte: 'ferramenta.html', saida: 'embed.js', raiz: '#psa-auto-curadoria', voltarPara: '/auto-curadoria' },
  // a LP: conteúdo de venda; CTAs levam para a página da ferramenta
  { fonte: 'index.html', saida: 'embed-lp.js', raiz: '#psa-auto-curadoria-lp', destinoCta: URL_FERRAMENTA },
];

/**
 * Quebra o CSS nos blocos de primeiro nível contando chaves.
 * Regex não serve: @media e @keyframes têm blocos dentro de blocos, e um
 * `[\s\S]*?\}` não-guloso corta no primeiro fecha-chave interno.
 */
function blocosDeTopo(texto) {
  const blocos = [];
  let inicio = 0, profundidade = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '{') profundidade++;
    else if (c === '}') {
      profundidade--;
      if (profundidade === 0) {
        const bruto = texto.slice(inicio, i + 1).trim();
        if (bruto) blocos.push(bruto);
        inicio = i + 1;
      }
    }
  }
  return blocos;
}

function escoparCss(css, RAIZ) {
  const prefixar = seletores => seletores.split(',').map(s => {
    const sel = s.trim();
    if (!sel) return sel;
    if (sel === 'body' || sel === 'html') return RAIZ;   // o widget É o "body" dele
    if (sel === '*') return `${RAIZ}, ${RAIZ} *`;
    if (sel.startsWith(RAIZ)) return sel;
    return `${RAIZ} ${sel}`;
  }).join(',');

  const escopar = bloco => {
    const abre = bloco.indexOf('{');
    return `${prefixar(bloco.slice(0, abre))}{${bloco.slice(abre + 1)}`;
  };

  // @font-face, @keyframes e :root ficam globais (fontes e variáveis não colidem);
  // @media tem o miolo escopado bloco a bloco; todo o resto é escopado direto.
  let globais = 0;
  const final = blocosDeTopo(css).map(bloco => {
    if (/^(@font-face|@keyframes|@supports\b)/.test(bloco) || /^:root\s*\{/.test(bloco)) {
      globais++;
      return bloco;
    }
    if (/^@media/.test(bloco)) {
      const abre = bloco.indexOf('{');
      const dentro = bloco.slice(abre + 1, bloco.lastIndexOf('}'));
      return `${bloco.slice(0, abre)}{${blocosDeTopo(dentro).map(escopar).join('')}}`;
    }
    return escopar(bloco);
  }).join('\n');

  const nus = [...final.matchAll(/(^|\})\s*(body|html|header|footer|main|input|select|textarea|label|h1|h2|h3|img|a)\s*[,{]/g)];
  if (nus.length) throw new Error(`${RAIZ}: seletor nu escapou do escopo: ${nus.slice(0, 3).map(x => x[2])}`);
  if (!final.includes(RAIZ)) throw new Error(`${RAIZ}: escopo não aplicado`);

  return { css: final, globais };
}

for (const alvo of ALVOS) {
  const src = fs.readFileSync(alvo.fonte, 'utf8');

  // comentário antes de um seletor entra no seletor ao prefixar (e faz `body` deixar
  // de ser reconhecido como `body`). Num bundle gerado não servem para nada.
  const cssBruto = src.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const { css, globais } = escoparCss(cssBruto, alvo.raiz);

  let corpo = src.match(/<body>([\s\S]*?)(?:<script>|<\/body>)/)[1];
  let js = (src.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/) || [, ''])[1];

  if (js) {
    // API absoluta: a página roda no domínio da PSA, a API na Vercel
    js = js.replace('const $ = s => document.querySelector(s);', `const API = ${JSON.stringify(API)};\nconst $ = s => document.querySelector(s);`)
           .replaceAll("'/api/", "API+'/api/")
           .replaceAll('`/api/', '`${API}/api/');
    const refs = (js.match(/API\s*\+\s*'\/api\/|\$\{API\}\/api\//g) || []).length;
    if (refs < 5) throw new Error(`${alvo.fonte}: só ${refs} chamadas de API reescritas — o padrão do fetch mudou?`);
  }

  // CTAs da LP apontam para a página da ferramenta
  if (alvo.destinoCta) {
    const antes = (corpo.match(/href="\/ferramenta"/g) || []).length;
    if (!antes) throw new Error(`${alvo.fonte}: nenhum CTA para /ferramenta — os links mudaram?`);
    corpo = corpo.replaceAll('href="/ferramenta"', `href="${alvo.destinoCta}"`);
    console.log(`  ${antes} CTAs -> ${alvo.destinoCta}`);
  }

  // logo e "voltar" da ferramenta levam para a LP. A raiz do domínio de landing
  // pages do HubSpot é 404, então href="/" não serve.
  if (alvo.voltarPara) {
    const antes = (corpo.match(/href="\/"/g) || []).length;
    if (antes !== 2) throw new Error(`${alvo.fonte}: esperava 2 links para "/" (logo e voltar), achei ${antes}`);
    corpo = corpo.replaceAll('href="/"', `href="${alvo.voltarPara}"`);
  }

  const saida = `// Auto Curadoria PSA — widget embutível (${alvo.fonte}).
// GERADO por scripts/build-embed.mjs. Não editar à mão.
// Uso: <div id="${alvo.raiz.slice(1)}"></div><script src="${API}/${alvo.saida}"><\/script>
(function () {
  var alvo = document.getElementById(${JSON.stringify(alvo.raiz.slice(1))});
  if (!alvo) { console.error('[auto-curadoria] falta <div id="${alvo.raiz.slice(1)}"></div>'); return; }

  var estilo = document.createElement('style');
  estilo.textContent = ${JSON.stringify(css)};
  document.head.appendChild(estilo);

  alvo.innerHTML = ${JSON.stringify(corpo)};
${js ? `
  // script injetado como texto: roda no escopo global, como rodava na página solta
  var s = document.createElement('script');
  s.textContent = ${JSON.stringify(js)};
  document.body.appendChild(s);
` : ''}})();
`;

  fs.writeFileSync(alvo.saida, saida);
  console.log(`${alvo.saida}: ${(saida.length / 1024).toFixed(0)} KB · ${globais} blocos globais · ${js ? 'com JS' : 'estático'}`);
}
