import crypto from 'node:crypto';
import { redis, hs, assinaturaAtivaPorDocumento, dadosContato, normalizaDocumento, listarCuradorias, negociosPagos, documentoDoNegocio } from './_lib.js';

/**
 * Usuários por empresa. A assinatura continua sendo o negócio "Pago" casado pelo CPF/CNPJ
 * do comprador; esse documento é a EMPRESA (org). Dentro dela vivem N usuários, cada um com
 * e-mail + senha. Quantos cabem é a propriedade `quantidade_usuarios` do negócio da
 * assinatura (preenchida à mão no HubSpot). A cota conta TODOS, admins inclusive.
 *
 * Papéis: 'admin' vê todas as curadorias da empresa e gerencia os usuários;
 * 'usuario' vê só as que ele mesmo criou.
 *
 * Redis (o da ferramenta, persistente, sem TTL nos usuários):
 *   ac:org:<doc>:usuarios   hash  email -> JSON {email,nome,papel,status,senha,criadoEm,convidadoPor,contatoId}
 *   ac:usuario:<email>      string -> doc (cada e-mail pertence a uma empresa só)
 *   ac:sessao:<token>       JSON {email,doc}      30 dias
 *   ac:link:<token>         JSON {email,doc,tipo}  convite 7 dias / senha 2 horas
 */

export const PROP_QTD_USUARIOS = process.env.PROP_QTD_USUARIOS || 'quantidade_usuarios';
const QTD_PADRAO = Number(process.env.QTD_USUARIOS_PADRAO || 1);
const APP_URL = process.env.APP_URL || 'https://lps.profissionaissa.com/auto-curadoria-briefing';
const SESSAO_S = 60 * 60 * 24 * 30;
const CONVITE_S = 60 * 60 * 24 * 7;
const RESET_S = 60 * 60 * 2;

// propriedades de CONTATO que o workflow do HubSpot usa para mandar o e-mail
const PROP_LINK = 'auto_curadoria_link';
const PROP_TIPO = 'auto_curadoria_email_tipo';
const PROP_CONVIDOU = 'auto_curadoria_convidado_por';

const kUsuarios = (doc) => `ac:org:${doc}:usuarios`;
const kUsuario = (email) => `ac:usuario:${email}`;
const kSessao = (t) => `ac:sessao:${t}`;
const kLink = (t) => `ac:link:${t}`;

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const emailValido = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(normEmail(e));

// Celular brasileiro em E.164 (+55 + DDD + 9 + 8 dígitos). Aceita com ou sem +55,
// com espaços, parênteses e traço. Devolve '' se não for um celular válido.
export function normCelular(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 11) return '';
  if (!/^[1-9][1-9]9\d{8}$/.test(d)) return '';
  return `+55${d}`;
}
export const ERRO_CELULAR = 'Celular inválido. Use +55, DDD e número, ex.: +55 41 99999-9999.';
const token = () => crypto.randomBytes(24).toString('base64url');

