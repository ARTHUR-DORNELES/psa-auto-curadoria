// Checagem mínima do que quebra caro: pré-seleção e vazamento do teaser.
// node scripts/test-curadoria.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { teaser, paraCliente, semNumerosInternos, notaDoBriefing, escolherTres, lerNomes, valorEmReais, faixaDeValor, telefoneE164, cors, chaveDeNome } from '../api/_lib.js';

let ok = 0;
const t = (nome, fn) => { fn(); console.log('✓', nome); ok++; };

t('teaser não vaza nome, motivos extras nem ponto de atenção', () => {
  const completo = {
    leitura: 'evento precisa de virada de cultura',
    indicacoes: [{
      id: 'x', nome: 'Fulano Secreto', perfil: 'Referência em cultura',
      porque: ['motivo 1 visível', 'motivo 2 secreto', 'motivo 3 secreto'],
      atencao: 'agenda apertada', aderencia: 'alta',
      dados: { deals: 10, ticket: 9000 },
    }],
  };
  const bruto = JSON.stringify(teaser(completo));
  assert.ok(!bruto.includes('Fulano Secreto'), 'nome vazou no teaser');
  assert.ok(!bruto.includes('motivo 2 secreto'), 'motivo oculto vazou');
  assert.ok(!bruto.includes('agenda apertada'), 'ponto de atenção vazou');
  assert.ok(bruto.includes('motivo 1 visível'), 'teaser precisa mostrar o primeiro motivo');
  assert.equal(teaser(completo).indicacoes[0].motivosOcultos, 2);
});

// O núcleo comercial da PSA (quantos contratos, quantos fechados, cachê praticado)
// não pode sair na indicação: com um briefing por macro tema, qualquer um mapeia
// o casting. O paywall não protege isso — só a ausência do dado protege.
t('cifra e contagem interna nunca chegam ao cliente', () => {
  assert.equal(semNumerosInternos('Ticket médio de R$ 8.715, dentro do orçamento'), 'Ticket médio de valor sob proposta, dentro do orçamento');
  assert.equal(semNumerosInternos('269 contratações e 41 fechadas na PSA'), 'diversas contratações e diversas fechadas na PSA');
  assert.equal(semNumerosInternos('cachê de R$ 12 mil'), 'cachê de valor sob proposta');
  for (const frase of ['R$ 8.715', '283 contratações', '41 eventos fechados', 'R$12k', 'R$ 100.000,00']) {
    const limpo = semNumerosInternos(frase);
    assert.ok(!/R\$/.test(limpo), `cifra sobreviveu: ${limpo}`);
    assert.ok(!/\b\d{2,}\s+(contrata|eventos|fechad)/i.test(limpo), `contagem sobreviveu: ${limpo}`);
  }
  // "3 nomes" e "2026" são legítimos: o filtro não pode comer número inofensivo
  assert.equal(semNumerosInternos('3 nomes indicados'), '3 nomes indicados');
});

t('paraCliente não expõe o registro bruto do palestrante', () => {
  const completo = {
    leitura: 'ok',
    indicacoes: [{
      id: 'fulano-slug', nome: 'Fulano', perfil: 'p', porque: ['a'], atencao: 'b', aderencia: 'alta',
      dados: { deals: 283, ganhos: 35, ticket: 8715, publicoMediano: 200, id: 'fulano-slug' },
    }],
  };
  const bruto = JSON.stringify(paraCliente(completo));
  for (const vazamento of ['283', '8715', 'ticket', 'deals', 'publicoMediano', 'fulano-slug']) {
    assert.ok(!bruto.includes(vazamento), `${vazamento} vazou para o cliente`);
  }
  assert.ok(bruto.includes('Fulano'), 'o nome tem de continuar visível');
});

