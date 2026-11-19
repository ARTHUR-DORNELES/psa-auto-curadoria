// Gera a LP da Auto Curadoria ESSENCIAL (essencial.html) a partir da LP completa (index.html).
// A fonte continua sendo uma só: aqui só trocamos título, hero, texto de venda e o card de preço.
//   node scripts/build-essencial.mjs   (roda junto no `npm run embed`)
//
// Essencial = mesma ferramenta, mesma IA. A diferença está nos nomes indicados: só palestrantes
// de cachê acessível (até R$ 5 mil) e condições especiais. "Permuta" é termo interno: NÃO aparece
// pro cliente.
import fs from 'node:fs';

// Preço e checkout da Essencial (Renato, 18/11/2026): plano ANUAL de R$ 240/ano. Mudou? troque aqui e rode `npm run embed`.
// Texto da Essencial nunca fala "cachê": só "valores até R$ 5 mil" (Renato, 18/11).
const PRECO = 'R$ 240<small> /ano</small>';
const PRECO_NOTA = 'cobrança anual';
const CHECKOUT = 'https://checkout.profissionaissa.com.br/curadoria/checkout/f3624a16-5d41-47c6-9ab1-f6e72ddb6f72';
const CTA_PLANO = 'Adquirir agora →';

let s = fs.readFileSync('index.html', 'utf8');

function trocar(de, para, vezes = 1) {
  const n = s.split(de).length - 1;
  if (n !== vezes) throw new Error(`essencial: esperava ${vezes}x "${de.slice(0, 60)}", achei ${n} — o index.html mudou?`);
  s = s.split(de).join(para);
}

trocar('<title>Auto Curadoria | PSA Palestras</title>', '<title>Auto Curadoria Essencial | PSA Palestras</title>');
// HERO PRÓPRIO (Renato, 18/11): sem o "Tá com pressa?"; o nome do produto é o título
// e o texto fala da Essencial. As LPs podem ser diferentes.
const SELO = `<h1 class="selo-ess"><span class="selo-ess__nome">Auto Curadoria</span><span class="selo-ess__tag">Essencial</span></h1>`;
trocar(`<span class="eyebrow">Para empresas · Auto Curadoria</span>
        <h1>Tá com pressa?<br><em>Sem problema.</em></h1>`, SELO);
// slide de agências sai (Renato, 18/11): hero de um slide só, sem as bolinhas do carrossel
// (o JS do carrossel já não roda com menos de 2 slides)
{
  const a = s.indexOf('    <div class="hero__slide" id="hero-agencias">');
  const fimRail = s.indexOf('  </div></div>\n  <div class="wrap"><div class="hero__dots">', a);
  const fimDots = s.indexOf('</div></div>', s.indexOf('<div class="hero__dots">', fimRail)) + '</div></div>'.length;
  if (a < 0 || fimRail < 0) throw new Error('essencial: slide de agências não encontrado');
  s = s.slice(0, a) + s.slice(fimRail, fimRail + '  </div></div>\n'.length) + s.slice(fimDots + 1);
}
// número do banco na Essencial (Renato, 18/11)
trocar('<div class="stat__k">+80 mil</div>', '<div class="stat__k">+10 mil</div>');
trocar(
  'alt="PSA Palestras" width="80" height="32"></a>',
  'alt="PSA Palestras" width="80" height="32"></a>\n    <span class="nav__prod">Auto Curadoria <b>Essencial</b></span>',
);
// CSS no mesmo <style> da página (o build do embed só leva o primeiro <style>)
{
  const css = `.selo-ess{display:flex;width:fit-content;align-items:center;gap:6px 18px;flex-wrap:wrap;margin:0 0 var(--s-5)}
.selo-ess__nome{font-family:var(--font-display);font-weight:800;text-transform:uppercase;line-height:.9;font-size:clamp(44px,7vw,96px);color:#fff;letter-spacing:-.01em;margin:0}
.selo-ess__tag{font-family:var(--font-display);font-weight:800;text-transform:uppercase;line-height:1;font-size:clamp(44px,7vw,96px);color:#fff;background:var(--psa-orange);padding:6px 16px 4px;border-radius:10px;transform:rotate(-2deg);box-shadow:0 8px 28px rgba(248,80,0,.35)}
.nav__prod{font-family:var(--font-body);font-weight:700;font-size:var(--t-caption);letter-spacing:.12em;text-transform:uppercase;color:var(--fg-2);border-left:1px solid #ffffff2b;padding-left:var(--s-4)}
.nav__prod b{color:var(--psa-orange)}
@media(max-width:860px){.nav__prod{display:none}}
.hero__rail{width:100%}.hero__slide{flex:0 0 100%;width:100%}
`;
  const i = s.indexOf('</style>');
  if (i < 0) throw new Error('essencial: </style> não encontrado');
  s = s.slice(0, i) + css + s.slice(i);
}
trocar(
  'A Auto Curadoria é uma novidade onde, a partir do preenchimento do briefing, você recebe os nomes que dão match com o seu evento <strong>em até 5 minutos</strong>.',
  'Curadoria de palestrantes para eventos com orçamento enxuto. Preencha o briefing e receba, em até 5 minutos, os nomes que dão match com o seu evento: <strong>só palestrantes com valores até R$ 5 mil</strong>.',
);