// ── senha ───────────────────────────────────────────────────────────────────
export function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(senha), sal, 64).toString('hex');
  return `scrypt$${sal}$${h}`;
}
export function confereSenha(senha, guardado) {
  const [alg, sal, h] = String(guardado || '').split('$');
  if (alg !== 'scrypt' || !sal || !h) return false;
  const calc = crypto.scryptSync(String(senha), sal, 64);
  const esperado = Buffer.from(h, 'hex');
  return esperado.length === calc.length && crypto.timingSafeEqual(calc, esperado);
}
export function senhaFraca(senha) {
  const s = String(senha || '');
  if (s.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
  return '';
}

// ── usuários da empresa ─────────────────────────────────────────────────────
export async function listarUsuarios(doc) {
  const h = await redis().hgetall(kUsuarios(doc));
  return Object.values(h || {}).map((v) => { try { return JSON.parse(v); } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.papel === b.papel ? String(a.nome || a.email).localeCompare(String(b.nome || b.email)) : a.papel === 'admin' ? -1 : 1));
}
async function lerUsuario(doc, email) {
  const v = await redis().hget(kUsuarios(doc), normEmail(email));
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
async function gravarUsuario(doc, u) {
  await redis().hset(kUsuarios(doc), u.email, JSON.stringify(u));
  await redis().set(kUsuario(u.email), doc);
}
export const publico = (u) => ({ email: u.email, nome: u.nome || '', celular: u.celular || '', papel: u.papel, status: u.status, criadoEm: u.criadoEm || null, ultimoAcesso: u.ultimoAcesso || null,
  ...(u.superAdmin ? { superAdmin: true } : {}), ...(u.oraculo ? { oraculo: true } : {}), ...(u.suporte ? { suporte: true } : {}) });

// "Último acesso": gravado no login, ao criar a senha e a cada abertura do painel.
// Só regrava se passou 10 min (evita escrever no Redis a cada clique). Nunca lança.
export async function marcarAcesso(doc, email) {
  try {
    if (ehSuper(email) && !(await lerUsuario(doc, email))) return;
    const u = await lerUsuario(doc, email);
    if (!u) return;
    const agora = Date.now();
    if (u.ultimoAcesso && agora - Date.parse(u.ultimoAcesso) < 10 * 60 * 1000) return;
    u.ultimoAcesso = new Date(agora).toISOString();
    await gravarUsuario(doc, u);
  } catch (e) { console.error('marcarAcesso falhou:', e.message); }
}

// limite de usuários = `quantidade_usuarios` do negócio da assinatura (vazio -> padrão)
export async function limiteUsuarios(doc) {
  const a = await assinaturaAtivaPorDocumento(doc);
  const n = Number(a?.props?.[PROP_QTD_USUARIOS]);
  return { assinatura: a, limite: Number.isFinite(n) && n > 0 ? Math.floor(n) : QTD_PADRAO };
}

// ── links (convite / redefinir senha) e e-mail pelo HubSpot ─────────────────
async function criarLink(doc, email, tipo) {
  const t = token();
  await redis().set(kLink(t), JSON.stringify({ email, doc, tipo }), 'EX', tipo === 'senha' ? RESET_S : CONVITE_S);
  return { token: t, url: `${APP_URL}?acesso=${t}` };
}

// O e-mail sai do HubSpot: a ferramenta grava o link numa propriedade do CONTATO e um
// workflow (gatilho: auto_curadoria_link mudou, reinscrição ligada) manda o e-mail com o
// token {{contact.auto_curadoria_link}}. Cria o contato se não existir. Nunca lança.
export async function enviarLinkPorEmail({ email, nome, url, tipo, convidadoPor, celular }) {
  try {
    const busca = await hs('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'], limit: 1,
    });
    let contatoId = busca.results?.[0]?.id;
    if (!contatoId) {
      const [first, ...rest] = String(nome || '').trim().split(/\s+/);
      const c = await hs('/crm/v3/objects/contacts', 'POST', {
        properties: { email, ...(first ? { firstname: first } : {}), ...(rest.length ? { lastname: rest.join(' ') } : {}) },
      });
      contatoId = c.id;
    }
    await hs(`/crm/v3/objects/contacts/${contatoId}`, 'PATCH', {
      properties: { [PROP_LINK]: url, [PROP_TIPO]: tipo, [PROP_CONVIDOU]: convidadoPor || '', ...(celular ? { mobilephone: celular } : {}) },
    });
    return { enviado: true, contatoId };
  } catch (e) {
    console.error('ENVIO_LINK_FALHOU', email, e.message.slice(0, 300));
    return { enviado: false };
  }
}

// Grava o celular no contato do HubSpot (campo "Celular"). Nunca lança.
async function celularNoContato(email, celular) {
  try {
    const busca = await hs('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'], limit: 1,
    });
    const id = busca.results?.[0]?.id;
    if (id) await hs(`/crm/v3/objects/contacts/${id}`, 'PATCH', { properties: { mobilephone: celular } });
  } catch (e) { console.error('CELULAR_CONTATO_FALHOU', email, e.message.slice(0, 200)); }
}

