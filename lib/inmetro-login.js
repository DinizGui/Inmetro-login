/**
 * Core do login automatico no portal INMETRO (cronotacografo.rbmlq.gov.br).
 * Usado tanto pelo server local (server.js) quanto pelas funcoes serverless
 * da Vercel (api/login.js). Replica o fluxo de producao do sga-moss
 * (lib/inmetro/auth.ts + capsolver.ts).
 *
 *   1. GET  /usuarios/login   -> sessao anonima (cookie PHPSESSID)
 *   2. CapSolver              -> resolve o reCAPTCHA v2, devolve o token
 *   3. POST /usuarios/login   -> usuario + senha + g-recaptcha-response
 *   4. 302 -> /informativos/consultar = logado (PHPSESSID autenticado)
 */

const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');

const INMETRO_BASE_URL = 'https://cronotacografo.rbmlq.gov.br';
const LOGIN_PATH = '/usuarios/login';
const POST_LOGIN_REDIRECT = '/informativos/consultar';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const CAPSOLVER_BASE_URL = 'https://api.capsolver.com';
const LOGIN_RECAPTCHA = {
  websiteURL: `${INMETRO_BASE_URL}${LOGIN_PATH}`,
  websiteKey: '6LfLUiIoAAAAAOdvfl5vVSxq6U6xNKi56CWYH-wL',
};

// Agent SOCKS que resolve o DNS do destino NO NODE antes de entregar pro proxy.
// Varios provedores residenciais (ex: IPRoyal) tem o dominio .gov.br em blocklist
// de DNS, entao resolver remotamente pelo proxy falha. A gente resolve o IPv4
// localmente, manda o IP pro SOCKS e mantem o SNI/Host originais (igual o
// LocalDnsSocksAgent da producao do sga-moss).
let _LocalDnsSocksAgent = null;
function getLocalDnsSocksAgentClass() {
  if (_LocalDnsSocksAgent) return _LocalDnsSocksAgent;
  const { SocksProxyAgent } = require('socks-proxy-agent');
  class LocalDnsSocksAgent extends SocksProxyAgent {
    async connect(req, opts) {
      const host = opts && opts.host;
      if (host && !net.isIP(host)) {
        try {
          const { address } = await dns.lookup(host, { family: 4 });
          opts = Object.assign({}, opts, { host: address, servername: opts.servername || host });
        } catch (_e) {
          /* se nao resolver localmente, deixa o proxy tentar */
        }
      }
      return super.connect(req, opts);
    }
  }
  _LocalDnsSocksAgent = LocalDnsSocksAgent;
  return _LocalDnsSocksAgent;
}

// Proxy opcional (necessario fora do BR, ex: Vercel). Reaproveita o MESMO
// INMETRO_PROXY_URL da producao (socks5://user:pass@host:porta).
function buildProxyAgent() {
  const url = process.env.INMETRO_PROXY_URL;
  if (!url) return null;
  if (/^socks/i.test(url)) {
    try {
      const Cls = getLocalDnsSocksAgentClass();
      return new Cls(url);
    } catch (_e) {
      return null;
    }
  }
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(url);
  } catch (_e2) {
    return null;
  }
}

function createHttp() {
  const agent = buildProxyAgent();
  return axios.create({
    baseURL: INMETRO_BASE_URL,
    timeout: 60000,
    maxRedirects: 0,
    validateStatus: () => true,
    proxy: false,
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });
}

function extractPHPSessId(setCookie) {
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const m = /PHPSESSID=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

function mask(value, keep = 6) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= keep) return '*'.repeat(s.length);
  return s.slice(0, keep) + '…(' + (s.length - keep) + ' chars)';
}

function step(partial) {
  return {
    name: partial.name,
    status: partial.status || 'ok',
    request: partial.request || null,
    response: partial.response || null,
    note: partial.note || null,
  };
}

async function solveRecaptcha(clientKey, steps) {
  const createBody = {
    clientKey,
    task: {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: LOGIN_RECAPTCHA.websiteURL,
      websiteKey: LOGIN_RECAPTCHA.websiteKey,
    },
  };

  const createResp = await axios.post(`${CAPSOLVER_BASE_URL}/createTask`, createBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });

  const taskId = createResp.data && createResp.data.taskId;
  steps.push(
    step({
      name: '2. Resolver reCAPTCHA (CapSolver) — createTask',
      status: createResp.data && createResp.data.errorId === 0 && taskId ? 'ok' : 'erro',
      request: {
        method: 'POST',
        url: `${CAPSOLVER_BASE_URL}/createTask`,
        headers: { 'Content-Type': 'application/json' },
        body: { clientKey: mask(clientKey), task: createBody.task },
      },
      response: { httpStatus: createResp.status, body: createResp.data },
      note: 'websiteKey e publica (fica no HTML do portal). ProxyLess = o CapSolver usa IP dele.',
    })
  );

  if (!taskId || (createResp.data && createResp.data.errorId !== 0)) {
    throw new Error(
      'CapSolver nao criou a task: ' +
        JSON.stringify(createResp.data && (createResp.data.errorDescription || createResp.data))
    );
  }

  const started = Date.now();
  let polls = 0;
  while (Date.now() - started < 90000) {
    await new Promise((r) => setTimeout(r, 4000));
    polls++;
    const res = await axios.post(
      `${CAPSOLVER_BASE_URL}/getTaskResult`,
      { clientKey, taskId },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true }
    );
    const data = res.data || {};
    if (data.status === 'ready' && data.solution && data.solution.gRecaptchaResponse) {
      const token = data.solution.gRecaptchaResponse;
      steps.push(
        step({
          name: '2. Resolver reCAPTCHA (CapSolver) — getTaskResult',
          status: 'ok',
          request: {
            method: 'POST',
            url: `${CAPSOLVER_BASE_URL}/getTaskResult`,
            headers: { 'Content-Type': 'application/json' },
            body: { clientKey: mask(clientKey), taskId },
          },
          response: {
            httpStatus: res.status,
            body: {
              errorId: data.errorId,
              status: data.status,
              solution: { gRecaptchaResponse: mask(token, 24) },
            },
          },
          note: `Resolvido em ${polls} tentativa(s) (~${Math.round((Date.now() - started) / 1000)}s). O token vai no campo g-recaptcha-response do login.`,
        })
      );
      return token;
    }
    if (data.errorId && data.errorId !== 0) {
      throw new Error('CapSolver falhou no getTaskResult: ' + JSON.stringify(data));
    }
  }
  throw new Error('CapSolver: timeout de 90s esperando o token do captcha.');
}

