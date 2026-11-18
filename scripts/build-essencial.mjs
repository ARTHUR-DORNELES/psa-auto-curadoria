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
trocar('<span class="eyebrow">Para empresas · Auto Curadoria</span>', '<span class="eyebrow">Para empresas · Auto Curadoria Essencial</span>');
trocar('<span class="eyebrow">Para agências · Auto Curadoria</span>', '<span class="eyebrow">Para agências · Auto Curadoria Essencial</span>');
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
