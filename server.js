'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { criarArmazenamento } = require('./storage');

const PORT = process.env.PORT || 3000;
/* Senhas que abrem o app: APP_PASSWORDS="Ana,Guilherme" (separadas por vírgula). APP_PASSWORD (uma só) continua funcionando. */
const SENHAS = (process.env.APP_PASSWORDS || process.env.APP_PASSWORD || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
if (!SENHAS.length || SENHAS.some((x) => x.length < 3)) {
  console.error('Defina a variável APP_PASSWORDS com as senhas separadas por vírgula (cada uma com pelo menos 3 caracteres). Exemplo: Ana,Guilherme');
  process.exit(1);
}
const SEGREDO = process.env.SESSION_SECRET || crypto.createHash('sha256').update('gastos|' + SENHAS.join('|')).digest('hex');
const COOKIE = 'gc_sessao';
const HORAS = 12; /* a senha não fica salva: o acesso vale no máximo 12h, e o cookie some ao fechar o app/navegador */

/* ---------- sessão por cookie assinado ---------- */
function assinar(valor) {
  return crypto.createHmac('sha256', SEGREDO).update(valor).digest('hex');
}
function criarToken() {
  const exp = String(Date.now() + HORAS * 3600000);
  return exp + '.' + assinar(exp);
}
function tokenValido(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 1) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  const esperado = assinar(exp);
  if (sig.length !== esperado.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return false;
  return Number(exp) > Date.now();
}
function lerCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function autenticado(req) {
  return tokenValido(lerCookies(req)[COOKIE]);
}
function gravarCookie(req, res, token, maxAge) {
  const partes = [COOKIE + '=' + encodeURIComponent(token), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge === 0) partes.push('Max-Age=0'); /* sem Max-Age = cookie de sessão (some ao fechar) */
  if (req.secure) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}
function senhaCorreta(tentativa) {
  const a = crypto.createHash('sha256').update(String(tentativa).trim()).digest();
  let ok = false;
  SENHAS.forEach((senha) => {
    const b = crypto.createHash('sha256').update(senha).digest();
    if (crypto.timingSafeEqual(a, b)) ok = true;
  });
  return ok;
}

/* limite simples de tentativas de senha por IP */
const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() > t.ate) { tentativas.delete(ip); return false; }
  return t.n >= 8;
}
function falhou(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() > t.ate) tentativas.set(ip, { n: 1, ate: Date.now() + 10 * 60000 });
  else t.n++;
}

/* ---------- validação ---------- */
const GRUPOS = ['fixo', 'variavel'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_LINHAS = 20000;
const MAX_VALOR = 100000000000;

function limparLinha(b, parcial) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Corpo inválido.');
  const out = {};
  if (!parcial || 'nome' in b) {
    if (typeof b.nome !== 'string' || !b.nome.trim() || b.nome.trim().length > 120) throw new Error('Nome inválido.');
    out.nome = b.nome.trim();
  }
  if (!parcial || 'grupo' in b) {
    if (!GRUPOS.includes(b.grupo)) throw new Error('Grupo inválido.');
    out.grupo = b.grupo;
  }
  if (!parcial || 'mes' in b) {
    if (typeof b.mes !== 'string' || !MES_RE.test(b.mes)) throw new Error('Mês inválido.');
    out.mes = b.mes;
  }
  if (!parcial || 'valorCentavos' in b) {
    if (!Number.isInteger(b.valorCentavos) || b.valorCentavos < 0 || b.valorCentavos > MAX_VALOR) throw new Error('Valor inválido.');
    out.valorCentavos = b.valorCentavos;
  }
  if ('pago' in b) {
    if (typeof b.pago !== 'boolean') throw new Error('Campo pago inválido.');
    out.pago = b.pago;
  } else if (!parcial) {
    out.pago = false;
  }
  if ('fixa' in b) {
    if (typeof b.fixa !== 'boolean') throw new Error('Campo fixa inválido.');
    out.fixa = b.fixa;
  }
  if ('pagoEm' in b) {
    if (typeof b.pagoEm !== 'string' || (b.pagoEm !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(b.pagoEm))) throw new Error('Data de pagamento inválida.');
    out.pagoEm = b.pagoEm;
  }
  if ('itens' in b) {
    if (!Array.isArray(b.itens) || b.itens.length > 300) throw new Error('Gastos inválidos.');
    const vistos = new Set();
    out.itens = b.itens.map((x) => {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID_RE.test(x.id) || vistos.has(x.id)) throw new Error('Gasto inválido.');
      vistos.add(x.id);
      if (typeof x.data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.data)) throw new Error('Data inválida.');
      if (!Number.isInteger(x.valorCentavos) || x.valorCentavos < 0 || x.valorCentavos > MAX_VALOR) throw new Error('Valor do gasto inválido.');
      const nota = x.nota === undefined || x.nota === null ? '' : x.nota;
      if (typeof nota !== 'string' || nota.length > 60) throw new Error('Descrição inválida.');
      return { id: x.id, data: x.data, valorCentavos: x.valorCentavos, nota: nota };
    });
  }
  if ('criado' in b) {
    if (typeof b.criado !== 'number' || !Number.isFinite(b.criado)) throw new Error('Campo criado inválido.');
    out.criado = b.criado;
  } else if (!parcial) {
    out.criado = Date.now();
  }
  return out;
}

