import { redis, chave, nota, lerCorpo, cors } from './_lib.js';

// Confirmação de pagamento. Agnóstico de gateway: procura o id da curadoria
// nos lugares onde Kiwify e Stripe costumam devolver o que a gente mandou.
const CAMINHOS = [
  b => b.ref,
  b => b.Product?.ref,
  b => b.order?.ref,
  b => b.client_reference_id,
  b => b.data?.object?.client_reference_id,
  b => b.data?.object?.metadata?.ref,
  b => b.metadata?.ref,
  b => b.TrackingParameters?.ref,
];

const PAGO = /paid|approved|aprovado|completed|succeeded|complete/i;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const segredo = process.env.WEBHOOK_SECRET;
  if (segredo && req.query.token !== segredo) return res.status(401).json({ erro: 'token inválido' });

  try {
    const b = await lerCorpo(req);
    const id = CAMINHOS.map(f => { try { return f(b); } catch { return null; } }).find(v => typeof v === 'string' && v.length === 36);
    if (!id) return res.status(400).json({ erro: 'ref da curadoria não encontrada no payload' });

    const status = String(b.order_status || b.status || b.type || b.data?.object?.payment_status || '');
    if (status && !PAGO.test(status)) return res.status(200).json({ ok: true, ignorado: status });

    const bruto = await redis().get(chave(id));
    if (!bruto) return res.status(404).json({ erro: 'curadoria não encontrada' });

    const reg = JSON.parse(bruto);
    if (reg.pago) return res.status(200).json({ ok: true, jaEstavaPago: true });

    reg.pago = true;
    reg.pagoEm = new Date().toISOString();
    await redis().set(chave(id), JSON.stringify(reg), 'EX', 60 * 60 * 24 * 90);

    if (reg.hubspot?.negocioId) {
      try { await nota(reg.hubspot.negocioId, `PAGAMENTO CONFIRMADO — curadoria ${id} liberada para o cliente.`); }
      catch (e) { console.error('nota de pagamento falhou:', e.message); }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
}
