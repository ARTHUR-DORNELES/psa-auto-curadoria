// Rastro da jornada (Renato, 19/11/2026): por onde a pessoa veio (UTM/onda do disparo), o que fez
// na LP e na ferramenta. Alimenta a aba "Essencial" do painel (só super admin).
//   POST {acao:'evento', vid, tipo, utm?, ref?, email?, p?, d?}  (público, vindo da LP/ferramenta)
//   POST {acao:'relatorio', sessao, dias?}                      (super admin)
// Redis: ac:rv:<vid> (visitante: origem, e-mail, datas), ac:rv:<vid>:ev (eventos, últimos 300),
//        ac:rastro:vids (zset por último acesso), ac:rastro:email:<email> (vid mais recente).
import { lerCorpo, cors, redis } from './_lib.js';
import { lerSessao, ehSuper, normEmail, emailValido } from './_auth.js';
import { resultadoDosDisparos } from './_disparos.js';

const TIPOS = new Set(['lp_visita', 'lp_cta', 'lp_rolou', 'lp_tempo', 'visita', 'cadastro', 'login', 'curadoria_iniciada', 'curadoria_enviada',
  'curadoria_pronta', 'disponibilidade', 'cotacao', 'assinar', 'chat_pulou_pro_form']);
const kV = (v) => `ac:rv:${v}`;
const kEv = (v) => `ac:rv:${v}:ev`;
const corta = (x, n = 120) => String(x ?? '').slice(0, n);
const TTL = 60 * 60 * 24 * 400;   // ~13 meses

async function evento(b, req) {
  const vid = String(b.vid || '');
  if (!/^[a-z0-9]{8,40}$/i.test(vid) || !TIPOS.has(b.tipo)) return { ok: false };
  const r = redis();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const k = `ac:tent:rastro:${ip || vid}`;
  const n = await r.incr(k); if (n === 1) await r.expire(k, 60);
  if (n > 120) return { ok: false };   // trava de abuso: 120 eventos/min por IP
  const agora = Date.now();
  const v = JSON.parse((await r.get(kV(vid))) || 'null') || { vid, primeiro: agora, origem: null, n: 0 };
  const utm = {};
  for (const [kk, vv] of Object.entries(b.utm || {})) if (/^utm_[a-z]+$/.test(kk) && vv) utm[kk] = corta(vv, 80);
  // primeira origem com UTM vale como origem (a pessoa pode voltar depois direto)
  if (!v.origem && (Object.keys(utm).length || b.ref)) v.origem = { ...utm, ref: corta(b.ref, 160) };
  if (Object.keys(utm).length && !v.origem?.utm_source) v.origem = { ...utm, ref: corta(b.ref, 160) };
  if (Object.keys(utm).length) v.ultimaUtm = utm;
  const email = normEmail(b.email);
  if (email && emailValido(email)) { v.email = email; await r.set(`ac:rastro:email:${email}`, vid, 'EX', TTL); }
  if (b.produto === 'essencial' || b.tipo === 'lp_visita' || b.lp === 'essencial') v.essencial = true;
  v.ultimo = agora; v.n = (v.n || 0) + 1;
  const ev = { t: agora, tipo: b.tipo };
  if (b.p) ev.p = corta(b.p, 80);
  if (b.d) ev.d = corta(b.d, 160);
  if (Object.keys(utm).length) ev.utm = utm;
  await r.multi()
    .set(kV(vid), JSON.stringify(v), 'EX', TTL)
    .lpush(kEv(vid), JSON.stringify(ev)).ltrim(kEv(vid), 0, 299).expire(kEv(vid), TTL)
    .zadd('ac:rastro:vids', agora, vid)
    .exec();
  return { ok: true };
}

// onda = utm_content "onda-3" (link do disparo); canal = utm_source/medium
const ondaDe = (o) => { const m = String(o?.utm_content || '').match(/onda[-_ ]?(\d+)/i); return m ? `Onda ${m[1]}` : ''; };
const canalDe = (o) => {
  if (!o) return 'Direto';
  const s = String(o.utm_source || '').toLowerCase(), m = String(o.utm_medium || '').toLowerCase();
  if (/whats|wpp|zap/.test(s + m)) return 'WhatsApp';
  if (/mail|hs_email|hubspot/.test(s + m)) return 'E-mail';
  if (s) return o.utm_source;
  if (o.ref && !/profissionaissa|psa-auto-curadoria/.test(o.ref)) { try { return new URL(o.ref).hostname.replace(/^www\./, ''); } catch { return 'Outro site'; } }
  return 'Direto';
};

