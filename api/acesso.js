import { decidirAcesso, dadosContato, normalizaDocumento, lerCorpo, cors } from './_lib.js';

// Gate de acesso: o CPF/CNPJ é a chave da curadoria. Decide o que a ferramenta faz:
//  - modo 'novo'    (ok)  : tem compra "Pago" -> briefing novo
//  - modo 'retomar' (ok)  : só "Utilizado" com refação sobrando -> retomar (devolve id)
//  - motivo 'nao_encontrado' (!ok): sem compra usável (nada, ou já utilizada) -> checkout
//  - motivo 'invalido'/'erro' (!ok): documento inválido / falha transitória -> tenta de novo
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });

  const { documento } = await lerCorpo(req);
  if (!normalizaDocumento(documento)) {
    return res.status(400).json({ ok: false, motivo: 'invalido', erro: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).' });
  }

  try {
    const dec = await decidirAcesso(documento);
    switch (dec.modo) {
      case 'novo':
        // já sabemos quem é o comprador (casado pelo CPF/CNPJ) -> manda nome/empresa/
        // email/telefone p/ o chat pré-preencher e o Santiago cumprimentar pelo nome
        return res.status(200).json({ ok: true, modo: 'novo', contato: await dadosContato(dec.contatoId) });
      case 'retomar':
        return res.status(200).json({ ok: true, modo: 'retomar', id: dec.id });
      case 'esgotado':
        return res.status(200).json({ ok: false, motivo: 'nao_encontrado', erro: 'Sua curadoria já foi utilizada. Adquira uma nova para começar de novo.' });
      case 'nenhum':
        return res.status(200).json({ ok: false, motivo: 'nao_encontrado', erro: 'Não encontramos uma compra liberada para este CPF/CNPJ.' });
      default:
        return res.status(400).json({ ok: false, motivo: 'invalido', erro: 'Informe um CPF ou CNPJ válido.' });
    }
  } catch (e) {
    console.error('ACESSO_FALHOU', e.message);
    return res.status(200).json({ ok: false, motivo: 'erro', erro: 'Não conseguimos validar agora. Tente de novo em instantes.' });
  }
}