// A automação de curadoria vai LER esta nota. Se um campo sumir dela, a automação
// recebe briefing incompleto e ninguém percebe até a indicação sair ruim.
t('a nota do negócio carrega todo o briefing preenchido', () => {
  const b = {
    nome: 'Ana Souza', empresa: 'Alfa S.A.', email: 'ana@alfa.com.br', telefone: '+5511999999999',
    macroTema: '19. LIDERANÇA', microTema: '19.1 Algo', publicoAlvo: 'Gestores e lideranças intermediárias',
    formato: 'Palestra', data: '2026-11-20', local: 'SP', orcamento: 'De R$10.001,00 até R$20.000,00',
    motivacao: 'Queda de resultado ou meta não batida', sentimento: 'Motivados a agir imediatamente',
    briefing: 'contexto livre do cliente', utm: { utm_source: 'google' },
  };
  const nota = notaDoBriefing(b, null, 'abc-123');
  for (const [campo, valor] of Object.entries(b)) {
    if (campo === 'utm' || campo === 'data') continue;
    assert.ok(nota.includes(valor), `"${campo}" não entrou na nota`);
  }
  assert.ok(nota.includes('20/11/2026'), 'data tem de sair em formato BR');
  assert.ok(nota.includes('utm_source: google'), 'origem não entrou na nota');
  assert.ok(nota.includes('abc-123'), 'id da curadoria não entrou na nota');
});

// Escrevi essa lista à mão uma vez e inventei valores ("10.3 Engajamento" em vez de
// "10.3 Gestão de Liderança"): o HubSpot rejeita a propriedade e o negócio inteiro
// não é criado. As listas têm de vir de `npm run enums`.
t('os enums do formulário são coerentes com o HubSpot', () => {
  const html = fs.readFileSync('ferramenta.html', 'utf8');
  const macro = JSON.parse(html.match(/const MACRO = (\[[\s\S]*?\]);/)[1]);
  const micro = JSON.parse(html.match(/const MICRO = (\{[\s\S]*?\});/)[1]);

  assert.equal(macro.length, 25, 'macro_tema deveria ter 25 opções');
  assert.ok(macro.every(m => /^\d+\.\s/.test(m)), 'todo macro tema é prefixado por número');

  const numerosMacro = new Set(macro.map(m => m.match(/^(\d+)\./)[1]));
  for (const [n, lista] of Object.entries(micro)) {
    assert.ok(numerosMacro.has(n), `grupo de micro tema "${n}" não corresponde a nenhum macro`);
    assert.ok(lista.every(v => v.startsWith(`${n}.`)), `micro tema fora do grupo ${n}`);
  }
  assert.equal(Object.values(micro).flat().length, 135, 'micro_tema deveria ter 135 opções');
});

// O arquivo da IA Curadoria traz 5 nomes: 1 permuta, 2 matriz, 2 melhores.
// Vão 3 para o cliente: 1 de cada. Sem permuta, 2 matriz + 1 melhores.
t('escolha dos 3 nomes respeita a cota por categoria', () => {
  const n = (categoria, i) => ({ nome: `${categoria}-${i}`, categoria });
  const cheio = [n('permuta', 1), n('matriz', 1), n('matriz', 2), n('melhores', 1), n('melhores', 2)];

  const comPermuta = escolherTres(cheio).map(x => x.categoria);
  assert.deepEqual(comPermuta, ['permuta', 'matriz', 'melhores'], '1/1/1 quando há permuta');

  const semPermuta = escolherTres(cheio.filter(x => x.categoria !== 'permuta'));
  assert.deepEqual(semPermuta.map(x => x.categoria), ['matriz', 'matriz', 'melhores'], '0/2/1 sem permuta');

  // pega sempre o primeiro de cada categoria, na ordem do arquivo
  assert.deepEqual(escolherTres(cheio).map(x => x.nome), ['permuta-1', 'matriz-1', 'melhores-1']);

  // arquivo incompleto: devolver 3 nomes importa mais que a proporção
  const magro = [n('matriz', 1), n('melhores', 1), n('melhores', 2), n('melhores', 3)];
  const r = escolherTres(magro);
  assert.equal(r.length, 3, 'tem de devolver 3 mesmo com categoria faltando');
  assert.equal(new Set(r.map(x => x.nome)).size, 3, 'sem nome repetido');

  // arquivo com menos de 3 nomes não inventa
  assert.equal(escolherTres([n('matriz', 1), n('melhores', 1)]).length, 2);
  assert.equal(escolherTres([]).length, 0);
});