// O próprio usuário logado informa o celular (quem entrou antes do campo existir).
export async function salvarMeuCelular(sess, bruto) {
  const celular = normCelular(bruto);
  if (!celular) return { ok: false, erro: ERRO_CELULAR };
  const u = await lerUsuario(sess.doc, sess.email);
  if (!u) return { ok: false, motivo: 'sessao', erro: 'Sua sessão expirou. Entre de novo.' };
  u.celular = celular;
  await gravarUsuario(sess.doc, u);
  await celularNoContato(u.email, celular);
  return { ok: true, usuario: publico(u) };
}

// ── suporte PSA (super admin) ────────────────────────────────────────────────
// Só os e-mails desta lista veem o painel de empresas e entram em qualquer empresa.
// A entrada é SOMENTE LEITURA e invisível: não aparece em Usuários, não grava último
// acesso nem cria nada no HubSpot.
const SUPER = String(process.env.SUPER_ADMINS || 'renato.denck@profissionaissa.com')
  .split(',').map((e) => normEmail(e)).filter(Boolean);
export const ehSuper = (email) => SUPER.includes(normEmail(email));
const SUPORTE_S = 60 * 60 * 4;

// Oráculo: liberado empresa por empresa pelo suporte PSA (chave ac:org:<doc>:oraculo)
const kOraculo = (doc) => `ac:org:${doc}:oraculo`;
export const oraculoLiberado = async (doc) => (doc ? (await redis().get(kOraculo(doc))) === '1' : false);
export async function liberarOraculo(sess, b) {
  if (!sess || !ehSuper(sess.realEmail || sess.email) || sess.suporte) return { ok: false, erro: 'Acesso restrito.' };
  let doc = normalizaDocumento(b.doc)?.valor || '';
  if (!doc && b.dealId) doc = await documentoDoNegocio(String(b.dealId).replace(/\D/g, ''));
  if (!doc) return { ok: false, erro: 'Não achamos o CPF/CNPJ dessa empresa no HubSpot (contato ou empresa do negócio).' };
  if (b.liberar) await redis().set(kOraculo(doc), '1'); else await redis().del(kOraculo(doc));
  return { ok: true, doc, oraculo: !!b.liberar };
}

export async function empresas(sess) {
  if (!sess || !ehSuper(sess.realEmail || sess.email)) return { ok: false, erro: 'Acesso restrito.' };
  try { return await _empresas(); }
  catch (e) { console.error('EMPRESAS_FALHOU', e.message.slice(0, 300)); return { ok: false, erro: `Não conseguimos listar agora (${e.message.slice(0, 140)}).` }; }
}
async function _empresas() {
  const docs = [];
  let cursor = '0';
  do {
    const [c, keys] = await redis().scan(cursor, 'MATCH', 'ac:org:*:usuarios', 'COUNT', 500);
    cursor = c;
    for (const k of keys) docs.push(k.split(':')[2]);
  } while (cursor !== '0');
  // uma empresa por vez: a busca do HubSpot tem limite de chamadas por segundo
  const pagos = await negociosPagos().catch((e) => { console.error('EMPRESAS_PAGOS', e.message.slice(0, 200)); return []; });
  const orgs = [];
  for (const doc of docs) {
    const usuarios = await listarUsuarios(doc).catch(() => []);
    const ultimo = usuarios.map((u) => u.ultimoAcesso).filter(Boolean).sort().pop() || null;
    const base = { doc, oraculo: await oraculoLiberado(doc).catch(() => false), usuarios: usuarios.length, ultimoAcesso: ultimo, admins: usuarios.filter((u) => u.papel === 'admin').map((u) => u.nome || u.email) };
    try {
      const { assinatura, limite } = await limiteUsuarios(doc);
      const curadorias = await listarCuradorias(doc);
      orgs.push({ ...base, dealId: assinatura?.dealId || '', ativa: !!assinatura?.ativa, vence: assinatura?.vence || null, limite, curadorias: curadorias.length });
    } catch (e) {
      console.error('EMPRESAS_ORG', doc, e.message.slice(0, 200));
      orgs.push({ ...base, dealId: '', limite: null, curadorias: null, erro: true });
    }
  }
  const porDeal = Object.fromEntries(orgs.filter((o) => o.dealId).map((o) => [o.dealId, o]));
  const lista = pagos.map((p) => ({ nome: p.dealname || 'Sem nome', closedate: p.closedate, ...(porDeal[p.dealId] || { dealId: p.dealId, oraculo: false, usuarios: 0, limite: Number(p.quantidade_usuarios) || 1, curadorias: null, ultimoAcesso: null, admins: [] }) }));
  // empresas com usuários mas cujo negócio não está mais em Pago (expiradas ou movidas)
  for (const o of orgs) if (!o.dealId || !pagos.some((p) => p.dealId === o.dealId)) lista.push({ nome: `Documento ${o.doc}`, ...o });
  return { ok: true, empresas: lista };
}

