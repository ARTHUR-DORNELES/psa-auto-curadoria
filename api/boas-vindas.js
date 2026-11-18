import { lerCorpo } from './_lib.js';
import { boasVindasDaCompra } from './_auth.js';

// Webhook do workflow HubSpot 1929458260 ("Auto Curadoria | Checkout → pipeline Auto Curadoria"):
// quando o negócio do checkout vira "Pago | Negócio Fechado", o HubSpot faz POST aqui com o
// negócio. A gente cadastra o comprador e grava o link de criar senha no contato; o workflow
// de contato 1919351143 manda o e-mail de boas-vindas (Essencial ou completa).
// Aceita o id do negócio em ?dealId=, ou no corpo (objectId / hs_object_id / properties).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });
  try {
    const b = await lerCorpo(req).catch(() => ({}));
    const pv = (k) => { const v = b?.properties?.[k]; return v && typeof v === 'object' ? v.value : v; };
    const dealId = req.query.dealId || b.objectId || b.hs_object_id || pv('hs_object_id') || b.dealId;
    const r = await boasVindasDaCompra(dealId);
    return res.status(200).json(r);
  } catch (e) {
    console.error('BOAS_VINDAS_FALHOU', e.message.slice(0, 300));
    return res.status(500).json({ ok: false, erro: 'falha ao preparar o acesso' });
  }
}