async function relatorio(b) {
  const r = redis();
  // período: de/até em ms (Hoje / Data personalizada) ou os últimos N dias
  const agora = Date.now();
  let desde, ate = agora, dias;
  if (Number(b.de) > 0) {
    desde = Math.max(Number(b.de), agora - 400 * 864e5);
    ate = Math.min(Number(b.ate) > 0 ? Number(b.ate) : agora, agora);
    dias = Math.max(1, Math.round((ate - desde) / 864e5));
  } else {
    dias = Math.min(Math.max(Number(b.dias) || 30, 1), 400);
    desde = agora - dias * 864e5;
  }
  // o zset guarda o ÚLTIMO acesso: pega todo mundo ativo desde o início do período e corta os eventos depois
  const vids = (await r.zrevrangebyscore('ac:rastro:vids', '+inf', desde, 'LIMIT', 0, 3000));
  const pessoas = [];
  for (let i = 0; i < vids.length; i += 200) {
    const lote = vids.slice(i, i + 200);
    const p = r.pipeline();
    lote.forEach((v) => { p.get(kV(v)); p.lrange(kEv(v), 0, 299); });
    const out = await p.exec();
    lote.forEach((v, j) => {
      const vis = JSON.parse(out[j * 2][1] || 'null');
      if (!vis) return;
      const evs = (out[j * 2 + 1][1] || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean).reverse();
      pessoas.push({ ...vis, eventos: evs });
    });
  }
  // junta visitantes do mesmo e-mail (celular + computador) numa pessoa só
  const porEmail = new Map(), anonimos = [];
  for (const p of pessoas) {
    if (!p.email) { anonimos.push(p); continue; }
    const a = porEmail.get(p.email);
    if (!a) { porEmail.set(p.email, { ...p, vids: [p.vid] }); continue; }
    a.vids.push(p.vid);
    a.eventos = [...a.eventos, ...p.eventos].sort((x, y) => x.t - y.t);
    if (p.primeiro < a.primeiro) { a.primeiro = p.primeiro; if (p.origem) a.origem = p.origem; }
    a.ultimo = Math.max(a.ultimo, p.ultimo); a.essencial = a.essencial || p.essencial;
    if (!a.origem?.utm_source && p.origem?.utm_source) a.origem = p.origem;
  }
  const todos = [...porEmail.values(), ...anonimos].map((p) => {
    const ev = p.eventos.filter((e) => e.t >= desde && e.t <= ate);
    const conta = (t) => ev.filter((e) => e.tipo === t).length;
    return {
      email: p.email || '', essencial: !!p.essencial, primeiro: p.primeiro, ultimo: p.ultimo,
      onda: ondaDe(p.origem), canal: canalDe(p.origem), origem: p.origem || null,
      lp: conta('lp_visita'), rolou: conta('lp_rolou'), tempo: conta('lp_tempo'), cta: conta('lp_cta'), visitas: conta('visita'), cadastro: conta('cadastro'), login: conta('login'),
      iniciadas: conta('curadoria_iniciada'), enviadas: conta('curadoria_enviada'), prontas: conta('curadoria_pronta'),
      disp: conta('disponibilidade'), assinar: conta('assinar'),
      eventos: ev.slice(-80),
    };
  }).filter((p) => p.eventos.length && !/@profissionaissa\.com$/.test(p.email));   // equipe PSA (testes) fora

  // nome/empresa de quem tem conta
  const comEmail = todos.filter((p) => p.email);
  if (comEmail.length) {
    const p = r.pipeline(); comEmail.forEach((x) => p.get(`ac:usuario:${x.email}`));
    const docs = (await p.exec()).map((o) => o[1] || '');
    const q = r.pipeline(); comEmail.forEach((x, i) => q.hget(`ac:org:${docs[i] || '-'}:usuarios`, x.email));
    const us = await q.exec();
    comEmail.forEach((x, i) => {
      x.doc = docs[i];
      try { const u = JSON.parse(us[i][1] || 'null'); if (u) { x.nome = u.nome || ''; x.empresa = u.empresa || ''; } } catch {}
    });
  }
  todos.sort((a, b) => b.ultimo - a.ultimo);
  let disparos = null;
  try { disparos = await resultadoDosDisparos(); } catch (e) { disparos = { erro: e.message.slice(0, 160) }; }
  return { ok: true, dias, pessoas: todos, disparos };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let b = await lerCorpo(req).catch(() => ({}));
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  try {
    if (b.acao === 'evento') return res.status(200).json(await evento(b, req));
    if (b.acao === 'relatorio') {
      const s = await lerSessao(b.sessao);
      if (!s || !ehSuper(s.realEmail || s.email) || s.suporte) return res.status(200).json({ ok: false, erro: 'Acesso restrito.' });
      return res.status(200).json(await relatorio(b));
    }
    return res.status(400).json({ ok: false });
  } catch (e) {
    console.error('RASTRO_FALHOU', e.message);
    return res.status(200).json({ ok: false, erro: 'Não conseguimos agora.' });
  }
}
