// Funcao serverless (Vercel): diz pro front o que ja veio por env var.
module.exports = (_req, res) => {
  res.json({
    hasUser: !!process.env.INMETRO_USER,
    hasPassword: !!process.env.INMETRO_PASSWORD,
    hasCapsolver: !!process.env.CAPSOLVER_KEY,
    hasProxy: !!process.env.INMETRO_PROXY_URL,
    envUser: process.env.INMETRO_USER || '',
  });
};