// abre uma sessão de suporte (somente leitura) na empresa do negócio/documento
export async function entrarComoSuporte(sess, b) {
  if (!sess || !ehSuper(sess.realEmail || sess.email)) return { ok: false, erro: 'Acesso restrito.' };
  let doc = normalizaDocumento(b.doc)?.valor || '';
  if (!doc && b.dealId) doc = await documentoDoNegocio(String(b.dealId).replace(/\D/g, ''));
  if (!doc) return { ok: false, erro: 'Não achamos o CPF/CNPJ dessa empresa no HubSpot (contato ou empresa do negócio).' };
  const t = token();
  await redis().set(kSessao(t), JSON.stringify({ suporte: true, doc, realEmail: normEmail(sess.realEmail || sess.email), realNome: sess.realNome || sess.nome || '' }), 'EX', SUPORTE_S);
  return { ok: true, sessao: t, doc };
}

// ── sessão ──────────────────────────────────────────────────────────────────
async function abrirSessao(doc, email) {
  const t = token();
  await redis().set(kSessao(t), JSON.stringify({ email, doc }), 'EX', SESSAO_S);
  return t;
}

// Valida a sessão e devolve { doc, email, nome, papel } — ou null. Usuário removido perde
// o acesso na hora (a sessão aponta pra um e-mail que não está mais na empresa).
export async function lerSessao(t) {
  if (!t || typeof t !== 'string' || t.length > 100) return null;
  const v = await redis().get(kSessao(t));
  if (!v) return null;
  let s; try { s = JSON.parse(v); } catch (e) { return null; }
  // sessão de suporte: admin da empresa, somente leitura, sem existir na lista de usuários
  if (s.suporte) {
    if (!ehSuper(s.realEmail)) return null;
    return { doc: s.doc, email: s.realEmail, nome: 'Suporte PSA', celular: 'suporte', papel: 'admin', suporte: true, realEmail: s.realEmail, realNome: s.realNome };
  }
  const u = await lerUsuario(s.doc, s.email);
  if (!u || u.status !== 'ativo') return null;
  const sup = ehSuper(u.email);
  return { doc: s.doc, email: u.email, nome: u.nome || '', celular: u.celular || '', papel: u.papel, superAdmin: sup, oraculo: sup || (await oraculoLiberado(s.doc).catch(() => false)) };
}
export const encerrarSessao = (t) => (t ? redis().del(kSessao(t)) : 0);

// trava simples contra força bruta: N tentativas por chave a cada 15 min
async function excedeu(chave, max) {
  const k = `ac:tent:${chave}`;
  const n = await redis().incr(k);
  if (n === 1) await redis().expire(k, 900);
  return n > max;
}

// ── fluxos ──────────────────────────────────────────────────────────────────
export async function login(emailBruto, senha) {
  const email = normEmail(emailBruto);
  if (!emailValido(email)) return { ok: false, erro: 'Informe um e-mail válido.' };
  if (await excedeu(`login:${email}`, 10)) return { ok: false, erro: 'Muitas tentativas. Espere 15 minutos.' };
  const doc = await redis().get(kUsuario(email));
  const u = doc ? await lerUsuario(doc, email) : null;
  // senha em branco é permitida: é o jeito de quem ainda não tem senha pedir o link
  if (!senha && u && u.status === 'ativo') return { ok: false, erro: 'Informe sua senha.' };
  if (!u || !u.senha || !senha || !confereSenha(senha, u.senha)) {
    // Cliente de antes dos usuários (ou convidado que ainda não ativou): em vez de
    // "senha incorreta", manda o link de criar senha pro próprio e-mail.
    if (!u || u.status === 'pendente') {
      const auto = await primeiroAcessoPorEmail(email, doc, u);
      if (auto) return auto;
    }
    return { ok: false, erro: 'E-mail ou senha incorretos.' };
  }
  await marcarAcesso(doc, email);
  return { ok: true, sessao: await abrirSessao(doc, email), usuario: publico(u) };
}

