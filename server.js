/**
 * Servidor local da demo (desenvolvimento). Na Vercel nao e usado: la cada
 * rota /api/* vira uma funcao serverless (pasta api/). A logica de login fica
 * em lib/inmetro-login.js, compartilhada pelos dois.
 *
 * Rodar local:  npm install && npm start  -> http://localhost:3777
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const { doLogin } = require('./lib/inmetro-login');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // serve index.html da raiz

app.get('/api/config', (_req, res) => {
  res.json({
    hasUser: !!process.env.INMETRO_USER,
    hasPassword: !!process.env.INMETRO_PASSWORD,
    hasCapsolver: !!process.env.CAPSOLVER_KEY,
    hasProxy: !!process.env.INMETRO_PROXY_URL,
    envUser: process.env.INMETRO_USER || '',
  });
});

app.post('/api/login', async (req, res) => {
  const username = (req.body && req.body.username) || process.env.INMETRO_USER;
  const password = (req.body && req.body.password) || process.env.INMETRO_PASSWORD;
  const capsolverKey = (req.body && req.body.capsolverKey) || process.env.CAPSOLVER_KEY;

  if (!username || !password)
    return res.status(400).json({ ok: false, error: 'Faltou usuario/senha do INMETRO (preencha na tela ou no .env).' });
  if (!capsolverKey)
    return res.status(400).json({ ok: false, error: 'Faltou a chave do CapSolver (CAPSOLVER_KEY no .env ou na tela).' });

  try {
    res.json(await doLogin({ username, password, capsolverKey }));
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

const PORT = process.env.PORT || 3777;
app.listen(PORT, () => console.log(`\n  INMETRO login demo em http://localhost:${PORT}\n`));
