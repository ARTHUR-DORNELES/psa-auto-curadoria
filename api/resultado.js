import { redis, chave, teaser, paraCliente, curadoriaDoNegocio, lerNomes, escolherTres, PROP_NOMES, nota, lerCorpo, cors, CHECKOUT_URL, criarItensDeLinha, dispararDisponibilidade, consumirCredito } from './_lib.js';

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
      const cinco = lerNomes(curadoria.nomesBruto).filter(n => !descartados.has(n.nome.toLowerCase()));
      if (cinco.length < 3) return res.status(200).json({ id, pronto: false, linkCuradoria: curadoria.link || undefined });

      // 1 permuta + 1 matriz + 1 melhores; sem permuta, 2 matriz + 1 melhores
      const escolhidos = escolherTres(cinco);
      reg.linkCuradoria = curadoria.link;
      reg.resultado = {
        leitura: 'Estes são os nomes com maior aderência ao briefing que você preencheu.',
        // `categoria` (permuta!) é comercial interno: paraCliente() a remove
        indicacoes: escolhidos.map((n, i) => ({
          ...n,
          aderencia: n.aderencia || (i === 2 ? 'alternativa estratégica' : 'alta'),
        })),
      };
      if (!CHECKOUT_URL) reg.pago = true;   // sem checkout, entrega direto
      // consome o crédito: move o negócio "Pago" -> "Utilizado" na PRIMEIRA geração.
      // Guardado em reg.creditoConsumido para não reconsumir numa refação (a mesma
      // compra cobre 1 briefing + 1 refação).
      if (reg.creditoDealId && !reg.creditoConsumido) {
        reg.creditoConsumido = await consumirCredito(reg.creditoDealId);
      }
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
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
      reg.pago = false;
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);

      if (reg.hubspot?.negocioId) {
        try {
          await nota(reg.hubspot.negocioId, [
            `CLIENTE PEDIU NOVA CURADORIA (refação ${reg.refacoes} de ${MAX_REFACOES}).`,
            '',
            'Nomes já apresentados e recusados — NÃO repetir:',
            ...reg.descartados.map(n => `- ${n}`),
            '',
            `Gerar novas indicações para o mesmo briefing e regravar a propriedade ${PROP_NOMES}.`,
            `Curadoria: ${id}`,
          ].join('\n'));
        } catch (e) {
          console.error('nota de refação falhou:', e.message);
        }
      }
      return res.status(200).json({ ok: true, refacoes: reg.refacoes, restantes: MAX_REFACOES - reg.refacoes });
    }

    // Pedido em lote e único: o cliente marca quais dos 3 quer e confirma uma vez. Vale
    // por disponibilidade E orçamento juntos — são a mesma decisão para quem está do
    // outro lado, e separar em dois botões só fazia o cliente pedir metade.
    // Cria um item de linha por selecionado no negócio, o que faz os nomes aparecerem na
    // consulta de palestrantes para o time disparar a pesquisa.
    //
    // Uma vez só por curadoria, de propósito: um segundo envio duplicaria item de linha
    // no negócio, e item de linha duplicado dobra o valor do negócio e faz o time
    // pesquisar o mesmo palestrante duas vezes. Reenvio devolve o que já foi pedido.
    if (acao === 'disponibilidade') {
      if (!reg.pago) return res.status(402).json({ erro: 'disponível após a liberação da curadoria' });
      if (reg.disponibilidade) {
        return res.status(200).json({ ok: true, jaEnviado: true, ...reg.disponibilidade });
      }

      const escolhidos = [...new Set((Array.isArray(palestrantes) ? palestrantes : [])
        .map(n => String(n || '').trim()).filter(Boolean))];
      if (!escolhidos.length) return res.status(400).json({ erro: 'selecione ao menos um palestrante' });

      // só nomes que esta curadoria realmente indicou — a lista vem do cliente.
      // Usamos os OBJETOS das indicações (não só o nome) porque é neles que viaja o
      // id_contato que a IA Curadoria gravou (Caminho A) — é o que o disparo precisa.
      const indicacoesEscolhidas = (reg.resultado?.indicacoes || []).filter(i => escolhidos.includes(i.nome));
      const validos = indicacoesEscolhidas.map(i => i.nome);
      if (!validos.length) return res.status(400).json({ erro: 'palestrante fora desta curadoria' });

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

      reg.disponibilidade = { palestrantes: validos, datas: datas || null, em: new Date().toISOString(), ...itens, disparo };
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