async function iniciar() {
  const armazenamento = await criarArmazenamento();
  let estado = await armazenamento.carregar();
  let fila = Promise.resolve();
  function persistir() {
    estado.rev++;
    const copia = JSON.stringify(estado);
    fila = fila.then(() => armazenamento.salvar(JSON.parse(copia))).catch((e) => console.error('Falha ao salvar:', e));
    return fila;
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
    );
    next();
  });

  app.get('/saude', (req, res) => res.type('text').send('ok'));

  /* login */
  const loginHtml = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');
  app.get('/login', (req, res) => {
    if (autenticado(req)) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(loginHtml.replace('__ERRO__', req.query.e === '1' ? 'Senha incorreta. Tente de novo.' : req.query.e === '2' ? 'Muitas tentativas. Aguarde alguns minutos.' : ''));
  });
  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const ip = req.ip || 'x';
    if (bloqueado(ip)) return res.redirect('/login?e=2');
    if (senhaCorreta((req.body && (req.body['gc-chave'] || req.body.senha)) || '')) {
      tentativas.delete(ip);
      gravarCookie(req, res, criarToken());
      return res.redirect('/');
    }
    falhou(ip);
    res.redirect('/login?e=1');
  });
  app.post('/sair', (req, res) => {
    gravarCookie(req, res, '', 0);
    res.redirect('/login');
  });

  /* arquivos públicos: manifest, service worker, ícones */
  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders(res, file) {
        if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
        else if (file.endsWith('.png')) res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    })
  );

  /* a partir daqui, só com senha */
  app.use((req, res, next) => {
    if (autenticado(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'login' });
    res.redirect('/login');
  });

  /* fotos da casa e das cachorras: só aparecem depois do login */
  app.use('/fotos', express.static(path.join(__dirname, 'views', 'fotos'), {
    index: false,
    setHeaders(res) { res.setHeader('Cache-Control', 'private, max-age=86400'); }
  }));

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  });

  const api = express.Router();
  api.use(express.json({ limit: '400kb' }));

  api.get('/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      rev: estado.rev,
      renda: estado.renda,
      linhas: Object.keys(estado.linhas).map((id) => Object.assign({ id }, estado.linhas[id]))
    });
  });

  api.put('/renda', async (req, res) => {
    const v = req.body && req.body.salarioCentavos;
    if (!Number.isInteger(v) || v < 0 || v > MAX_VALOR) return res.status(400).json({ erro: 'Valor inválido.' });
    estado.renda = v;
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.put('/linhas/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
    let doc;
    try { doc = limparLinha(req.body, false); } catch (e) { return res.status(400).json({ erro: e.message }); }
    if (!(req.params.id in estado.linhas) && Object.keys(estado.linhas).length >= MAX_LINHAS) return res.status(400).json({ erro: 'Limite de linhas atingido.' });
    estado.linhas[req.params.id] = doc;
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.patch('/linhas/:id', async (req, res) => {
    const atual = estado.linhas[req.params.id];
    if (!ID_RE.test(req.params.id) || !atual) return res.status(404).json({ erro: 'Linha não encontrada.' });
    let parte;
    try { parte = limparLinha(req.body, true); } catch (e) { return res.status(400).json({ erro: e.message }); }
    estado.linhas[req.params.id] = Object.assign({}, atual, parte);
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.delete('/linhas/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
    delete estado.linhas[req.params.id];
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.post('/linhas/lote', async (req, res) => {
    const lista = req.body && req.body.linhas;
    if (!Array.isArray(lista) || lista.length < 1 || lista.length > 100) return res.status(400).json({ erro: 'Lote inválido.' });
    const novos = [];
    try {
      lista.forEach((item) => {
        if (!item || !ID_RE.test(item.id)) throw new Error('Id inválido.');
        novos.push([item.id, limparLinha(item, false)]);
      });
    } catch (e) { return res.status(400).json({ erro: e.message }); }
    if (Object.keys(estado.linhas).length + novos.length > MAX_LINHAS) return res.status(400).json({ erro: 'Limite de linhas atingido.' });
    novos.forEach(([id, doc]) => { estado.linhas[id] = doc; });
    await persistir();
    res.json({ rev: estado.rev });
  });

  app.use('/api', api);

  app.use((req, res) => res.status(404).type('text').send('Não encontrado.'));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno.' });
  });

  app.listen(PORT, () => console.log('Gastos da Casa rodando na porta ' + PORT + ' | dados: ' + armazenamento.tipo));
}

iniciar().catch((e) => {
  console.error('Não foi possível iniciar:', e);
  process.exit(1);
});
