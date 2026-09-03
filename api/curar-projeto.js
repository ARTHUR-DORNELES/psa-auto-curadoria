import crypto from 'node:crypto';
import { criarNegocioCuradoria, redis, chave, chaveDeal, chaveProjeto, lerCorpo, cors, assinaturaAtivaPorDocumento, normalizaDocumento } from './_lib.js';

// EVENTO com vários palestrantes (caminho "quero ajuda"): cria UMA curadoria por MACRO TEMA,
// todas com o MESMO briefing (só o tema muda). O resultado vira abas, uma por tema.
// Espelha o curar.js, mas em lote e agrupado por tema.
const OBRIGATORIOS = ['nome', 'empresa', 'email', 'telefone', 'publicoAlvo',
  'formato', 'horario', 'duracao', 'localEvento', 'cidade', 'local', 'orcamento', 'vendaIngresso',
  'motivacao', 'sentimento'];   // macroTema NÃO é obrigatório aqui: vem por curadoria (temas[])

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  try {
    const b = await lerCorpo(req);

    // temas: 1+ macro temas (um por palestrante). Distintos viram curadorias.
    const temas = [...new Set((Array.isArray(b.temas) ? b.temas : [])
      .map((t) => String(t || '').trim()).filter(Boolean))];
    if (temas.length < 2) return res.status(400).json({ erro: 'um projeto de evento precisa de pelo menos 2 macro temas distintos.' });

    const faltando = OBRIGATORIOS.filter(c => !String(b[c] || '').trim());
    if (faltando.length) return res.status(400).json({ erro: `campos obrigatórios: ${faltando.join(', ')}` });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(b.email)) return res.status(400).json({ erro: 'e-mail inválido' });

    const doc = normalizaDocumento(b.documento);
    if (!doc) return res.status(400).json({ erro: 'Informe um CPF ou CNPJ válido para liberar sua curadoria.' });
    let assinatura;
    try { assinatura = await assinaturaAtivaPorDocumento(b.documento); }
    catch (e) { console.error('VALIDACAO_ACESSO_FALHOU', e.message); return res.status(502).json({ erro: 'não conseguimos validar seu acesso agora. Tente de novo em instantes.' }); }
    if (!assinatura) return res.status(402).json({ erro: 'Não encontramos uma assinatura para este CPF/CNPJ.' });
    if (!assinatura.ativa) return res.status(402).json({ erro: 'Sua assinatura expirou. Renove para montar novas curadorias.' });

    const briefingBase = {
      nome: b.nome, empresa: b.empresa, email: b.email.toLowerCase().trim(), telefone: b.telefone,
      publicoAlvo: b.publicoAlvo, formato: b.formato,
      data: b.data, horario: b.horario, duracao: b.duracao,
      localEvento: b.localEvento, cidade: b.cidade, local: b.local,
      orcamento: b.orcamento, vendaIngresso: b.vendaIngresso,
      motivacao: b.motivacao, sentimento: b.sentimento,
      palestranteDesejado: String(b.palestranteDesejado || '').slice(0, 300),
      empresaPalestra: String(b.empresaPalestra || '').slice(0, 300),
      briefing: String(b.briefing || '').slice(0, 4000),
      utm: b.utm || {},
    };

    const projetoId = crypto.randomUUID();
    const curadorias = [];   // { id, macroTema, negocioId }

    // uma curadoria (deal) por macro tema. Falha parcial: segue com as que deram certo.
    for (const macroTema of temas) {
      const id = crypto.randomUUID();
      const briefing = { ...briefingBase, macroTema, microTema: '', projetoId };
      let hubspot;
      try {
        hubspot = await criarNegocioCuradoria(assinatura.contatoId, briefing, id,
          `Parte do EVENTO/projeto ${projetoId} (curadoria do tema "${macroTema}").`);
      } catch (e) { console.error('HUBSPOT_FALHOU (projeto)', projetoId, macroTema, e.message); continue; }

      await redis().set(chave(id), JSON.stringify({
        id, criadoEm: new Date().toISOString(), briefing, hubspot, pago: true, acoes: [],
        projetoId, macroTema,
        documento: doc.valor, documentoTipo: doc.tipo,
        assinaturaDealId: assinatura.dealId, contatoId: assinatura.contatoId,
      }), 'EX', 60 * 60 * 24 * 90);
      await redis().set(chaveDeal(hubspot.negocioId), id, 'EX', 60 * 60 * 24 * 90);
      curadorias.push({ id, macroTema, negocioId: hubspot.negocioId });
    }

    if (!curadorias.length) return res.status(502).json({ erro: 'não conseguimos registrar as curadorias agora. Tente de novo em instantes.' });

    await redis().set(chaveProjeto(projetoId), JSON.stringify({
      id: projetoId, criadoEm: new Date().toISOString(),
      briefing: briefingBase, curadorias: curadorias.map(c => ({ id: c.id, macroTema: c.macroTema })),
      documento: doc.valor, documentoTipo: doc.tipo, contatoId: assinatura.contatoId,
    }), 'EX', 60 * 60 * 24 * 90);

    res.status(200).json({ projetoId, curadorias: curadorias.map(c => ({ id: c.id, macroTema: c.macroTema })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'falha ao registrar o projeto', detalhe: e.message });
  }
}