// card de preço: troca os dois planos por um só, da Essencial
const ini = s.indexOf('<div class="price">');
const fim = s.indexOf('<p style="margin-top:var(--s-5)', ini);
if (ini < 0 || fim < 0) throw new Error('essencial: bloco de preço não encontrado');
const plano = `<div class="price" style="grid-template-columns:minmax(0,440px)">
      <div class="plan plan--hi">
        <span class="eyebrow">Auto Curadoria<span class="plan__tag">Essencial</span></span>
        <div>
          <div class="plan__v">${PRECO}</div>
          <div style="font-family:var(--font-body);font-size:var(--t-body-sm);font-weight:700;color:var(--fg-bone-3);margin-top:8px">${PRECO_NOTA}</div>
        </div>
        <ul>
          <li><strong>Só palestrantes com valores até R$ 5 mil</strong></li>
          <li>Briefing guiado do evento</li>
          <li>Busca da IA no banco PSA</li>
          <li>Até 5 nomes por curadoria, com justificativa e ponto de atenção</li>
          <li>Solicitação de viabilidade de data</li>
          <li>Solicitação de orçamento conduzida pelo time PSA</li>
        </ul>
        <a class="btn btn--primary" href="${CHECKOUT}" style="justify-self:start">${CTA_PLANO}</a>
      </div>
    </div>
    `;
s = s.slice(0, ini) + plano + s.slice(fim);
// WhatsApp da Essencial (Renato, 18/11): todo link de WhatsApp da LP vai pra este contato
const WHATS = 'https://api.whatsapp.com/send/?phone=5511941610237&amp;text=Ol%C3%A1%2C+vim+pela+Auto+Curadoria+e+gostaria+de+mais+informa%C3%A7%C3%B5es&amp;type=phone_number&amp;app_absent=0';
s = s.replace(/https:\/\/api\.whatsapp\.com\/send\/\?phone=\d+[^"']*/g, WHATS);
// qualquer outro botão de compra que sobrou da LP completa (ex.: card do Comparativo) vai pro checkout da Essencial
s = s.split('https://checkout.profissionaissa.com.br/curadoria/checkout/4fbc7e0d-c39c-4241-9334-ef62c2326b55').join(CHECKOUT);
trocar('<h2>Curadorias ilimitadas,<br>numa assinatura só.</h2>', '<h2>Curadoria de verdade,<br>no orçamento do seu evento.</h2>');
trocar(
  'A Auto Curadoria é uma assinatura mensal: monte quantas curadorias quiser, sem limite. O cachê do palestrante é apresentado à parte, na proposta de cada indicação.',
  'A Essencial usa a mesma IA e o mesmo briefing da Auto Curadoria, com indicações dentro de um orçamento enxuto: todos os palestrantes têm valores até R$ 5 mil.',
);

trocar('O cachê do palestrante não está incluso e é apresentado na proposta.', 'O valor do palestrante não está incluso na assinatura e aparece em cada indicação, sempre até R$ 5 mil.');
trocar('<p>A Auto Curadoria é uma assinatura em dois planos: <strong>mensal</strong> (R$ 1.150/mês, sem fidelidade, até 50 curadorias por mês) ou <strong>anual</strong> (R$ 996/mês, R$ 11.952/ano, curadorias ilimitadas). O cachê do palestrante não está incluso e é apresentado à parte, na proposta comercial de cada indicação.</p>',
  '<p>A Auto Curadoria Essencial é uma assinatura <strong>anual de R$ 240</strong>. O valor do palestrante não está incluso e aparece em cada indicação, sempre até R$ 5 mil.</p>');
if (/cach[êe]/i.test(s.replace(/<style>[\s\S]*?<\/style>/g, ''))) console.warn('essencial: ainda sobrou "cachê" no texto da LP');
// CTAs marcam a origem: na ferramenta, "voltar" e o logo levam de volta para a LP Essencial
s = s.split('href="/ferramenta"').join('href="/ferramenta?lp=essencial"');
// rastro da jornada (aba Essencial do painel) + código do HubSpot: visita da LP, clique no CTA,
// e os links pra ferramenta levam UTM e o id do visitante (a ferramenta continua a jornada).
{
  const js = `<!--rastro-->
<script>
(function () {
  var q = new URLSearchParams(location.search), utm = {};
  q.forEach(function (v, k) { if (k.indexOf('utm_') === 0) utm[k] = v; });
  var vid = ''; try { vid = localStorage.getItem('ac_vid') || ''; } catch (e) {}
  if (!/^[a-z0-9]{8,40}$/i.test(vid)) vid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem('ac_vid', vid); } catch (e) {}
  function ev(tipo, d) {
    try {
      var c = JSON.stringify({ acao: 'evento', vid: vid, tipo: tipo, utm: utm, ref: document.referrer || '', lp: 'essencial', d: d || '' });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/rastro', new Blob([c], { type: 'application/json' }))))
        fetch('/api/rastro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: c, keepalive: true });
    } catch (e) {}
  }
  ev('lp_visita');
  document.querySelectorAll('a[href*="/ferramenta"]').forEach(function (a) {
    try {
      var u = new URL(a.getAttribute('href'), location.href);
      Object.keys(utm).forEach(function (k) { u.searchParams.set(k, utm[k]); });
      u.searchParams.set('vid', vid);
      a.setAttribute('href', u.pathname + u.search);
    } catch (e) {}
    a.addEventListener('click', function () { ev('lp_cta', (a.textContent || '').trim().slice(0, 60)); });
  });
})();
</script>
<script id="hs-script-loader" async defer src="https://js.hs-scripts.com/49656171.js"></script>
<!--/rastro-->
`;
  const i = s.lastIndexOf('</body>');
  if (i < 0) throw new Error('essencial: </body> não encontrado');
  s = s.slice(0, i) + js + s.slice(i);
}
fs.writeFileSync('essencial.html', s);
console.log(`essencial.html: ${(s.length / 1024).toFixed(0)} KB (gerado de index.html)`);