async function doLogin({ username, password, capsolverKey }) {
  const steps = [];
  const http = createHttp();
  const viaProxy = !!process.env.INMETRO_PROXY_URL;

  // --- Passo 1: GET sessao anonima --------------------------------------
  const getResp = await http.get(LOGIN_PATH);
  const anonSessId = extractPHPSessId(getResp.headers['set-cookie']);
  steps.push(
    step({
      name: '1. GET sessao anonima',
      status: getResp.status === 200 && anonSessId ? 'ok' : 'erro',
      request: {
        method: 'GET',
        url: `${INMETRO_BASE_URL}${LOGIN_PATH}`,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          ...(viaProxy ? { via: 'proxy BR (INMETRO_PROXY_URL)' } : {}),
        },
      },
      response: {
        httpStatus: getResp.status,
        headers: { 'set-cookie': `PHPSESSID=${mask(anonSessId)}` },
        bodyPreview: '<html> … pagina de login do portal (HTML) … </html>',
      },
      note:
        'O portal e um CakePHP legado. Aqui a gente so quer o cookie PHPSESSID da sessao anonima.' +
        (viaProxy ? ' (saindo pelo proxy BR)' : ''),
    })
  );
  if (getResp.status !== 200 || !anonSessId) {
    return { ok: false, reason: 'NO_ANONYMOUS_SESSION', steps };
  }

  // --- Passos 2 + 3 com retry (ate 3x, igual producao) ------------------
  const MAX_ATTEMPTS = 3;
  let lastReason = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      steps.push(
        step({
          name: `↻ Captcha recusado — nova tentativa (${attempt}/${MAX_ATTEMPTS})`,
          status: 'ok',
          note: 'O portal rejeitou o token do captcha. Resolvendo de novo e reenviando, igual a producao (ate 3x).',
        })
      );
    }

    const recaptchaToken = await solveRecaptcha(capsolverKey, steps);

    const form = new URLSearchParams();
    form.set('_method', 'POST');
    form.set('data[Usuario][username]', username);
    form.set('data[Usuario][password]', password);
    form.set('g-recaptcha-response', recaptchaToken);

    const postResp = await http.post(LOGIN_PATH, form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `PHPSESSID=${anonSessId}`,
        Origin: INMETRO_BASE_URL,
        Referer: `${INMETRO_BASE_URL}${LOGIN_PATH}`,
      },
    });

    const location = postResp.headers['location'] || '';
    const newSessId = extractPHPSessId(postResp.headers['set-cookie']) || anonSessId;
    const logado = postResp.status === 302 && location.includes(POST_LOGIN_REDIRECT);

    let reason = null;
    if (!logado) {
      if (postResp.status === 200) {
        const html = String(postResp.data || '').toLowerCase();
        if (html.includes('captcha') && (html.includes('inv') || html.includes('verifique') || html.includes('rob')))
          reason = 'CAPTCHA_FAILED';
        else reason = 'CREDENTIALS_INVALID';
      } else {
        reason = 'UNEXPECTED_RESPONSE';
      }
    }

    steps.push(
      step({
        name: `3. POST login (usuario + senha + captcha)${attempt > 1 ? ' — tentativa ' + attempt : ''}`,
        status: logado ? 'ok' : 'erro',
        request: {
          method: 'POST',
          url: `${INMETRO_BASE_URL}${LOGIN_PATH}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `PHPSESSID=${mask(anonSessId)}`,
            Origin: INMETRO_BASE_URL,
            Referer: `${INMETRO_BASE_URL}${LOGIN_PATH}`,
          },
          body: {
            _method: 'POST',
            'data[Usuario][username]': username,
            'data[Usuario][password]': '•••••••• (mascarado)',
            'g-recaptcha-response': mask(recaptchaToken, 24),
          },
        },
        response: {
          httpStatus: postResp.status,
          headers: {
            location: location || '(sem location)',
            'set-cookie': `PHPSESSID=${mask(newSessId)}`,
          },
          bodyPreview: logado
            ? '(302 — redireciona pro painel, sem corpo)'
            : '<html> … formulario de login re-renderizado (deu erro) … </html>',
        },
        note: logado
          ? 'Sucesso: status 302 com Location apontando pra /informativos/consultar. Esse PHPSESSID agora esta AUTENTICADO e e reaproveitado nas proximas chamadas.'
          : 'Falha: status 200 = o portal devolveu o form de novo (nao redirecionou).',
      })
    );

    if (logado) {
      return { ok: true, reason: null, phpSessId: newSessId, steps };
    }

    lastReason = reason;
    if (reason !== 'CAPTCHA_FAILED') break;
  }

  return { ok: false, reason: lastReason, phpSessId: null, steps };
}

module.exports = { doLogin };
