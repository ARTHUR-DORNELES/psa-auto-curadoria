import { redis, chave, chaveProjeto, teaser, paraCliente, curadoriaDoNegocio, lerNomes, escolherIndicacoes, N_INDICACOES, anexarFotos, PROP_NOMES, nota, notaDoBriefing, lerCorpo, cors, CHECKOUT_URL, criarItensDeLinha, dispararDisponibilidade, dispararWebhookCuradoria, limparNomesDoNegocio, finalizarCuradoria, chaveDeNome, respostasDisponibilidade, anexarBriefingAoNegocio, registrarNomesNaoEncontrados } from './_lib.js';

const ACOES = {
  curador: 'CLIENTE PEDIU ATENDIMENTO DE CURADOR — assumir o processo pelo caminho tradicional.',
  viabilidade: 'CLIENTE SOLICITOU VIABILIDADE DE DATA.',
  orcamento: 'CLIENTE SOLICITOU ORÇAMENTO.',
};

// Uma refação por curadoria. Cada uma dispara a automação de novo; depois disso,
// o caminho é falar com um curador.
const MAX_REFACOES = Number(process.env.MAX_REFACOES || 1);
// Na refação o cliente pode MANTER até 3 nomes que gostou; o resto é trocado.
const MAX_MANTER = Number(process.env.MAX_MANTER || 3);

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

      // A automação grava a lista de uma vez só (um PATCH com o texto final). Então a
      // presença de nomes é o sinal de "terminou": qualquer nome publicado JÁ é o resultado
      // final — entregamos na hora, mesmo com menos de N_INDICACOES (marcado como incompleto,
      // um curador completa depois). Esperar chegar aos N só atrasava: quando a automação
      // devolve 4, os 4 já são o fim (ela não vai acrescentar um 5º depois).
      // O tempo de espera vale só enquanto a propriedade está VAZIA (automação ainda rodando
      // ou refação sem nomes inéditos); estourado e ainda vazio -> handoff pro curador.
      // nomes que o cliente MANTEVE numa refação (preservados com foto/justificativa).
      const mantidos = reg.mantidos || [];
      if (nomes.length === 0) {
        const TIMEOUT_MIN = Number(process.env.CURADORIA_TIMEOUT_MIN || 8);
        const clock = reg.refeitoEm || reg.criadoEm;
        const idadeMin = clock ? (Date.now() - Date.parse(clock)) / 60000 : 0;
        const estourou = idadeMin >= TIMEOUT_MIN;
        // ainda sem nomes novos: espera. Exceção: estourou o tempo E o cliente manteve nomes
        // -> entrega ao menos os mantidos (incompleto), sem deixar a tela vazia pra sempre.
        if (!(estourou && mantidos.length)) {
          return res.status(200).json({ id, pronto: false, timeout: estourou || undefined, linkCuradoria: curadoria.link || undefined });
        }
      }

      // lista final = mantidos + novos inéditos, até N (com a mistura mínima entre os novos).
      const jaTem = new Set(mantidos.map(i => String(i.nome || '').toLowerCase()));
      const ineditos = nomes.filter(n => !jaTem.has(n.nome.toLowerCase()));
      const faltam = Math.max(0, N_INDICACOES - mantidos.length);
      // LISTA FECHADA: todos os nomes vêm com categoria "Pedido do cliente"; escolherIndicacoes
      // reduziria a 1 (slice de 'pedido'). Aqui mostramos TODOS os que casaram, sem curar/reduzir.
      const novos = reg.nomesDoCliente
        ? ineditos.slice(0, Math.max(N_INDICACOES, (reg.nomesSolicitados || []).length))
        : escolherIndicacoes(ineditos).slice(0, faltam);
      await anexarFotos(novos);   // mantidos já têm foto/redes da rodada anterior
      const escolhidos = [...mantidos, ...novos];
      const incompleto = !reg.nomesDoCliente && escolhidos.length < N_INDICACOES;
      reg.linkCuradoria = curadoria.link;
      reg.resultado = {
        leitura: incompleto
          ? 'Adiantamos os nomes com maior aderência ao seu briefing. Um curador vai completar sua indicação em seguida.'
          : 'Estes são os nomes com maior aderência ao briefing que você preencheu.',
        incompleto,
        // `categoria` (permuta!) é comercial interno: paraCliente() a remove
        indicacoes: escolhidos.map(n => ({ ...n, aderencia: n.aderencia || 'alta' })),
      };
      // lista fechada (cliente trouxe os nomes): a leitura padrão fala de "briefing preenchido",
      // que aqui não existe — troca por um texto que reflete que os nomes vieram do cliente.
      if (reg.nomesDoCliente) {
        reg.resultado.leitura = 'Estes são os palestrantes que você indicou, já com as informações de cada um. Quando quiser, é só pedir a disponibilidade.';
        reg.resultado.incompleto = false;
      }
      reg.fotosBuscadas = true;   // já rodou o anexarFotos acima
      reg.redesBuscadas = true;   // anexarFotos também traz as redes sociais do verbete
      if (!CHECKOUT_URL) reg.pago = true;   // sem checkout, entrega direto
      // Modelo de assinatura: NÃO consome mais o acesso (curadorias ilimitadas). A finalização
      // do negócio anterior acontece no momento da REFAÇÃO (POST 'refazer'), não aqui.
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
    }

    // enriquecimento tardio: resultado gerado antes das fotos/redes existirem -> busca uma vez.
    // (redesBuscadas cobre curadorias antigas, geradas antes de o anexarFotos trazer redes.)
    if (reg.resultado && (!reg.fotosBuscadas || !reg.redesBuscadas)) {
      try { await anexarFotos(reg.resultado.indicacoes || []); } catch (e) { console.error('anexarFotos tardio falhou:', e.message); }
      reg.fotosBuscadas = true;
      reg.redesBuscadas = true;
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

    if (!reg.pago) {
      return res.status(200).json({ id, pronto: true, pago: false, teaser: teaser(reg.resultado) });
    }

    const cliente = paraCliente(reg.resultado);
    // resposta do palestrante (disponível? + valor) no card — só depois que o cliente
    // pediu disponibilidade e o palestrante respondeu no tíquete (disponibilidade/valor_total).
    // IMPORTANTE: só mostra a resposta de quem o cliente pediu NESTA curadoria. O negócio
    // pode ter respostas de outras demandas do mesmo palestrante gravadas na propriedade;
    // sem esse filtro, elas vazavam pra indicações que o cliente nem chegou a solicitar.
    if (reg.disponibilidade?.palestrantes?.length && reg.hubspot?.negocioId) {
      try {
        const pedidos = new Set(reg.disponibilidade.palestrantes || []);
        const respostas = await respostasDisponibilidade(reg.hubspot.negocioId);
        // casa por id_contato (o mesmo que a IA Curadoria gravou em cada indicação)
        const idPorNome = {};
        for (const i of reg.resultado.indicacoes) idPorNome[i.nome] = String(i.id_contato || '');
        for (const ind of cliente.indicacoes) {
          if (!pedidos.has(ind.nome)) continue;   // só quem o cliente solicitou nesta curadoria
          const r = respostas[idPorNome[ind.nome]];
          if (r) ind.resposta = r;
        }
      } catch (e) { console.error('merge respostas disponibilidade:', e.message); }
    }

    // LISTA FECHADA: quais nomes que o cliente pediu NÃO casaram com a base (não vieram no
    // resultado). Sem isso, nomes digitados errado (ou fora da base) somem sem o cliente saber.
    let naoEncontrados = [];
    if (reg.nomesDoCliente && Array.isArray(reg.nomesSolicitados)) {
      const achou = (cliente.indicacoes || []).map((i) => chaveDeNome(i.nome)).filter(Boolean);
      naoEncontrados = reg.nomesSolicitados.filter((sol) => {
        const k = chaveDeNome(sol);
        if (!k) return false;
        return !achou.some((a) => a === k || a.includes(k) || k.includes(a));
      });
      // salva os não encontrados (demanda: nomes fora da base) uma única vez por curadoria
      if (naoEncontrados.length && !reg.naoEncontradosSalvos) {
        try {
          await registrarNomesNaoEncontrados(reg.hubspot?.negocioId, naoEncontrados, {
            empresa: reg.briefing?.empresaPalestra || reg.briefing?.empresa || '', curadoria: id,
          });
        } catch (e) { console.error('registrar nao-encontrados falhou:', e.message); }
        reg.naoEncontradosSalvos = true;
        await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
      }
    }

    // `disponibilidade` vai para o cliente porque quem recarrega o link precisa ver
    // que já pediu; sem isso a tela volta destravada e o pedido parece não ter saído
    return res.status(200).json({
      id, pronto: true, pago: true, criadoEm: reg.criadoEm, briefing: reg.briefing,
      resultado: cliente,
      refacoesRestantes: MAX_REFACOES - (reg.refacoes || 0),
      disponibilidade: reg.disponibilidade ? { palestrantes: reg.disponibilidade.palestrantes, em: reg.disponibilidade.em } : null,
      // curadoria de "lista fechada" (cliente trouxe os nomes): a disponibilidade exige o
      // briefing completo antes. O front usa isso pra pedir o briefing na hora de solicitar.
      nomesDoCliente: !!reg.nomesDoCliente,
      briefingCompleto: reg.nomesDoCliente ? !!reg.briefingCompleto : true,
      naoEncontrados,
      // projeto (evento com vários palestrantes): abas por macro tema. macroTema = tema desta aba.
      macroTema: reg.macroTema || (reg.briefing && reg.briefing.macroTema) || null,
      projeto: await (async () => {
        if (!reg.projetoId) return null;
        try { const p = JSON.parse(await redis().get(chaveProjeto(reg.projetoId)) || 'null'); return p ? { id: p.id, curadorias: p.curadorias } : null; }
        catch (e) { return null; }
      })(),
    });
  }

  if (req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const { acao, palestrante, palestrantes, datas, mensagem, manter } = corpo;

    // Refazer: os 3 atuais saem de cena e a automação é acionada de novo pela
    // observação. Os nomes recusados ficam registrados para não voltarem.
    if (acao === 'refazer') {
      if (!reg.resultado) return res.status(409).json({ erro: 'ainda não há curadoria para refazer' });
      const feitas = reg.refacoes || 0;
      if (feitas >= MAX_REFACOES) {
        return res.status(429).json({ erro: 'limite de refações atingido', limite: MAX_REFACOES });
      }

      // O cliente pode MANTER até MAX_MANTER nomes que gostou; os demais são trocados.
      const atuais = reg.resultado.indicacoes;
      const querManter = new Set((Array.isArray(manter) ? manter : []).map(n => String(n || '').trim()).filter(Boolean));
      const mantidos = atuais.filter(i => querManter.has(i.nome)).slice(0, MAX_MANTER);
      const nomesMantidos = mantidos.map(i => i.nome);
      const recusados = atuais.filter(i => !nomesMantidos.includes(i.nome)).map(i => i.nome);
      if (!recusados.length) return res.status(400).json({ erro: 'selecione ao menos um nome para trocar' });

      reg.descartados = [...new Set([...(reg.descartados || []), ...recusados])];
      reg.mantidos = mantidos;   // preservados com foto/justificativa/id_contato p/ a lista final
      reg.refacoes = feitas + 1;
      delete reg.resultado;
      reg.refeitoEm = new Date().toISOString();   // reinicia o relógio do timeout p/ esta refação
      // NÃO zera reg.pago: quem passou pelo gate segue liberado a sessão inteira.
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);

      // a automação não pode repetir NEM os recusados NEM os mantidos (senão traria de novo
      // um que o cliente já tem na lista). Exclui os dois conjuntos.
      const excluir = [...new Set([...reg.descartados, ...nomesMantidos])];

      // Refação no MESMO negócio (não cria um segundo): re-emite a nota do briefing +
      // NAO_REPETIR e aciona o webhook do n8n na mão (a 2ª observação não re-dispara o gatilho
      // do HubSpot). O negócio vai para "Curadorias finalizadas", onde fica o resultado da refação.
      const dealId = reg.hubspot?.negocioId;
      if (dealId) {
        try {
          await nota(dealId, [
            notaDoBriefing(reg.briefing || {}, null, id),
            '',
            `— REFAÇÃO ${reg.refacoes} de ${MAX_REFACOES} —`,
            nomesMantidos.length ? `O cliente MANTEVE: ${nomesMantidos.join(', ')} (não repita esses).` : '',
            'Gere nomes DIFERENTES para o mesmo briefing. NÃO repita os palestrantes já apresentados:',
            ...excluir.map(n => `- ${n}`),
            // marcador legível por máquina: o node "Unifica 6" lê os nomes entre colchetes p/ excluir.
            `NAO_REPETIR: [${excluir.join(' | ')}]`,
            '',
            `Regravar a propriedade ${PROP_NOMES} com as novas indicações. Curadoria: ${id}`,
          ].filter(Boolean).join('\n'));
          await limparNomesDoNegocio(dealId);        // zera os nomes antigos (senão um sobra e aparece na hora)
          await dispararWebhookCuradoria(dealId);    // regenera no mesmo negócio (sem depender do gatilho)
          await finalizarCuradoria(dealId);          // negócio -> "Curadorias finalizadas"
        } catch (e) {
          console.error('nota/disparo de refação falhou:', e.message);
        }
      }
      return res.status(200).json({ ok: true, refacoes: reg.refacoes, restantes: MAX_REFACOES - reg.refacoes, mantidos: nomesMantidos });
    }

    // Disponibilidade + orçamento: um botão POR nome. Vale pelos dois juntos (é a mesma
    // decisão pra quem está do outro lado). Cada envio cria um item de linha no negócio,
    // o que faz o nome aparecer na consulta de palestrantes pro time disparar a pesquisa.
    //
    // ACUMULATIVO e idempotente por nome: cada palestrante só é processado UMA vez (um
    // segundo pedido do mesmo nome duplicaria item de linha e re-disparia o WhatsApp).
    // Nomes já pedidos são ignorados; só os inéditos entram.
    // Curadoria de LISTA FECHADA: salva o briefing completo do evento no negócio (o cliente
    // preenche na hora de pedir disponibilidade). NÃO re-dispara a IA (a reinscrição do
    // gatilho é única) — só atualiza o negócio p/ a pesquisa de disponibilidade ter os dados.
    if (acao === 'briefing') {
      if (!reg.hubspot?.negocioId) return res.status(409).json({ erro: 'curadoria sem negócio associado' });
      const c = corpo;
      const campos = ['nome', 'empresa', 'email', 'telefone', 'macroTema', 'macroTemaSecundario', 'microTema', 'publicoAlvo',
        'formato', 'data', 'horario', 'duracao', 'localEvento', 'cidade', 'local',
        'orcamento', 'vendaIngresso', 'motivacao', 'sentimento', 'palestranteDesejado', 'empresaPalestra', 'briefing'];
      const bf = { ...(reg.briefing || {}) };
      for (const k of campos) if (c[k] !== undefined && String(c[k]).trim() !== '') bf[k] = String(c[k]).trim();
      reg.briefing = bf;
      reg.briefingCompleto = true;
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
      try { await anexarBriefingAoNegocio(reg.hubspot.negocioId, bf, id); }
      catch (e) { console.error('anexar briefing (lista fechada) falhou:', e.message); }
      return res.status(200).json({ ok: true, briefingCompleto: true });
    }

    if (acao === 'disponibilidade') {
      if (!reg.pago) return res.status(402).json({ erro: 'disponível após a liberação da curadoria' });
      // lista fechada: sem briefing completo, não dispara (a pesquisa iria sem dados do evento).
      if (reg.nomesDoCliente && !reg.briefingCompleto) {
        return res.status(428).json({ erro: 'Para pedir disponibilidade, precisamos do briefing completo do evento.', precisaBriefing: true });
      }

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