// A automação grava os 5 nomes numa propriedade do negócio. JSON é o formato
// pedido, mas texto solto não pode derrubar a entrega.
t('lê os 5 nomes da propriedade em JSON e em texto', () => {
  const json = JSON.stringify([
    { nome: 'A', categoria: 'Permuta', perfil: 'p', porque: ['m1', 'm2'], atencao: 'a' },
    { nome: 'B', categoria: 'Matriz' }, { nome: 'C', categoria: 'matriz' },
    { nome: 'D', categoria: 'Melhores' }, { nome: 'E', categoria: 'MELHORES' },
  ]);
  const deJson = lerNomes(json);
  assert.equal(deJson.length, 5);
  assert.deepEqual(deJson.map(n => n.categoria), ['permuta', 'matriz', 'matriz', 'melhores', 'melhores'], 'categoria normalizada');
  assert.deepEqual(deJson[0].porque, ['m1', 'm2']);

  // embrulhado num objeto, como algumas automações devolvem
  assert.equal(lerNomes(JSON.stringify({ nomes: [{ nome: 'X', categoria: 'permuta' }] })).length, 1);

  // texto "categoria: nome" por linha
  const texto = 'Permuta: Fulano\nMatriz: Beltrano\nMatriz: Cicrano\nMelhores: Deltrano\nMelhores: Eltrano';
  const deTexto = lerNomes(texto);
  assert.equal(deTexto.length, 5, 'texto solto também tem de ser lido');
  assert.equal(deTexto[0].nome, 'Fulano');
  assert.equal(deTexto[0].categoria, 'permuta');

  // Formato REAL da automação: categoria de duas palavras ("Melhor geral") e os
  // motivos como marcadores nas linhas seguintes. A versão anterior lia só
  // "Matriz:" e devolvia 1 nome de 3 — o cliente via uma indicação só.
  const real = [
    'Matriz: Alsones Balestrin',
    '  - Ele está no Top 100 da América Latina porque transforma ciência em lucro.',
    '  - 4.500 citações acadêmicas viram cases reais.',
    '',
    'Melhor geral: Cristiano Machado',
    '  - Co-fundador de CustomerLab, ele respira varejo e e-commerce.',
    '',
    'Melhor geral: André Santos',
    '  - 445 mil seguidores no LinkedIn.',
    '  - LinkedIn Top Voice e mentor de C-Levels.',
  ].join('\n');
  const doReal = lerNomes(real);
  assert.equal(doReal.length, 3, `deveria ler 3 nomes, leu ${doReal.length}`);
  assert.deepEqual(doReal.map(n => n.categoria), ['matriz', 'melhores', 'melhores'], '"Melhor geral" é melhores');
  assert.deepEqual(doReal.map(n => n.nome), ['Alsones Balestrin', 'Cristiano Machado', 'André Santos']);
  assert.equal(doReal[0].porque.length, 2, 'os marcadores viram motivos');
  assert.ok(doReal[0].porque[0].startsWith('Ele está no Top 100'), 'motivo sem o marcador');
  // sem permuta e com só um matriz, ainda assim entrega 3
  assert.equal(escolherTres(doReal).length, 3);

  // vazio e lixo não explodem
  assert.deepEqual(lerNomes(''), []);
  assert.deepEqual(lerNomes(null), []);
  assert.deepEqual(lerNomes('texto qualquer sem estrutura'), []);
});

