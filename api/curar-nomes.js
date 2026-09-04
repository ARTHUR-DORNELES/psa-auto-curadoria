import crypto from 'node:crypto';
import { criarNegocioCuradoria, redis, chave, chaveDeal, lerCorpo, cors, assinaturaAtivaPorDocumento, normalizaDocumento } from './_lib.js';

// Caminho "JÁ TENHO OS NOMES": o cliente informa até 8 palestrantes que já quer.
// A IA Curadoria roda igual, mas TRAVADA na lista fechada (marcador LISTA_FECHADA na
// observação) — ela resolve id_contato, foto, valor e justificativa de cada nome, sem
// indicar mais ninguém. O briefing completo só é exigido depois, se pedir disponibilidade.
const MAX_NOMES = 8;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  try {
    const b = await lerCorpo(req);

    const nomes = [...new Set((Array.isArray(b.nomes) ? b.nomes : [])
      .map((n) => String(n || '').replace(/\s+/g, ' ').trim())
      .filter((n) => n.length >= 3))].slice(0, MAX_NOMES);
    if (!nomes.length) return res.status(400).json({ erro: 'Informe ao menos um palestrante (nome e sobrenome).' });

    const doc = normalizaDocumento(b.documento);
    if (!doc) return res.status(400).json({ erro: 'Informe um CPF ou CNPJ válido para liberar sua curadoria.' });

    let assinatura;
    try {
      assinatura = await assinaturaAtivaPorDocumento(b.documento);
    } catch (e) {
      console.error('VALIDACAO_ACESSO_FALHOU', e.message);
      return res.status(502).json({ erro: 'não conseguimos validar seu acesso agora. Tente de novo em instantes.' });
    }
    if (!assinatura) return res.status(402).json({ erro: 'Não encontramos uma assinatura para este CPF/CNPJ.' });
    if (!assinatura.ativa) return res.status(402).json({ erro: 'Sua assinatura expirou. Renove para montar novas curadorias.' });

    // briefing mínimo: só a identidade (o resto do briefing vem depois, se pedir disponibilidade).
    const briefing = {
      nome: b.nome || '', empresa: b.empresa || '', email: String(b.email || '').toLowerCase().trim(), telefone: b.telefone || '',
      // empresa PARA QUEM é o evento (perguntada no fluxo de nomes) — é a que aparece no resultado
      empresaPalestra: String(b.empresaPalestra || '').slice(0, 300),
      nomesSolicitados: nomes,
      utm: b.utm || {},
    };

    const id = crypto.randomUUID();

    // marcador que TRAVA a IA na lista fechada + linha legível pro time.
    const notaExtra = [
      `LISTA_FECHADA: [${nomes.join(' | ')}]`,
      '',
      `O cliente JÁ TROUXE os nomes. Curadoria de LISTA FECHADA: apresentar SOMENTE estes palestrantes, não indicar outros.`,
      `Palestrantes solicitados: ${nomes.join(', ')}.`,
    ].join('\n');

    let hubspot;
    try {
      hubspot = await criarNegocioCuradoria(assinatura.contatoId, briefing, id, notaExtra);
    } catch (e) {
      console.error('HUBSPOT_FALHOU', id, e.message);
      return res.status(502).json({ erro: 'não conseguimos registrar seus nomes agora. Tente de novo em instantes.', detalhe: e.message.slice(0, 400) });
    }

    await redis().set(chave(id), JSON.stringify({
      id, criadoEm: new Date().toISOString(), briefing, hubspot, pago: true, acoes: [],
      nomesDoCliente: true, nomesSolicitados: nomes, briefingCompleto: false,
      documento: doc.valor, documentoTipo: doc.tipo,
      assinaturaDealId: assinatura.dealId, contatoId: assinatura.contatoId,
    }), 'EX', 60 * 60 * 24 * 90);
    await redis().set(chaveDeal(hubspot.negocioId), id, 'EX', 60 * 60 * 24 * 90);

    res.status(200).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'falha ao registrar os nomes', detalhe: e.message });
  }
}
