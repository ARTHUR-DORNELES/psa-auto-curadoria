import { acaoCuradoria, lerCorpo, cors } from './_lib.js';
import { lerSessao } from './_auth.js';

// Ação sobre UMA curadoria da lista:
//   - acao 'finalizar' -> move o negócio para "Curadorias finalizadas" (continua na lista, com selo)
//   - acao 'arquivar'  -> move para "Negócio perdido" (some da lista; reversível no HubSpot)
// Exige sessão; admin age em qualquer curadoria da empresa, usuário só nas dele.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });

  const { sessao, id, acao } = await lerCorpo(req);
  const uuid = String(id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return res.status(400).json({ ok: false, erro: 'id inválido' });

  try {
    const sess = await lerSessao(sessao);
    if (!sess) return res.status(401).json({ ok: false, erro: 'Sua sessão expirou. Entre de novo.' });
    if (sess.suporte) return res.status(403).json({ ok: false, erro: 'Modo suporte: somente leitura.' });
    const r = await acaoCuradoria(sess, uuid, String(acao || '').trim());
    return res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    console.error('CURADORIA_ACAO_FALHOU', e.message);
    return res.status(200).json({ ok: false, erro: 'Não conseguimos processar agora. Tente de novo.' });
  }
}