// Permuta/matriz é bastidor comercial: revela quem a PSA não paga cachê e como a
// base é organizada. Duas defesas — o campo `categoria` some, e as palavras somem
// do texto, porque a automação pode escrevê-las dentro de uma justificativa.
t('permuta e matriz nunca chegam ao cliente — nem como campo, nem como palavra', () => {
  const r = paraCliente({
    leitura: 'x',
    indicacoes: [{ nome: 'Fulano', categoria: 'permuta', perfil: 'p', porque: ['a'], atencao: 'b', aderencia: 'alta' }],
  });
  const bruto = JSON.stringify(r);
  assert.ok(!bruto.includes('permuta'), 'o campo categoria tem de sumir');
  assert.ok(!bruto.includes('categoria'));
  assert.ok(bruto.includes('Fulano'), 'o nome continua visível');

  // o texto vindo da automação também é lavado
  const lidos = lerNomes(JSON.stringify([{
    nome: 'Beltrano', categoria: 'permuta',
    perfil: 'Palestrante de permuta do casting próprio',
    porque: ['Indicado por permuta, sem custo de cachê', 'Está na matriz de liderança'],
    atencao: 'Nome de permuta: confirmar disponibilidade',
  }]));
  const texto = JSON.stringify(lidos.map(({ categoria, ...v }) => v));
  for (const palavra of ['permuta', 'Permuta', 'matriz', 'casting']) {
    assert.ok(!texto.includes(palavra), `"${palavra}" sobreviveu no texto: ${texto}`);
  }
  assert.equal(lidos[0].categoria, 'permuta', 'internamente a categoria continua, é ela que aplica a cota');
  assert.ok(lidos[0].nome === 'Beltrano', 'o nome não pode ser alterado pela limpeza');
});

// Refazer só faz sentido se os recusados não voltarem. O filtro roda antes da cota,
// e menos de 3 inéditos significa "ainda não pronto" — a página espera a automação.
t('nomes descartados não voltam numa refação', () => {
  const lista = [
    { nome: 'Ana', categoria: 'permuta' }, { nome: 'Bruno', categoria: 'matriz' },
    { nome: 'Carla', categoria: 'matriz' }, { nome: 'Diego', categoria: 'melhores' },
    { nome: 'Elisa', categoria: 'melhores' },
  ];
  const mostrados = escolherTres(lista).map(n => n.nome);
  assert.deepEqual(mostrados, ['Ana', 'Bruno', 'Diego']);

  // segunda rodada com a MESMA lista: sobram 2 inéditos, insuficiente
  const descartados = new Set(mostrados.map(n => n.toLowerCase()));
  const sobra = lista.filter(n => !descartados.has(n.nome.toLowerCase()));
  assert.equal(sobra.length, 2, 'os 2 restantes não formam um trio');

  // com nomes novos publicados pela automação, o trio sai sem repetir
  const rodadaNova = [...sobra,
    { nome: 'Fábio', categoria: 'permuta' }, { nome: 'Gina', categoria: 'matriz' }, { nome: 'Hugo', categoria: 'melhores' }];
  const segundos = escolherTres(rodadaNova.filter(n => !descartados.has(n.nome.toLowerCase())));
  assert.equal(segundos.length, 3);
  assert.ok(segundos.every(n => !mostrados.includes(n.nome)), 'nenhum recusado voltou');
});

