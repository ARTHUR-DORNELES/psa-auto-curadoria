import { redis, chave, teaser, paraCliente, curadoriaDoNegocio, lerNomes, escolherIndicacoes, N_INDICACOES, anexarFotos, PROP_NOMES, nota, notaDoBriefing, lerCorpo, cors, CHECKOUT_URL, criarItensDeLinha, dispararDisponibilidade, consumirCredito, chaveDeNome } from './_lib.js';

const ACOES = {
  curador: 'CLIENTE PEDIU ATENDIMENTO DE CURADOR — assumir o processo pelo caminho tradicional.',
  viabilidade: 'CLIENTE SOLICITOU VIABILIDADE DE DATA.',
  orcamento: 'CLIENTE SOLICITOU ORÇAMENTO.',
};

// Uma refação por curadoria. Cada uma dispara a automação de novo; depois disso,
// o caminho é falar com um curador.
const MAX_REFACOES = Number(process.env.MAX_REFACOES || 1);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const id = String(req.query.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ erro: 'id inválido' });

  const bruto = await redis().get(chave(id));
  if (!bruto) return res.status(404).json({ erro: 'curadoria não encontrada ou expirada' });
  const reg = JSON.parse(bruto);

  if (req.method === 'GET') {
    // A curadoria vem da automação da PSA: enquanto ela não escrever
    // `ia_curadoria_link` no negócio, a resposta é "ainda processando".
    if (!reg.resultado) {
      if (!reg.hubspot?.negocioId) return res.status(200).json({ id, pronto: false, erro: 'briefing sem negócio associado' });

      let curadoria = { link: null, nomesBruto: null };
      try { curadoria = await curadoriaDoNegocio(reg.hubspot.negocioId); }
      catch (e) { console.error('leitura da curadoria no negócio falhou:', e.message); }

      // Nomes já mostrados e recusados não voltam. Enquanto sobrarem menos de 3
      // inéditos, a curadoria segue "não pronta" — é assim que uma refação espera
      // a automação publicar nomes novos em vez de repetir a lista anterior.
      const descartados = new Set((reg.descartados || []).map(n => n.toLowerCase()));
      const nomes = lerNomes(curadoria.nomesBruto).filter(n => !descartados.has(n.nome.toLowerCase()));

      // Esperamos N_INDICACOES nomes. Mas a automação às vezes devolve menos (típico na
      // refação: os nomes já mostrados saem do bolo e sobra pouco inédito). Para o cliente
      // NÃO ficar preso em "sendo montada" pra sempre: exigimos N até estourar o tempo; daí
      // entregamos o que veio (>=1) marcado como incompleto — um curador completa depois.
      const TIMEOUT_MIN = Number(process.env.CURADORIA_TIMEOUT_MIN || 8);
      const clock = reg.refeitoEm || reg.criadoEm;
      const idadeMin = clock ? (Date.now() - Date.parse(clock)) / 60000 : 0;
      const estourou = idadeMin >= TIMEOUT_MIN;

      // dentro do tempo e sem os N: segue esperando a automação publicar mais nomes
      if (nomes.length < N_INDICACOES && !estourou) {
        return res.status(200).json({ id, pronto: false, linkCuradoria: curadoria.link || undefined });
      }
      // estourou o tempo e não veio NENHUM nome: handoff pro curador (não fabrica resultado)
      if (nomes.length === 0) {
        return res.status(200).json({ id, pronto: false, timeout: true, linkCuradoria: curadoria.link || undefined });
      }

      // até N nomes, com a mistura mínima por categoria. Menos de N só após o timeout.
      const escolhidos = escolherIndicacoes(nomes);
      await anexarFotos(escolhidos);   // foto de cada palestrante (ou nada -> silhueta no front)
      const incompleto = escolhidos.length < N_INDICACOES;
      reg.linkCuradoria = curadoria.link;
      reg.resultado = {
        leitura: incompleto
          ? 'Adiantamos os nomes com maior aderência ao seu briefing. Um curador vai completar sua indicação em seguida.'
          : 'Estes são os nomes com maior aderência ao briefing que você preencheu.',
        incompleto,
        // `categoria` (permuta!) é comercial interno: paraCliente() a remove
        indicacoes: escolhidos.map(n => ({ ...n, aderencia: n.aderencia || 'alta' })),
      };
      reg.fotosBuscadas = true;   // já rodou o anexarFotos acima
      if (!CHECKOUT_URL) reg.pago = true;   // sem checkout, entrega direto
      // consome o crédito: move o negócio "Pago" -> "Utilizado" na PRIMEIRA geração.
      // Guardado em reg.creditoConsumido para não reconsumir numa refação (a mesma
      // compra cobre 1 briefing + 1 refação).
      if (reg.creditoDealId && !reg.creditoConsumido) {
        reg.creditoConsumido = await consumirCredito(reg.creditoDealId);
      }
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
    }

    // enriquecimento tardio: resultado gerado antes das fotos existirem -> busca uma vez.
    if (reg.resultado && !reg.fotosBuscadas) {
      try { await anexarFotos(reg.resultado.indicacoes || []); } catch (e) { console.error('anexarFotos tardio falhou:', e.message); }
      reg.fotosBuscadas = true;
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
    }

    // enriquecimento tardio do valor de venda: resultados gerados antes de o parser
    // capturar a linha "Valor de venda:" ficaram sem o campo. Relê o texto do negócio
    // e preenche por nome — sem refazer a curadoria (mantém os mesmos nomes).
    if (reg.resultado && !reg.valorVendaBackfill) {
      const faltando = (reg.resultado.indicacoes || []).some(i => !i.valorVenda);
      if (!faltando) {
        reg.valorVendaBackfill = true;
        await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
      } else if (reg.hubspot?.negocioId) {
        try {
          const { nomesBruto } = await curadoriaDoNegocio(reg.hubspot.negocioId);
          const porNome = new Map(
            lerNomes(nomesBruto).map(n => [chaveDeNome(n.nome), n.valorVenda]).filter(([, v]) => v)
          );
          for (const ind of reg.resultado.indicacoes) {
            if (!ind.valorVenda) {
              const vv = porNome.get(chaveDeNome(ind.nome));
              if (vv) ind.valorVenda = vv;
            }
          }
          reg.valorVendaBackfill = true;   // leitura ok: não repete (só resta o que a automação não gravou)
          await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
        } catch (e) { console.error('backfill valorVenda falhou:', e.message); }  // sem flag -> tenta de novo
      }
    }

    return res.status(200).json(
      reg.pago
        // `disponibilidade` vai para o cliente porque quem recarrega o link precisa ver
        // que já pediu; sem isso a tela volta destravada e o pedido parece não ter saído
        ? { id, pronto: true, pago: true, criadoEm: reg.criadoEm, briefing: reg.briefing, resultado: paraCliente(reg.resultado), refacoesRestantes: MAX_REFACOES - (reg.refacoes || 0), disponibilidade: reg.disponibilidade ? { palestrantes: reg.disponibilidade.palestrantes, em: reg.disponibilidade.em } : null }
        : { id, pronto: true, pago: false, teaser: teaser(reg.resultado) }
    );
  }

  if (req.method === 'POST') {
    const { acao, palestrante, palestrantes, datas, mensagem } = await lerCorpo(req);

    // Refazer: os 3 atuais saem de cena e a automação é acionada de novo pela
    // observação. Os nomes recusados ficam registrados para não voltarem.
    if (acao === 'refazer') {
      if (!reg.resultado) return res.status(409).json({ erro: 'ainda não há curadoria para refazer' });
      const feitas = reg.refacoes || 0;
      if (feitas >= MAX_REFACOES) {
        return res.status(429).json({ erro: 'limite de refações atingido', limite: MAX_REFACOES });
      }

      const recusados = reg.resultado.indicacoes.map(i => i.nome);
      reg.descartados = [...new Set([...(reg.descartados || []), ...recusados])];
      reg.refacoes = feitas + 1;
      delete reg.resultado;
      reg.refeitoEm = new Date().toISOString();   // reinicia o relógio do timeout p/ esta refação
      // NÃO zera reg.pago: no modelo de compra, quem passou pelo gate segue liberado a
      // sessão inteira — a refação é coberta pela MESMA compra (não reconsome o crédito).
      // Zerar aqui mostraria o teaser em vez do resultado da refação.
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);

      if (reg.hubspot?.negocioId) {
        try {
          // A automação da IA Curadoria enrola o negócio ao ver uma observação NOVA e lê
          // o briefing dela. Por isso a refação re-emite a MESMA nota de briefing da geração
          // inicial (o gatilho que funciona) e acrescenta os nomes que ela NÃO pode repetir —
          // assim a automação regenera o mesmo briefing com indicações diferentes.
          await nota(reg.hubspot.negocioId, [
            notaDoBriefing(reg.briefing || {}, null, id),
            '',
            `— REFAÇÃO ${reg.refacoes} de ${MAX_REFACOES} —`,
            'Gere nomes DIFERENTES para o mesmo briefing. NÃO repita os palestrantes já apresentados:',
            ...reg.descartados.map(n => `- ${n}`),
            '',
            `Regravar a propriedade ${PROP_NOMES} com as novas indicações. Curadoria: ${id}`,
          ].join('\n'));
        } catch (e) {
          console.error('nota de refação falhou:', e.message);
        }
      }
      return res.status(200).json({ ok: true, refacoes: reg.refacoes, restantes: MAX_REFACOES - reg.refacoes });
    }

    // Disponibilidade + orçamento: um botão POR nome. Vale pelos dois juntos (é a mesma
    // decisão pra quem está do outro lado). Cada envio cria um item de linha no negócio,
    // o que faz o nome aparecer na consulta de palestrantes pro time disparar a pesquisa.
    //
    // ACUMULATIVO e idempotente por nome: cada palestrante só é processado UMA vez (um
    // segundo pedido do mesmo nome duplicaria item de linha e re-disparia o WhatsApp).
    // Nomes já pedidos são ignorados; só os inéditos entram.
    if (acao === 'disponibilidade') {
      if (!reg.pago) return res.status(402).json({ erro: 'disponível após a liberação da curadoria' });

      const pedidos = [...new Set((Array.isArray(palestrantes) ? palestrantes : [])
        .map(n => String(n || '').trim()).filter(Boolean))];
      if (!pedidos.length) return res.status(400).json({ erro: 'selecione ao menos um palestrante' });

      const jaFeitos = new Set((reg.disponibilidade?.palestrantes) || []);
      const novos = pedidos.filter(n => !jaFeitos.has(n));

      // só nomes que esta curadoria realmente indicou — a lista vem do cliente.
      // Usamos os OBJETOS das indicações (não só o nome) porque é neles que viaja o
      // id_contato que a IA Curadoria gravou (Caminho A) — é o que o disparo precisa.
      const indicacoesEscolhidas = (reg.resultado?.indicacoes || []).filter(i => novos.includes(i.nome));
      const validos = indicacoesEscolhidas.map(i => i.nome);
      if (!validos.length) {
        // nada novo (nome já pedido, ou fora da curadoria): devolve o estado atual
        return res.status(200).json({ ok: true, jaEnviado: true, palestrantes: [...jaFeitos] });
      }

      let itens = { vinculados: [], semProduto: validos };
      let disparo = { disparados: [], semContato: [], semTelefone: [], jaDisparado: [], falhas: [] };
      if (reg.hubspot?.negocioId) {
        itens = await criarItensDeLinha(reg.hubspot.negocioId, validos);
        // dispara a pesquisa de disponibilidade (WhatsApp) reaproveitando o pipeline do
        // palestrantes-app: staging pesq_* + pesq_disparar=true no contato de cada
        // palestrante; o workflow do HubSpot envia e cria o tíquete. Nunca derruba o pedido.
        try {
          disparo = await dispararDisponibilidade(reg.hubspot.negocioId, indicacoesEscolhidas, reg.briefing || {}, datas);
        } catch (e) {
          console.error('disparo de disponibilidade falhou:', e.message);
        }
      }

      reg.disponibilidade = {
        palestrantes: [...jaFeitos, ...validos],   // acumula todos os já pedidos
        datas: datas || reg.disponibilidade?.datas || null,
        em: new Date().toISOString(),
        ...itens, disparo,
      };
      reg.acoes.push({ acao, palestrantes: validos, datas, em: reg.disponibilidade.em });
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);

      if (reg.hubspot?.negocioId) {
        try {
          await nota(reg.hubspot.negocioId, [
            'AUTO CURADORIA — CLIENTE SOLICITOU DISPONIBILIDADE DE DATA E ORÇAMENTO.',
            `Palestrantes escolhidos: ${validos.join(', ')}`,
            datas ? `Datas: ${datas}` : '',
            itens.vinculados.length ? `Itens de linha criados: ${itens.vinculados.join(', ')}` : '',
            // sem produto resolvido o nome não entra na consulta de palestrantes;
            // se ficar só no log, ninguém checa a disponibilidade desse nome
            itens.semProduto.length
              ? `ATENÇÃO — sem produto correspondente, vincular à mão: ${itens.semProduto.join(', ')}`
              : '',
            disparo.disparados.length ? `WhatsApp de disponibilidade disparado para: ${disparo.disparados.join(', ')}` : '',
            disparo.jaDisparado.length ? `Já havia disparo com a mesma data/local (não repetido): ${disparo.jaDisparado.join(', ')}` : '',
            disparo.semContato.length ? `ATENÇÃO — sem id_contato, WhatsApp NÃO disparado (verificar): ${disparo.semContato.join(', ')}` : '',
            disparo.semTelefone.length ? `ATENÇÃO — contato sem telefone, WhatsApp NÃO disparado: ${disparo.semTelefone.join(', ')}` : '',
            disparo.falhas.length ? `ATENÇÃO — falha ao disparar WhatsApp: ${disparo.falhas.join(', ')}` : '',
            `Prazo combinado com o cliente: até 24h.`,
            `Curadoria: ${id}`,
          ].filter(Boolean).join('\n'));
        } catch (e) {
          console.error('nota de disponibilidade falhou:', e.message);
        }
      }
      return res.status(200).json({ ok: true, ...itens });
    }

    if (!ACOES[acao]) return res.status(400).json({ erro: 'ação desconhecida' });
    // viabilidade e orçamento são entregas do produto pago; falar com curador é sempre livre
    if (acao !== 'curador' && !reg.pago) return res.status(402).json({ erro: 'disponível após a liberação da curadoria' });

    reg.acoes.push({ acao, palestrante, datas, mensagem, em: new Date().toISOString() });
    await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);

    if (reg.hubspot?.negocioId) {
      try {
        await nota(reg.hubspot.negocioId, [
          ACOES[acao],
          palestrante ? `Palestrante: ${palestrante}` : '',
          datas ? `Datas: ${datas}` : '',
          mensagem ? `Mensagem: ${mensagem}` : '',
          `Curadoria: ${id}`,
        ].filter(Boolean).join('\n'));
      } catch (e) {
        console.error('nota no HubSpot falhou:', e.message);
      }
    }
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ erro: 'método não suportado' });
}
