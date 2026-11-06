import { decidirAcesso, dadosContato, lerCorpo, cors } from './_lib.js';
import { lerSessao, publico, marcarAcesso } from './_auth.js';

// Porta da ferramenta, já com o usuário logado (e-mail + senha, ver api/conta.js).
// A sessão diz a empresa (documento da assinatura) e o papel:
//  - admin   : vê TODAS as curadorias da empresa (cada uma com quem criou)
//  - usuario : vê só as que ele criou
// Modos: 'novo' (sem curadorias visíveis, assinatura ativa) / 'escolher' (lista) /
// motivo 'nao_encontrado' (sem assinatura ativa) / 'sessao' (precisa entrar de novo).
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });

  const { sessao } = await lerCorpo(req);
  try {
    const sess = await lerSessao(sessao);
    if (!sess) return res.status(200).json({ ok: false, motivo: 'sessao', erro: 'Sua sessão expirou. Entre de novo.' });
    const usuario = { ...publico({ ...sess, status: 'ativo' }) };
    await marcarAcesso(sess.doc, sess.email);

    const dec = await decidirAcesso(sess.doc);
    const minhas = (dec.curadorias || []).filter((c) =>
      sess.papel === 'admin' || (c.autor && c.autor.email === sess.email));
    const podeNova = dec.modo === 'novo' || !!dec.podeNova;

    if (dec.modo === 'invalido' || dec.modo === 'nenhum' || (dec.modo === 'esgotado' && !minhas.length)) {
      return res.status(200).json({ ok: false, motivo: 'nao_encontrado', usuario,
        erro: dec.modo === 'esgotado' ? 'A assinatura da sua empresa expirou. Fale com a PSA para renovar.' : 'Não encontramos uma assinatura ativa para a sua empresa.' });
    }
    // dados de quem está logado pré-preenchem o briefing (o Santiago cumprimenta pelo nome).
    // Empresa/telefone vêm do comprador, que é a mesma empresa.
    const comprador = podeNova ? await dadosContato(dec.contatoId) : {};
    const contato = podeNova ? { ...comprador, nome: sess.nome || comprador.nome, email: sess.email } : null;

    if (!minhas.length) {
      if (!podeNova) return res.status(200).json({ ok: false, motivo: 'nao_encontrado', usuario, erro: 'A assinatura da sua empresa expirou. Fale com a PSA para renovar.' });
      return res.status(200).json({ ok: true, modo: 'novo', usuario, contato });
    }
    return res.status(200).json({ ok: true, modo: 'escolher', usuario, curadorias: minhas, podeNova, contato });
  } catch (e) {
    console.error('ACESSO_FALHOU', e.message);
    return res.status(200).json({ ok: false, motivo: 'erro', erro: 'Não conseguimos validar agora. Tente de novo em instantes.' });
  }
}
