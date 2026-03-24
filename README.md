# Site Consultor de Investimentos

Site profissional para venda de ebook e consultorias de investimento, com integração Stripe.

## Stack
- **Backend**: Node.js + Express
- **Pagamentos**: Stripe Checkout + Webhooks
- **Frontend**: HTML/CSS/JS puro (sem framework)

---

## Instalação

```bash
# 1. Instale as dependências
npm install

# 2. Configure as variáveis de ambiente
cp .env.example .env
# Edite o arquivo .env com seus dados reais

# 3. Inicie o servidor
npm start

# Ou em modo desenvolvimento (reinicia automaticamente)
npm run dev
```

---

## Configuração do Stripe

### 1. Crie uma conta Stripe
Acesse https://dashboard.stripe.com e crie sua conta.

### 2. Obtenha suas chaves de API
Em **Developers → API Keys**:
- Copie a **Publishable key** (`pk_live_...`) → `STRIPE_PUBLISHABLE_KEY`
- Copie a **Secret key** (`sk_live_...`) → `STRIPE_SECRET_KEY`

> ⚠️ Use as chaves de **teste** (`pk_test_...` / `sk_test_...`) durante o desenvolvimento.

### 3. Crie os produtos no Stripe
Em **Products**, crie:
1. **Ebook** — valor R$ 39,90 — pagamento único
2. **Consultoria Avulsa** — seu valor — pagamento único
3. **Consultoria Mensal** — seu valor — assinatura recorrente

Copie o **Price ID** de cada produto (começa com `price_`) para o `.env`.

### 4. Configure o Webhook
Em **Developers → Webhooks**, adicione um endpoint:
- URL: `https://seusite.com.br/webhook`
- Eventos: `checkout.session.completed`, `payment_intent.payment_failed`

Copie o **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`

---

## Personalização

### Substituir informações pessoais
Abra `public/index.html` e substitua:
- `[Seu Nome]` pelo seu nome
- `seuemail@email.com` pelo seu e-mail
- `(XX) XXXXX-XXXX` pelo seu WhatsApp
- Número de registro na CVM
- Estatísticas na seção hero (clientes, anos de mercado, etc.)
- Preços das consultorias

### Adicionar capa do ebook
1. Salve a imagem da capa em `public/img/capa-ebook.jpg`
2. No `index.html`, dentro de `.ebook-cover-img`, substitua o bloco placeholder por:
```html
<img src="/img/capa-ebook.jpg" alt="Capa do ebook" />
```

### Adicionar sua foto
Na seção `#sobre`, substitua `.sobre-photo-frame` por:
```html
<img src="/img/foto.jpg" alt="[Seu Nome]" style="width:100%; height:100%; object-fit:cover;" />
```

---

## Formulário de contato

O formulário de contato precisa de uma integração para enviar e-mails.

**Opção mais simples — Formspree (gratuito):**
1. Crie conta em https://formspree.io
2. Crie um novo formulário e copie o endpoint
3. No `server.js`, adicione uma rota POST `/contato` que repasse para o Formspree,
   ou simplesmente adicione o `action="https://formspree.io/f/XXXXXXXX"` diretamente no `<form>` do HTML.

**Opção com backend próprio:**
Instale o `nodemailer` e configure com seu servidor SMTP (Gmail, SendGrid, etc.).

---

## Entrega do ebook após compra

No `server.js`, no case `checkout.session.completed` do webhook, implemente a lógica de entrega:
```js
case 'checkout.session.completed': {
  const session = event.data.object;
  // Verificar qual produto foi comprado via session.metadata ou line_items
  // Enviar e-mail com link para download
  await enviarEmailComEbook(session.customer_details.email);
  break;
}
```

---

## Deploy

Opções recomendadas:
- **Railway** — deploy simples com `railway up`
- **Render** — free tier disponível
- **VPS (DigitalOcean, Hetzner)** — mais controle, use PM2 para manter o processo ativo

Lembre de configurar as variáveis de ambiente na plataforma escolhida.
