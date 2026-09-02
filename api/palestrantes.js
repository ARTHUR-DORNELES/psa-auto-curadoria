import { redis, cors } from './_lib.js';

// Lista de nomes do roster da PSA (a MESMA base que a IA usa pra casar), pro autocomplete
// da entrada "já tenho os nomes". Vem de um webhook do n8n (lê o Redis do roster) e é
// cacheada aqui por algumas horas — a base muda pouco e ler 1200+ chaves é lento.
const ROSTER_URL = process.env.N8N_ROSTER_NOMES
  || 'https://n8n.profissionaissa.tchat.telnet23.com.br/webhook/roster-nomes-ac-2f9c7';
const CACHE_KEY = 'auto-curadoria:roster-nomes';
const TTL = 60 * 60 * 6;   // 6h

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const cached = await redis().get(CACHE_KEY);
    if (cached) return res.status(200).json(JSON.parse(cached));

    const r = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(9000) });
    const j = await r.json();
    const nomes = Array.isArray(j.nomes) ? j.nomes.filter((n) => typeof n === 'string' && n.trim()) : [];
    const payload = { nomes };
    if (nomes.length) await redis().set(CACHE_KEY, JSON.stringify(payload), 'EX', TTL);
    return res.status(200).json(payload);
  } catch (e) {
    console.error('palestrantes (roster) falhou:', e.message);
    return res.status(200).json({ nomes: [] });   // front cai no modo texto livre
  }
}
