import { redis, cors } from './_lib.js';

// Lista de nomes do roster da PSA (a MESMA base que a IA usa pra casar), pro autocomplete
// da entrada "já tenho os nomes". Vem de um webhook do n8n (lê o Redis do roster) e é
// cacheada aqui por algumas horas — a base muda pouco e ler 1200+ chaves é lento.
// O workflow mora no n8n da RevOps desde a migração de 07/10/2026 e lê o agregado
// pcur:pal:all (um GET só). A env fica como segunda tentativa, caso aponte pra outro lugar.
const ROSTER_REVOPS = 'https://revopspsa.app.n8n.cloud/webhook/roster-nomes-ac-2f9c7';
const ROSTER_URLS = [...new Set([ROSTER_REVOPS, process.env.N8N_ROSTER_NOMES].filter(Boolean))];
const CACHE_KEY = 'auto-curadoria:roster-nomes';
const TTL = 60 * 60 * 6;   // 6h

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const cached = await redis().get(CACHE_KEY);
    if (cached) return res.status(200).json(JSON.parse(cached));

    let nomes = [];
    for (const url of ROSTER_URLS) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        nomes = Array.isArray(j.nomes) ? j.nomes.filter((n) => typeof n === 'string' && n.trim()) : [];
      } catch (e) {
        console.error('palestrantes (roster) falhou em', url, e.message);
      }
      if (nomes.length) break;
    }
    const payload = { nomes };
    // lista vazia não entra no cache: senão o autocomplete fica 6h sem sugestões
    if (nomes.length) await redis().set(CACHE_KEY, JSON.stringify(payload), 'EX', TTL);
    return res.status(200).json(payload);
  } catch (e) {
    console.error('palestrantes (roster) falhou:', e.message);
    return res.status(200).json({ nomes: [] });   // front cai no modo texto livre
  }
}
