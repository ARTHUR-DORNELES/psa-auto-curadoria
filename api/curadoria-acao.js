import { acaoCuradoria, lerCorpo, cors } from './_lib.js';

// Ação do cliente sobre UMA curadoria da lista dele:
//   - acao 'finalizar' -> move o negócio para "Curadorias finalizadas" (continua na lista, com selo)
//   - acao 'arquivar'  -> move para "Negócio perdido" (some da lista; reversível no HubSpot)
// Exige o CPF/CNPJ (mesmo que abriu a lista) e confere se ele é dono da curadoria.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });

  const { documento, id, acao } = await lerCorpo(req);
  const uuid = String(id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return res.status(400).json({ ok: false, erro: 'id inválido' });

  try {
    const r = await acaoCuradoria(documento, uuid, String(acao || '').trim());
    return res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    console.error('CURADORIA_ACAO_FALHOU', e.message);
    return res.status(200).json({ ok: false, erro: 'Não conseguimos processar agora. Tente de novo.' });
  }
}