// O cliente vê faixa, nunca o cachê exato — o valor fechado é a posição de
// negociação da PSA. A extração roda ANTES da limpeza, senão o próprio filtro
// de cifras apagaria o número e a faixa nunca sairia.
t('cachê vira faixa e o valor exato não sobrevive no texto', () => {
  assert.equal(valorEmReais('cachê de R$ 8.500'), 8500);
  assert.equal(valorEmReais('R$ 8.500,00 fechado'), 8500);
  assert.equal(valorEmReais('R$ 12 mil'), 12000);
  assert.equal(valorEmReais('R$ 1,2 milhão'), 1200000);
  assert.equal(valorEmReais('sem valor aqui'), null);

  assert.equal(faixaDeValor(4200), 'até R$ 5 mil');
  assert.equal(faixaDeValor(8500), 'entre R$ 5 e 10 mil');
  assert.equal(faixaDeValor(20000), 'entre R$ 10 e 20 mil');
  assert.equal(faixaDeValor(120000), 'acima de R$ 100 mil');
  assert.equal(faixaDeValor(0), null);
  assert.equal(faixaDeValor(null), null);

  const lidos = lerNomes(JSON.stringify([
    { nome: 'Fulano', categoria: 'matriz', valor: 'R$ 8.500', porque: ['Cachê de R$ 8.500 dentro do previsto'] },
  ]));
  assert.equal(lidos[0].faixa, 'entre R$ 5 e 10 mil', 'a faixa tem de ser calculada');
  const texto = JSON.stringify(lidos[0].porque);
  assert.ok(!texto.includes('8.500'), `valor exato sobreviveu: ${texto}`);
  // a faixa entra no lugar da cifra, então "R$ 5 e 10 mil" no texto é esperado —
  // o que não pode voltar é o número fechado
  assert.ok(!texto.includes('valor sob proposta'), 'com faixa disponível, o texto usa a faixa');

  // motivo que só falava de preço some: o card já mostra a faixa
  const soPreco = lerNomes(JSON.stringify([
    { nome: 'Beltrano', categoria: 'matriz', porque: ['Valor do cachê: R$ 4.200', 'Histórico forte em convenções corporativas'] },
  ]));
  assert.deepEqual(soPreco[0].porque, ['Histórico forte em convenções corporativas']);
  assert.equal(soPreco[0].faixa, 'até R$ 5 mil');

  // a faixa é o único dado de valor que chega ao cliente
  const cliente = JSON.stringify(paraCliente({ leitura: 'x', indicacoes: lidos }));
  assert.ok(cliente.includes('entre R$ 5 e 10 mil'), 'a faixa tem de chegar');
  assert.ok(!cliente.includes('8.500'), 'o valor exato não pode chegar');
});

t('CORS libera só domínio da PSA — e não cai em domínio sósia', () => {
  const testar = origem => {
    const cabecalhos = {};
    cors({ headers: { origin: origem }, method: 'GET' }, { setHeader: (k, v) => (cabecalhos[k] = v), status: () => ({ end() {} }) });
    return !!cabecalhos['Access-Control-Allow-Origin'];
  };
  for (const o of ['https://profissionaissa.com.br', 'https://www.profissionaissa.com.br', 'https://psapalestras.com.br', 'https://49656171.hs-sites.com']) {
    assert.equal(testar(o), true, `deveria liberar ${o}`);
  }
  for (const o of ['https://evil.com', 'https://profissionaissa.com.br.evil.com', 'http://profissionaissa.com.br', '']) {
    assert.equal(testar(o), false, `NÃO deveria liberar ${o}`);
  }
});

t('telefone sai em E.164 ou vazio — nunca num formato que o HubSpot rejeita', () => {
  assert.equal(telefoneE164('(11) 99999-9999'), '+5511999999999');
  assert.equal(telefoneE164('11999999999'), '+5511999999999');
  assert.equal(telefoneE164('+55 11 99999-9999'), '+5511999999999');
  assert.equal(telefoneE164('1133334444'), '+551133334444');
  assert.equal(telefoneE164('99999999'), '', 'sem DDD não dá para inferir');
  assert.equal(telefoneE164(''), '');
  for (const entrada of ['abc', '(11) 9', '55', null, undefined]) {
    const r = telefoneE164(entrada);
    assert.ok(r === '' || /^\+\d{9,}$/.test(r), `formato inválido para ${entrada}: ${r}`);
  }
});

