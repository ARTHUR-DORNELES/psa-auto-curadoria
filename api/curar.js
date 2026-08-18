import crypto from 'node:crypto';
import { registrarNoHubspot, redis, chave, lerCorpo, cors } from './_lib.js';

// A ferramenta NÃO gera mais os nomes. Ela grava o briefing no negócio e a
// automação da PSA (disparada pela observação) produz o arquivo da IA Curadoria
// e escreve o link em `ia_curadoria_link`. Quem lê e escolhe os 3 é /api/resultado.
// Tudo obrigatório menos os descritivos (microTema, que 7 macro temas não têm,
// e o contexto livre). Espelha a validação do formulário — o servidor não confia nela.
const OBRIGATORIOS = ['nome', 'empresa', 'email', 'telefone', 'macroTema', 'publicoAlvo',
  'formato', 'data', 'horario', 'duracao', 'localEvento', 'cidade', 'local', 'orcamento', 'vendaIngresso',
  'motivacao', 'sentimento'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  try {
    const b = await lerCorpo(req);

    const faltando = OBRIGATORIOS.filter(c => !String(b[c] || '').trim());
    if (faltando.length) return res.status(400).json({ erro: `campos obrigatórios: ${faltando.join(', ')}` });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(b.email)) return res.status(400).json({ erro: 'e-mail inválido' });

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

    // Sem negócio no HubSpot não existe curadoria: é a observação que dispara a
    // automação. Aqui a falha é fatal, diferente de antes.
    let hubspot;
    try {
      hubspot = await registrarNoHubspot(briefing, null, id);
    } catch (e) {
      console.error('HUBSPOT_FALHOU', id, e.message);
      return res.status(502).json({
        erro: 'não conseguimos registrar seu briefing agora. Tente de novo em instantes.',
        detalhe: e.message.slice(0, 400),
      });
    }

    await redis().set(chave(id), JSON.stringify({
      id, criadoEm: new Date().toISOString(), briefing, hubspot, pago: false, acoes: [],
    }), 'EX', 60 * 60 * 24 * 90);

    res.status(200).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'falha ao registrar o briefing', detalhe: e.message });
  }
}
