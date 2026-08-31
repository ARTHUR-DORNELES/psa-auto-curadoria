import crypto from 'node:crypto';
import { criarNegocioCuradoria, redis, chave, chaveDeal, lerCorpo, cors, assinaturaAtivaPorDocumento, normalizaDocumento } from './_lib.js';

// A ferramenta NÃO gera mais os nomes. Ela grava o briefing no negócio e a
// automação da PSA (disparada pela observação) produz o arquivo da IA Curadoria
// e escreve o link em `ia_curadoria_link`. Quem lê e escolhe os 3 é /api/resultado.
// Tudo obrigatório menos os descritivos (microTema, que 7 macro temas não têm,
// e o contexto livre) e a DATA (pode ser "a definir"; só vira obrigatória ao solicitar
// disponibilidade). Espelha a validação do formulário — o servidor não confia nela.
const OBRIGATORIOS = ['nome', 'empresa', 'email', 'telefone', 'macroTema', 'publicoAlvo',
  'formato', 'horario', 'duracao', 'localEvento', 'cidade', 'local', 'orcamento', 'vendaIngresso',
  'motivacao', 'sentimento'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  try {
    const b = await lerCorpo(req);

    const faltando = OBRIGATORIOS.filter(c => !String(b[c] || '').trim());
    if (faltando.length) return res.status(400).json({ erro: `campos obrigatórios: ${faltando.join(', ')}` });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(b.email)) return res.status(400).json({ erro: 'e-mail inválido' });

    // Paywall: só libera quem tem um negócio "Pago" na pipeline Auto Curadoria, casado
    // pelo CPF/CNPJ. A validação é feita de novo aqui (não confia só no gate do front).
    const doc = normalizaDocumento(b.documento);
    if (!doc) return res.status(400).json({ erro: 'Informe um CPF ou CNPJ válido para liberar sua curadoria.' });
    // Assinatura ativa (1 ano a partir da data de pagamento) libera curadorias ilimitadas.
    let assinatura;
    try {
      assinatura = await assinaturaAtivaPorDocumento(b.documento);
    } catch (e) {
      console.error('VALIDACAO_ACESSO_FALHOU', e.message);
      return res.status(502).json({ erro: 'não conseguimos validar seu acesso agora. Tente de novo em instantes.' });
    }
    if (!assinatura) return res.status(402).json({ erro: 'Não encontramos uma assinatura para este CPF/CNPJ.' });
    if (!assinatura.ativa) return res.status(402).json({ erro: 'Sua assinatura expirou. Renove para montar novas curadorias.' });

    const briefing = {
      nome: b.nome, empresa: b.empresa, email: b.email.toLowerCase().trim(), telefone: b.telefone,
      macroTema: b.macroTema, microTema: b.microTema || '',
      publicoAlvo: b.publicoAlvo, formato: b.formato,
      data: b.data, horario: b.horario, duracao: b.duracao,
      localEvento: b.localEvento, cidade: b.cidade, local: b.local,
      orcamento: b.orcamento, vendaIngresso: b.vendaIngresso,
      motivacao: b.motivacao, sentimento: b.sentimento,
      briefing: String(b.briefing || '').slice(0, 4000),
      utm: b.utm || {},
    };

    const id = crypto.randomUUID();

    // Assinatura ilimitada: CADA curadoria cria um negócio NOVO na pipeline Auto Curadoria
    // (etapa "Curadorias criadas"), associado ao contato assinante. É nesse negócio que o
    // briefing e a automação rodam. Falha aqui é fatal: sem o negócio, não há curadoria.
    let hubspot;
    try {
      hubspot = await criarNegocioCuradoria(assinatura.contatoId, briefing, id);
    } catch (e) {
      console.error('HUBSPOT_FALHOU', id, e.message);
      return res.status(502).json({
        erro: 'não conseguimos registrar seu briefing agora. Tente de novo em instantes.',
        detalhe: e.message.slice(0, 400),
      });
    }

    await redis().set(chave(id), JSON.stringify({
      id, criadoEm: new Date().toISOString(), briefing, hubspot, pago: true, acoes: [],
      // documento guardado só como referência; assinaturaDealId = o negócio da assinatura
      // (acesso), separado do negócio desta curadoria (hubspot.negocioId).
      documento: doc.valor, documentoTipo: doc.tipo,
      assinaturaDealId: assinatura.dealId, contatoId: assinatura.contatoId,
    }), 'EX', 60 * 60 * 24 * 90);
    // vínculo negócio da curadoria -> uuid: o gate reencontra esta curadoria pelo CPF/CNPJ
    // (ver antigas) mesmo que o cliente não tenha guardado o link.
    await redis().set(chaveDeal(hubspot.negocioId), id, 'EX', 60 * 60 * 24 * 90);

    res.status(200).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'falha ao registrar o briefing', detalhe: e.message });
  }
}