// link do e-mail (convite ou redefinição): mostra pra quem é, antes de pedir a senha
export async function lerLink(t) {
  if (!t || t.length > 100) return null;
  const v = await redis().get(kLink(t));
  if (!v) return null;
  try { const l = JSON.parse(v); const u = await lerUsuario(l.doc, l.email); return u ? { ...l, nome: u.nome || '', celular: u.celular || '' } : null; }
  catch (e) { return null; }
}

export async function definirSenha(t, senha, celularBruto) {
  const l = await lerLink(t);
  if (!l) return { ok: false, erro: 'Este link expirou ou já foi usado. Peça um novo.' };
  const celular = celularBruto ? normCelular(celularBruto) : '';
  if (celularBruto && !celular) return { ok: false, erro: ERRO_CELULAR };
  const fraca = senhaFraca(senha);
  if (fraca) return { ok: false, erro: fraca };
  const u = await lerUsuario(l.doc, l.email);
  if (!u) return { ok: false, erro: 'Este acesso foi removido pelo administrador.' };
  if (!celular && !u.celular) return { ok: false, erro: 'Informe seu celular com DDD.' };
  if (celular && celular !== u.celular) { u.celular = celular; await celularNoContato(u.email, celular); }
  u.senha = hashSenha(senha);
  u.status = 'ativo';
  u.ativadoEm = u.ativadoEm || new Date().toISOString();
  await gravarUsuario(l.doc, u);
  await redis().del(kLink(t));
  await marcarAcesso(l.doc, u.email);
  return { ok: true, sessao: await abrirSessao(l.doc, u.email), usuario: publico(u) };
}

// "Esqueci a senha": sempre responde igual (não revela se o e-mail existe)
export async function esqueciSenha(emailBruto) {
  const email = normEmail(emailBruto);
  const resposta = { ok: true, msg: 'Se este e-mail tiver acesso, você vai receber um link para criar uma nova senha.' };
  if (!emailValido(email) || await excedeu(`esqueci:${email}`, 3)) return resposta;
  const doc = await redis().get(kUsuario(email));
  const u = doc ? await lerUsuario(doc, email) : null;
  if (!u) return resposta;
  const l = await criarLink(doc, email, u.status === 'ativo' ? 'senha' : 'convite');
  await enviarLinkPorEmail({ email, nome: u.nome, url: l.url, tipo: u.status === 'ativo' ? 'redefinir_senha' : 'convite' });
  return resposta;
}

// Primeiro acesso da empresa: o CPF/CNPJ da compra manda o link pro e-mail do COMPRADOR
// (que vira admin). É só por e-mail: quem sabe o CNPJ mas não lê a caixa do comprador não entra.
const mascara = (e) => e.replace(/^(.)(.*)(.@.*)$/, (_, a, m, z) => a + '*'.repeat(Math.min(m.length, 6)) + z);
export async function primeiroAcesso(documento) {
  const d = normalizaDocumento(documento);
  if (!d) return { ok: false, erro: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).' };
  if (await excedeu(`primeiro:${d.valor}`, 3)) return { ok: false, erro: 'Já enviamos o link. Confira sua caixa de entrada (e o spam).' };
  const { assinatura, limite } = await limiteUsuarios(d.valor);
  if (!assinatura) return { ok: false, motivo: 'nao_encontrado', erro: 'Não encontramos uma assinatura para este CPF/CNPJ.' };
  const c = await dadosContato(assinatura.contatoId);
  return linkDoComprador(d.valor, normEmail(c.email), c.nome || '', limite);
}

