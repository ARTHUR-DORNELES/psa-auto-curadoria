import crypto from 'node:crypto';
import { redis, hs, assinaturaAtivaPorDocumento, dadosContato, normalizaDocumento, listarCuradorias } from './_lib.js';

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
export const publico = (u) => ({ email: u.email, nome: u.nome || '', papel: u.papel, status: u.status, criadoEm: u.criadoEm || null, ultimoAcesso: u.ultimoAcesso || null });

// "Último acesso": gravado no login, ao criar a senha e a cada abertura do painel.
// Só regrava se passou 10 min (evita escrever no Redis a cada clique). Nunca lança.
export async function marcarAcesso(doc, email) {
  try {
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
export async function enviarLinkPorEmail({ email, nome, url, tipo, convidadoPor }) {
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
      properties: { [PROP_LINK]: url, [PROP_TIPO]: tipo, [PROP_CONVIDOU]: convidadoPor || '' },
    });
    return { enviado: true, contatoId };
  } catch (e) {
    console.error('ENVIO_LINK_FALHOU', email, e.message.slice(0, 300));
    return { enviado: false };
  }
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
  const u = await lerUsuario(s.doc, s.email);
  if (!u || u.status !== 'ativo') return null;
  return { doc: s.doc, email: u.email, nome: u.nome || '', papel: u.papel };
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
  try { const l = JSON.parse(v); const u = await lerUsuario(l.doc, l.email); return u ? { ...l, nome: u.nome || '' } : null; }
  catch (e) { return null; }
}

export async function definirSenha(t, senha) {
  const l = await lerLink(t);
  if (!l) return { ok: false, erro: 'Este link expirou ou já foi usado. Peça um novo.' };
  const fraca = senhaFraca(senha);
  if (fraca) return { ok: false, erro: fraca };
  const u = await lerUsuario(l.doc, l.email);
  if (!u) return { ok: false, erro: 'Este acesso foi removido pelo administrador.' };
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
    for (const bruto of [c.cnpj, c.cpf]) {
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
    const outro = await redis().get(kUsuario(email));
    if (outro && outro !== doc) return { ok: false, erro: 'Este e-mail já tem acesso por outra empresa.' };
    if (await lerUsuario(doc, email)) return { ok: false, erro: 'Este e-mail já está na lista.' };
    const [usuarios, { limite }] = await Promise.all([listarUsuarios(doc), limiteUsuarios(doc)]);
    if (usuarios.length >= limite) return { ok: false, erro: `Sua empresa já usa os ${limite} acessos contratados. Remova alguém ou fale com a PSA para ampliar.` };
    const u = { email, nome, papel, status: 'pendente', criadoEm: new Date().toISOString(), convidadoPor: sess.email };
    await gravarUsuario(doc, u);
    const l = await criarLink(doc, email, 'convite');
    const env = await enviarLinkPorEmail({ email, nome, url: l.url, tipo: 'convite', convidadoPor: sess.nome || sess.email });
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
