import { redis, chave, teaser, paraCliente, curadoriaDoNegocio, lerNomes, escolherTres, PROP_NOMES, nota, lerCorpo, cors, CHECKOUT_URL } from './_lib.js';

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
      await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);
    }

    return res.status(200).json(
      reg.pago
        ? { id, pronto: true, pago: true, criadoEm: reg.criadoEm, briefing: reg.briefing, resultado: paraCliente(reg.resultado), refacoesRestantes: MAX_REFACOES - (reg.refacoes || 0) }
        : { id, pronto: true, pago: false, teaser: teaser(reg.resultado) }
    );
  }

  if (req.method === 'POST') {
    const { acao, palestrante, datas, mensagem } = await lerCorpo(req);

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