// núcleo do primeiro acesso: garante o comprador como admin (pendente) e manda o link
async function linkDoComprador(doc, email, nome, limite) {
  if (!emailValido(email)) return { ok: false, erro: 'A compra não tem e-mail cadastrado. Fale com a PSA.' };
  const outro = await redis().get(kUsuario(email));
  if (outro && outro !== doc) return { ok: false, erro: 'Este e-mail já está ligado a outra empresa. Fale com a PSA.' };
  let u = await lerUsuario(doc, email);
  if (!u) {
    const usados = (await listarUsuarios(doc)).length;
    if (usados >= limite) return { ok: false, erro: 'Sua empresa já usou todos os acessos. Peça a um administrador para te convidar.' };
    u = { email, nome: nome || '', papel: 'admin', status: 'pendente', criadoEm: new Date().toISOString(), convidadoPor: 'compra' };
    await gravarUsuario(doc, u);
  }
  const l = await criarLink(doc, email, u.status === 'ativo' ? 'senha' : 'convite');
  const env = await enviarLinkPorEmail({ email, nome: u.nome, url: l.url, tipo: u.status === 'ativo' ? 'redefinir_senha' : 'convite' });
  if (!env.enviado) return { ok: false, erro: 'Não conseguimos enviar o e-mail agora. Tente de novo em instantes.' };
  return { ok: true, email: mascara(email), msg: `Enviamos um link de acesso para ${mascara(email)}.` };
}

// Login de quem ainda não tem senha. Dois casos:
//  - convidado pendente: reenvia o convite (mesma empresa, mesmo papel);
//  - cliente de antes dos usuários: o e-mail é de um contato com CPF/CNPJ que tem
//    assinatura -> vira admin pendente da empresa e recebe o link.
// Devolve { ok:false, motivo:'primeiro_acesso', msg } (o front mostra como aviso) ou null.
async function primeiroAcessoPorEmail(email, docConhecido, pendente) {
  try {
    if (await excedeu(`primeiro-email:${email}`, 3)) {
      return { ok: false, motivo: 'primeiro_acesso', msg: 'Já enviamos o link de criar senha para este e-mail. Confira sua caixa de entrada (e o spam).' };
    }
    const aviso = (r) => (r && r.ok
      ? { ok: false, motivo: 'primeiro_acesso', msg: `Este é seu primeiro acesso: enviamos um link para ${r.email} criar sua senha.` }
      : r);
    if (pendente && docConhecido) {
      const l = await criarLink(docConhecido, email, 'convite');
      const env = await enviarLinkPorEmail({ email, nome: pendente.nome, url: l.url, tipo: 'convite' });
      return env.enviado ? aviso({ ok: true, email: mascara(email) }) : null;
    }
    const busca = await hs('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'firstname', 'lastname', 'cpf', 'cnpj'], limit: 1,
    });
    const c = busca.results?.[0]?.properties;
    if (!c) return null;
    // documentos possíveis: cnpj/cpf do contato e o cnpj das empresas associadas a ele
    const docs = [c.cnpj, c.cpf];
    try {
      const a = await hs(`/crm/v4/objects/contacts/${busca.results[0].id}/associations/companies`, 'GET');
      for (const r of (a.results || []).slice(0, 5)) {
        const emp = await hs(`/crm/v3/objects/companies/${r.toObjectId}?properties=cnpj`, 'GET');
        if (emp.properties?.cnpj) docs.push(emp.properties.cnpj);
      }
    } catch (e) { console.error('empresas do contato falhou:', e.message); }
    for (const bruto of docs) {
      const d = normalizaDocumento(bruto);
      if (!d) continue;
      const { assinatura, limite } = await limiteUsuarios(d.valor);
      if (!assinatura) continue;
      const nome = [c.firstname, c.lastname].filter(Boolean).join(' ').trim();
      return aviso(await linkDoComprador(d.valor, email, nome, limite));
    }
    return null;
  } catch (e) {
    console.error('PRIMEIRO_ACESSO_EMAIL_FALHOU', email, e.message.slice(0, 200));
    return null;
  }
}

