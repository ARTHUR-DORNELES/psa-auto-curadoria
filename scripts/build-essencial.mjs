// Gera a LP da Auto Curadoria ESSENCIAL (essencial.html) a partir da LP completa (index.html).
// A fonte continua sendo uma só: aqui só trocamos título, hero, texto de venda e o card de preço.
//   node scripts/build-essencial.mjs   (roda junto no `npm run embed`)
//
// Essencial = mesma ferramenta, mesma IA. A diferença está nos nomes indicados: só palestrantes
// de cachê acessível (até R$ 5 mil) e condições especiais. "Permuta" é termo interno: NÃO aparece
// pro cliente.
import fs from 'node:fs';

// PROVISÓRIO (18/11/2026): preço e checkout da Essencial ainda não existem.
// Quando existirem, troque aqui e rode `npm run embed`.
const PRECO = 'A definir';
const PRECO_NOTA = 'valor e checkout em definição';
const CHECKOUT = 'https://api.whatsapp.com/send/?phone=5511964889660&text=Ol%C3%A1%2C+quero+a+Auto+Curadoria+Essencial&type=phone_number&app_absent=0';
const CTA_PLANO = 'Quero a Essencial →';

let s = fs.readFileSync('index.html', 'utf8');

function trocar(de, para, vezes = 1) {
  const n = s.split(de).length - 1;
  if (n !== vezes) throw new Error(`essencial: esperava ${vezes}x "${de.slice(0, 60)}", achei ${n} — o index.html mudou?`);
  s = s.split(de).join(para);
}

trocar('<title>Auto Curadoria | PSA Palestras</title>', '<title>Auto Curadoria Essencial | PSA Palestras</title>');
// NOME EM DESTAQUE (pedido do Renato, 18/11): selo grande no hero + etiqueta ao lado do logo
const SELO = (publico) => `<div class="selo-ess"><span class="selo-ess__nome">Auto Curadoria</span><span class="selo-ess__tag">Essencial</span></div>
        <span class="eyebrow">${publico}</span>`;
trocar('<span class="eyebrow">Para empresas · Auto Curadoria</span>', SELO('Para empresas'));
trocar('<span class="eyebrow">Para agências · Auto Curadoria</span>', SELO('Para agências'));
trocar(
  'alt="PSA Palestras" width="80" height="32"></a>',
  'alt="PSA Palestras" width="80" height="32"></a>\n    <span class="nav__prod">Auto Curadoria <b>Essencial</b></span>',
);
// CSS no mesmo <style> da página (o build do embed só leva o primeiro <style>)
{
  const css = `.selo-ess{display:flex;width:fit-content;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:var(--s-5)}
.selo-ess__nome{font-family:var(--font-display);font-weight:800;text-transform:uppercase;line-height:.9;font-size:clamp(30px,4.2vw,48px);color:#fff;letter-spacing:-.01em}
.selo-ess__tag{font-family:var(--font-display);font-weight:800;text-transform:uppercase;line-height:1;font-size:clamp(30px,4.2vw,48px);color:#fff;background:var(--psa-orange);padding:6px 16px 4px;border-radius:10px;transform:rotate(-2deg);box-shadow:0 8px 28px rgba(248,80,0,.35)}
.nav__prod{font-family:var(--font-body);font-weight:700;font-size:var(--t-caption);letter-spacing:.12em;text-transform:uppercase;color:var(--fg-2);border-left:1px solid #ffffff2b;padding-left:var(--s-4)}
.nav__prod b{color:var(--psa-orange)}
@media(max-width:860px){.nav__prod{display:none}}
`;
  const i = s.indexOf('</style>');
  if (i < 0) throw new Error('essencial: </style> não encontrado');
  s = s.slice(0, i) + css + s.slice(i);
}
trocar(
  'A Auto Curadoria é uma novidade onde, a partir do preenchimento do briefing, você recebe os nomes que dão match com o seu evento <strong>em até 5 minutos</strong>.',
  'A Auto Curadoria Essencial é a versão para eventos com orçamento enxuto: a partir do briefing, você recebe os nomes que dão match com o seu evento, <strong>só palestrantes com cachê de até R$ 5 mil</strong> ou em condições especiais, em até 5 minutos.',
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
          <li><strong>Só palestrantes com cachê de até R$ 5 mil</strong> ou em condições especiais</li>
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
trocar('<h2>Curadorias ilimitadas,<br>numa assinatura só.</h2>', '<h2>Curadoria de verdade,<br>no orçamento do seu evento.</h2>');
trocar(
  'A Auto Curadoria é uma assinatura mensal: monte quantas curadorias quiser, sem limite. O cachê do palestrante é apresentado à parte, na proposta de cada indicação.',
  'A Essencial usa a mesma IA e o mesmo briefing da Auto Curadoria, com indicações dentro de um orçamento enxuto. O cachê do palestrante é apresentado à parte, na proposta de cada indicação.',
);

fs.writeFileSync('essencial.html', s);
console.log(`essencial.html: ${(s.length / 1024).toFixed(0)} KB (gerado de index.html)`);
