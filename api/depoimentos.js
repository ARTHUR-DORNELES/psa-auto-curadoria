import { redis, cors, hs } from './_lib.js';

// Depoimentos do palestrante (até 5), buscados na hora na API do PSA.
// O card nasce com os até 5 guardados no contato (workflow "Roster NPS" do n8n);
// esta rota completa até 5 com o que entrou depois da varredura, mesmo filtro, para o pop-up e o
// número do botão. Cache de 1 dia por contato.
//
// POST { ids: ["<id_contato>", ...] }  ->  { ok, porId: { <id>: { total, depoimentos } } }
// Sem PSA_API_KEY (ou se a API cair) devolve porId vazio e o card segue com os guardados.

const BASE = 'https://services-prd.profissionaissa.com/login-psa-ms';
const TTL = 86400;
const MAX_LISTA = 5;            // teto por palestrante (decisão do Renato: até 5), o mesmo do Roster NPS
const MIN_PLATEIA = 61, MIN_CONTRATANTE = 40, MAX_CHARS = 320;

// ---- filtro: cópia fiel do nó "Calcula NPS" (n8n-backups/novos/roster-nps) ----
const INCRIVEL = /incr.?vel, conectou demais/i;
const LIXO = [
  /\bme (assist|sig|acompanh|cham|chame|contat)/i,
  /\b(meu|minha) (instagram|insta|canal|perfil|site|livro|curso|palestra|empresa)\b/i,
  /\b(https?:\/\/|www\.)/i,
  /@[a-z0-9._]{3,}/i,
  /\(?\d{2}\)?\s?9?\d{4}[-\s.]?\d{4}/,
  /\b(gostaria|queria|quero|preciso|precisava|adoraria|espero que|seria bom se)\b.{0,40}\b(de|que|ter|receber|saber|ver|mais)\b/i,
  /\btenho interesse\b/i,
  /\b(me (envi|mand)|encaminh(ar|em)|disponibiliz)/i,
  /\b(melhorar|poderia (ter|ser|melhorar)|faltou|deveria|esperava mais|não gostei|pouco tempo|muito r[áa]pid|dificuldade)/i,
  /\b(formul[áa]rio|question[áa]rio|alternativa|marcar mais de|certificado)\b/i,
];
const SINAL = [
  /\b(palestra|palestrante|apresenta[çc][ãa]o|conte[úu]do|fala|mensagem|tema|evento|workshop)\b/i,
  /\b(incr[íi]vel|sensacional|excelente|[óo]tim[ao]|maravilhos|fant[áa]stic|espetacular|impec[áa]vel)\b/i,
  /\b(adorei|amei|gostei|parab[ée]ns|obrigad|recomendo|inspirador|inspirou|transformador|impactante|emocionante)\b/i,
];
const ehDepoimento = (t) => { t = String(t || '').trim(); return !!t && !LIXO.some((re) => re.test(t)) && SINAL.some((re) => re.test(t)); };
const corta = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_CHARS) return t;
  const c = t.slice(0, MAX_CHARS), e = c.lastIndexOf(' ');
  return (e > MAX_CHARS * 0.6 ? c.slice(0, e) : c) + '…';
};
const autorDe = (n) => { const t = String(n || '').trim(); return !t || /@/.test(t) ? null : t; };
const dia = (d) => String(d.data || '').slice(0, 10);
const arruma = (d, origem) => ({
  origem, texto: corta(d.texto), autor: autorDe(d.nome),
  cargo: origem === 'plateia' ? String(d.empresa || '').trim() || null : null,
  empresa: origem === 'contratante' ? String(d.empresa || '').trim() || null : null,
  data: dia(d) || null,
});
function filtrar(ds) {
  const porData = (a, b) => dia(b).localeCompare(dia(a));
  const c = ds.filter((d) => d.origem === 'contratante' && String(d.texto || '').trim().length >= MIN_CONTRATANTE)
    .sort(porData).map((d) => arruma(d, 'contratante'));
  // mesmo texto repetido (gente que responde o QR duas vezes) aparece uma vez só
  const vistos = new Set();
  const p = ds.filter((d) => d.origem === 'qrcode' && String(d.texto || '').trim().length >= MIN_PLATEIA)
    .filter((d) => INCRIVEL.test(String(d.avaliacao || '')))
    .filter((d) => ehDepoimento(d.texto))
    .sort(porData).map((d) => arruma(d, 'plateia'))
    .filter((d) => { const k = d.texto.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; });
  return c.concat(p);
}

async function psa(caminho, chave) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(BASE + caminho, { headers: { 'x-api-key': chave }, signal: ctl.signal });
    if (!r.ok) return { status: r.status };
    return { status: 200, body: await r.json() };
  } finally { clearTimeout(t); }
}

async function doPalestrante(id, contato, chave) {
  const tent = [];
  if (contato.email) tent.push(`/internal/palestrante/lookup?email=${encodeURIComponent(contato.email)}`);
  if (contato.slug) tent.push(`/internal/palestrante/lookup?slug=${encodeURIComponent(contato.slug)}`);
  let pid = null;
  for (const u of tent) { try { const r = await psa(u, chave); if (r.status === 200 && r.body && r.body.id) { pid = r.body.id; break; } } catch (e) {} }
  if (!pid) return null;
  const r = await psa(`/internal/palestrante/${pid}/depoimentos`, chave);
  if (r.status !== 200) throw new Error('depoimentos HTTP ' + r.status);
  const todos = filtrar((r.body && r.body.depoimentos) || []);
  return { total: todos.length, depoimentos: todos.slice(0, MAX_LISTA) };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const chave = process.env.PSA_API_KEY;
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x || '').trim()).filter((x) => /^\d+$/.test(x)))].slice(0, 12);
  const porId = {};
  if (!ids.length || !chave) return res.status(200).json({ ok: true, porId, semChave: !chave });

  const k = (id) => `ac:dep:v1:${id}`;
  const falta = [];
  await Promise.all(ids.map(async (id) => {
    try { const c = await redis().get(k(id)); if (c) porId[id] = JSON.parse(c); else falta.push(id); } catch (e) { falta.push(id); }
  }));
  if (falta.length) {
    const contatos = {};
    try {
      const r = await hs('/crm/v3/objects/contacts/batch/read', 'POST', { properties: ['email', 'slug'], inputs: falta.map((id) => ({ id })) });
      for (const c of (r.results || [])) {
        const p = c.properties || {};
        // contato mesclado volta com o id novo: guarda pelos dois
        const v = { email: String(p.email || '').trim(), slug: String(p.slug || '').trim() };
        contatos[c.id] = v; if (p.hs_object_id) contatos[p.hs_object_id] = v;
      }
    } catch (e) { console.error('DEPOIMENTOS hubspot', e.message); }
    await Promise.all(falta.map(async (id) => {
      const contato = contatos[id];
      if (!contato) return;
      try {
        const out = await doPalestrante(id, contato, chave);
        const val = out || { total: 0, depoimentos: [] };
        porId[id] = val;
        await redis().set(k(id), JSON.stringify(val), 'EX', TTL).catch(() => {});
      } catch (e) { console.error('DEPOIMENTOS psa', id, e.message); }
    }));
  }
  return res.status(200).json({ ok: true, porId });
}