// ── gestão (só admin) ───────────────────────────────────────────────────────
export async function gerenciar(sess, acao, b = {}) {
  if (!sess || sess.papel !== 'admin') return { ok: false, erro: 'Só administradores gerenciam usuários.' };
  if (sess.suporte && acao !== 'listar') return { ok: false, erro: 'Modo suporte: somente leitura.' };
  const doc = sess.doc;
  const email = normEmail(b.email);
  const papel = b.papel === 'admin' ? 'admin' : 'usuario';

  if (acao === 'listar') {
    const [usuarios, { limite }, curadorias] = await Promise.all([listarUsuarios(doc), limiteUsuarios(doc), listarCuradorias(doc)]);
    // quantas curadorias (visíveis na lista da empresa) cada usuário criou
    const porAutor = {};
    for (const c of curadorias) { const e = c.autor?.email; if (e) porAutor[e] = (porAutor[e] || 0) + 1; }
    return { ok: true, usuarios: usuarios.map((u) => ({ ...publico(u), curadorias: porAutor[u.email] || 0 })), limite, usados: usuarios.length };
  }

  if (acao === 'convidar') {
    if (!emailValido(email)) return { ok: false, erro: 'E-mail inválido.' };
    const nome = String(b.nome || '').trim().slice(0, 120);
    if (!nome) return { ok: false, erro: 'Informe o nome.' };
    const celular = b.celular ? normCelular(b.celular) : '';
    if (b.celular && !celular) return { ok: false, erro: ERRO_CELULAR };
    const outro = await redis().get(kUsuario(email));
    if (outro && outro !== doc) return { ok: false, erro: 'Este e-mail já tem acesso por outra empresa.' };
    if (await lerUsuario(doc, email)) return { ok: false, erro: 'Este e-mail já está na lista.' };
    const [usuarios, { limite }] = await Promise.all([listarUsuarios(doc), limiteUsuarios(doc)]);
    if (usuarios.length >= limite) return { ok: false, erro: `Sua empresa já usa os ${limite} acessos contratados. Remova alguém ou fale com a PSA para ampliar.` };
    const u = { email, nome, ...(celular ? { celular } : {}), papel, status: 'pendente', criadoEm: new Date().toISOString(), convidadoPor: sess.email };
    await gravarUsuario(doc, u);
    const l = await criarLink(doc, email, 'convite');
    const env = await enviarLinkPorEmail({ email, nome, url: l.url, tipo: 'convite', convidadoPor: sess.nome || sess.email, celular });
    return { ok: true, usuario: publico(u), enviado: env.enviado, link: l.url };
  }

  const alvo = email ? await lerUsuario(doc, email) : null;
  if (!alvo) return { ok: false, erro: 'Usuário não encontrado.' };
  const admins = (await listarUsuarios(doc)).filter((u) => u.papel === 'admin' && u.email !== email).length;

  if (acao === 'reenviar') {
    const tipo = alvo.status === 'ativo' ? 'senha' : 'convite';
    const l = await criarLink(doc, email, tipo);
    const env = await enviarLinkPorEmail({ email, nome: alvo.nome, url: l.url, tipo: tipo === 'senha' ? 'redefinir_senha' : 'convite', convidadoPor: sess.nome || sess.email });
    return { ok: true, enviado: env.enviado, link: l.url };
  }
  if (acao === 'celular') {
    const celular = normCelular(b.celular);
    if (!celular) return { ok: false, erro: ERRO_CELULAR };
    alvo.celular = celular;
    await gravarUsuario(doc, alvo);
    await celularNoContato(alvo.email, celular);
    return { ok: true, usuario: publico(alvo) };
  }
  if (acao === 'papel') {
    if (alvo.papel === 'admin' && papel !== 'admin' && !admins) return { ok: false, erro: 'A empresa precisa ter pelo menos um administrador.' };
    alvo.papel = papel;
    await gravarUsuario(doc, alvo);
    return { ok: true, usuario: publico(alvo) };
  }
  if (acao === 'remover') {
    if (alvo.papel === 'admin' && !admins) return { ok: false, erro: 'A empresa precisa ter pelo menos um administrador.' };
    await redis().hdel(kUsuarios(doc), email);
    await redis().del(kUsuario(email));
    return { ok: true };
  }
  return { ok: false, erro: 'ação inválida' };
}