t('limpeza de marcador não come o número que abre o motivo', () => {
  const limpa = m => m.replace(/^\s*(?:[-–·•*]+|\d+[.)])\s+/, '').trim();
  assert.equal(limpa('283 contratações e 35 fechadas'), '283 contratações e 35 fechadas');
  assert.equal(limpa('R$ 8.715 de ticket médio'), 'R$ 8.715 de ticket médio');
  assert.equal(limpa('- motivo com traço'), 'motivo com traço');
  assert.equal(limpa('1. motivo numerado'), 'motivo numerado');
  assert.equal(limpa('2) outro numerado'), 'outro numerado');
});

// embed.js é gerado: se ferramenta.html mudou e ninguém rodou o build, o HubSpot
// continua servindo a versão velha. Essa checagem falha antes do deploy.
t('embeds estão em sincronia com ferramenta.html e index.html', () => {
  const antes = ['embed.js', 'embed-lp.js'].map(f => fs.readFileSync(f, 'utf8'));
  execFileSync(process.execPath, ['scripts/build-embed.mjs'], { stdio: 'pipe' });
  ['embed.js', 'embed-lp.js'].forEach((f, i) => {
    assert.equal(fs.readFileSync(f, 'utf8'), antes[i], `${f} desatualizado — rode: npm run embed`);
  });
});

// A tentativa de página única quebrou o rodapé: o CSS da LP é escopado na raiz dela,
// então mover só o <footer> para outra raiz o deixava sem estilo nenhum.
t('markup e escopo do CSS moram na mesma raiz — o rodapé não sai da LP', () => {
  const lp = fs.readFileSync('embed-lp.js', 'utf8');
  assert.ok(lp.includes('<footer'), 'o rodapé tem de ficar dentro da LP');
  assert.ok(lp.includes('#psa-auto-curadoria-lp .footer{'), 'CSS do rodapé tem de estar no escopo da LP');
  assert.ok(!lp.includes('psa-auto-curadoria-rodape'), 'não montar o rodapé fora da raiz da LP');
});

t('LP e ferramenta são páginas separadas e se linkam', () => {
  const lp = fs.readFileSync('embed-lp.js', 'utf8');
  const fer = fs.readFileSync('embed.js', 'utf8');
  assert.ok(lp.includes('/auto-curadoria-briefing'), 'CTAs da LP levam para a ferramenta');
  assert.ok(!lp.includes('href=\\"/ferramenta\\"'), 'não sobrou link para a rota antiga');
  assert.ok(fer.includes('<header>'), 'a ferramenta é página própria: precisa do header dela');
  assert.ok(fer.includes('/auto-curadoria'), 'logo e voltar da ferramenta apontam para a LP');
  assert.ok(!fer.includes('href=\\"/\\"'), 'a raiz do domínio de landing pages é 404');
});

console.log(`\n${ok} checagens passaram.`);

// O nome que a curadoria mostra vem do slug do dropdown, que perdeu o acento
// ("Giovane Gavio"), enquanto o produto no HubSpot tem acento ("Giovane Gávio").
// Se esta chave parar de achatar acento, nenhum item de linha desses nomes é criado
// e o time recebe "vincular à mão" na maioria dos pedidos.
t('chaveDeNome casa acento perdido no slug com o produto acentuado', () => {
  assert.equal(chaveDeNome('Giovane Gavio'), chaveDeNome('Giovane Gávio'));
  assert.equal(chaveDeNome('Joao Kepler'), chaveDeNome('João Kepler'));
  assert.equal(chaveDeNome('TANIA GENGO'), chaveDeNome('Tânia Gengo'));
  assert.equal(chaveDeNome('Maria  De Souza-Lima'), 'maria de souza lima');
  // e não pode achatar demais: nome parecido continua sendo outra pessoa
  assert.notEqual(chaveDeNome('Carlos Silva'), chaveDeNome('Carlos Silveira'));
});
