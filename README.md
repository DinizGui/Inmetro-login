# Demo — Login automático INMETRO

Site simples pra mostrar na mentoria **como o login automático no portal INMETRO**
(`cronotacografo.rbmlq.gov.br`) funciona por HTTP puro (headless, sem abrir navegador).

Replica o fluxo que roda em produção no `sga-moss` (`lib/inmetro/auth.ts`).

## Fluxo (é o que aparece na tela)

1. **GET `/usuarios/login`** → pega o cookie `PHPSESSID` da sessão anônima.
2. **CapSolver** → resolve o reCAPTCHA v2 (site key pública do portal) e devolve um token.
3. **POST `/usuarios/login`** com `data[Usuario][username]`, `data[Usuario][password]` e
   `g-recaptcha-response`.
4. Resposta **302 → `/informativos/consultar`** = logado. Esse `PHPSESSID` autenticado é o
   que as consultas seguintes (veículos, selagens, GRUs) reusam.

## Rodar

```bash
cd inmetro-login-demo
npm install
cp .env.example .env   # preencha INMETRO_USER, INMETRO_PASSWORD, CAPSOLVER_KEY
npm start
```

Abra http://localhost:3777 e clique em **Logar automaticamente**.
Se não quiser usar o `.env`, dá pra digitar usuário/senha/chave direto na tela.

## Observações

- Senha, token do captcha e `PHPSESSID` aparecem **mascarados** na tela (seguro pra projetar).
- É o login real: bate no portal do governo com as credenciais da empresa. Use as suas.
- Em produção o sga-moss ainda passa por um proxy residencial BR e tem cache de sessão /
  relogin automático — aqui foi deixado só o essencial do login pra ficar didático.
