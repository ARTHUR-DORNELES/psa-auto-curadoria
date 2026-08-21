import { creditoPagoPorDocumento, normalizaDocumento, lerCorpo, cors } from './_lib.js';

// Gate de acesso: valida se o CPF/CNPJ tem uma compra liberada ("Pago") na pipeline
// Auto Curadoria. Não consome nada aqui — só diz se pode entrar. O consumo (mover para
// "Utilizado") acontece quando a curadoria é gerada.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });

  const { documento } = await lerCorpo(req);
  const doc = normalizaDocumento(documento);
  if (!doc) return res.status(400).json({ ok: false, erro: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).' });

  try {
    const credito = await creditoPagoPorDocumento(documento);
    if (!credito) {
      return res.status(200).json({ ok: false, erro: 'Não encontramos uma compra liberada para este CPF/CNPJ. Se você já comprou, confira o documento; senão, adquira a Auto Curadoria.' });
    }
    return res.status(200).json({ ok: true, tipo: doc.tipo });
  } catch (e) {
    console.error('ACESSO_FALHOU', e.message);
    return res.status(200).json({ ok: false, erro: 'Não conseguimos validar agora. Tente de novo em instantes.' });
  }
}
