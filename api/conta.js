import { lerCorpo, cors } from './_lib.js';
import { login, lerLink, definirSenha, esqueciSenha, primeiroAcesso, lerSessao, encerrarSessao, gerenciar, publico, salvarMeuCelular, empresas, entrarComoSuporte, liberarOraculo, definirQtdUsuarios, definirLimiteDisp, demandaGratuita, palestrasGratuitas, liberarGratuitas, candidatosDaGratuita, responderCandidato, cancelarGratuita, porquesDoCandidato } from './_auth.js';

// Conta e usuários (uma função só, por `acao`):
//   entrar {email,senha}        -> { sessao, usuario }
//   link {token}                -> pra quem é o link do e-mail (convite / nova senha)
//   definir-senha {token,senha,celular} -> ativa o acesso e já entra (celular obrigatório se ainda não houver)
//   meu-celular {sessao,celular} -> o próprio usuário informa o celular
//   esqueci {email}             -> manda link de nova senha (resposta não revela se existe)
//   primeiro-acesso {documento} -> CPF/CNPJ da compra manda o link pro e-mail do comprador (admin)
//   eu {sessao} / sair {sessao}
//   usuarios {sessao, op: listar|convidar|reenviar|celular|papel|remover, email, nome, celular, papel} (só admin)
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });
  const b = await lerCorpo(req);
  try {
    switch (b.acao) {
      case 'entrar': return res.status(200).json(await login(b.email, b.senha));
      case 'link': {
        const l = await lerLink(b.token);
        return res.status(200).json(l ? { ok: true, email: l.email, nome: l.nome, celular: l.celular, tipo: l.tipo } : { ok: false, erro: 'Este link expirou ou já foi usado. Peça um novo.' });
      }
      case 'definir-senha': return res.status(200).json(await definirSenha(b.token, b.senha, b.celular));
      case 'esqueci': return res.status(200).json(await esqueciSenha(b.email));
      case 'primeiro-acesso': return res.status(200).json(await primeiroAcesso(b.documento));
      case 'eu': {
        const s = await lerSessao(b.sessao);
        return res.status(200).json(s ? { ok: true, usuario: publico({ ...s, status: 'ativo' }) } : { ok: false, motivo: 'sessao' });
      }
      case 'meu-celular': {
        const s = await lerSessao(b.sessao);
        if (!s) return res.status(200).json({ ok: false, motivo: 'sessao', erro: 'Sua sessão expirou. Entre de novo.' });
        if (s.suporte) return res.status(200).json({ ok: false, erro: 'Modo suporte: somente leitura.' });
        return res.status(200).json(await salvarMeuCelular(s, b.celular));
      }
      case 'empresas': return res.status(200).json(await empresas(await lerSessao(b.sessao)));
      case 'gratuitas-liberar': return res.status(200).json(await liberarGratuitas(await lerSessao(b.sessao), b));
      case 'oraculo-liberar': return res.status(200).json(await liberarOraculo(await lerSessao(b.sessao), b));
      case 'empresa-usuarios': return res.status(200).json(await definirQtdUsuarios(await lerSessao(b.sessao), b));
      case 'empresa-limite-disp': return res.status(200).json(await definirLimiteDisp(await lerSessao(b.sessao), b));
      case 'gratuitas-porques': return res.status(200).json(await porquesDoCandidato(await lerSessao(b.sessao), b));
      case 'gratuitas-cancelar': return res.status(200).json(await cancelarGratuita(await lerSessao(b.sessao), b));
      case 'gratuitas-responder': return res.status(200).json(await responderCandidato(await lerSessao(b.sessao), b));
      case 'gratuitas-candidatos': return res.status(200).json(await candidatosDaGratuita(await lerSessao(b.sessao), b));
      case 'gratuitas-listar': return res.status(200).json(await palestrasGratuitas(await lerSessao(b.sessao)));
      case 'demanda-gratuita': return res.status(200).json(await demandaGratuita(await lerSessao(b.sessao), b));
      case 'suporte-entrar': return res.status(200).json(await entrarComoSuporte(await lerSessao(b.sessao), b));
      case 'sair': await encerrarSessao(b.sessao); return res.status(200).json({ ok: true });
      case 'usuarios': {
        const s = await lerSessao(b.sessao);
        if (!s) return res.status(200).json({ ok: false, motivo: 'sessao', erro: 'Sua sessão expirou. Entre de novo.' });
        return res.status(200).json(await gerenciar(s, b.op, b));
      }
      default: return res.status(400).json({ ok: false, erro: 'ação inválida' });
    }
  } catch (e) {
    console.error('CONTA_FALHOU', b.acao, e.message.slice(0, 300));
    return res.status(200).json({ ok: false, erro: 'Não conseguimos processar agora. Tente de novo em instantes.' });
  }
}
