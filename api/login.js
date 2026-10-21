// Funcao serverless (Vercel): executa o login automatico INMETRO.
// maxDuration alto porque o CapSolver pode levar alguns segundos.
const { doLogin } = require('../lib/inmetro-login');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST.' });
    return;
  }

  const body = req.body || {};
  const username = body.username || process.env.INMETRO_USER;
  const password = body.password || process.env.INMETRO_PASSWORD;
  const capsolverKey = body.capsolverKey || process.env.CAPSOLVER_KEY;

  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'Faltou usuario/senha do INMETRO (preencha na tela ou nas env vars).' });
    return;
  }
  if (!capsolverKey) {
    res.status(400).json({ ok: false, error: 'Faltou a chave do CapSolver (CAPSOLVER_KEY nas env vars ou na tela).' });
    return;
  }

  try {
    res.json(await doLogin({ username, password, capsolverKey }));
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
