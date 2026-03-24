require("dotenv").config();

const nodemailer = require("nodemailer");
const express = require("express");
const path = require("path");
const fs = require("fs");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DIR = path.join(__dirname, "public");

// ─────────────────────────────────────────────────────────────
// CONFIG DOS PRODUTOS
// ─────────────────────────────────────────────────────────────
const products = {
  ebook: {
    priceId: process.env.STRIPE_PRICE_EBOOK,
    mode: "payment",
    productName: "Ebook Investimentos para Iniciantes",
  },
  consultoria_avulsa: {
    priceId: process.env.STRIPE_PRICE_CONSULTORIA_AVULSA,
    mode: "payment",
    productName: "Ebook + Consultoria Individual",
  },
  consultoria_mensal: {
    priceId: process.env.STRIPE_PRICE_CONSULTORIA_MENSAL,
    mode: "subscription",
    productName: "Ebook + Consultoria Contínua",
  },
};


const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 465),
  secure: String(process.env.EMAIL_SECURE) === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});


async function sendPurchaseEmail({ email, productKey, productName, sessionId }) {
  const downloadUrl = `${BASE_URL}/download-ebook?session_id=${encodeURIComponent(sessionId)}`;

  let subject = "Compra confirmada";
  let html = "";

  if (productKey === "ebook") {
    subject = "Seu ebook está disponível";
    html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2>Pagamento confirmado</h2>
        <p>Olá!</p>
        <p>Sua compra de <strong>${productName}</strong> foi confirmada.</p>
        <p>Para baixar seu ebook, clique no botão abaixo:</p>
        <p>
          <a href="${downloadUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
            Baixar ebook
          </a>
        </p>
        <p>Se tiver qualquer problema, responda este e-mail.</p>
        <p>Daniel Ferreira</p>
      </div>
    `;
  } else if (productKey === "consultoria_avulsa") {
    subject = "Compra confirmada | Ebook + Consultoria Individual";
    html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2>Pagamento confirmado</h2>
        <p>Olá!</p>
        <p>Sua compra de <strong>${productName}</strong> foi confirmada.</p>
        <p>Seu ebook já está liberado:</p>
        <p>
          <a href="${downloadUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
            Baixar ebook
          </a>
        </p>
        <p>Você receberá em até 1 dia útil as instruções para agendamento da consultoria individual.</p>
        <p>Daniel Ferreira</p>
      </div>
    `;
  } else if (productKey === "consultoria_mensal") {
    subject = "Assinatura confirmada | Ebook + Consultoria Contínua";
    html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2>Assinatura ativada</h2>
        <p>Olá!</p>
        <p>Sua assinatura de <strong>${productName}</strong> foi ativada com sucesso.</p>
        <p>Seu ebook já está liberado:</p>
        <p>
          <a href="${downloadUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
            Baixar ebook
          </a>
        </p>
        <p>Você receberá por e-mail os próximos passos do acompanhamento contínuo.</p>
        <p>Daniel Ferreira</p>
      </div>
    `;
  } else {
    html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2>Pagamento confirmado</h2>
        <p>Sua compra foi confirmada com sucesso.</p>
      </div>
    `;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject,
    html,
  });
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK STRIPE
// IMPORTANTE: precisa vir antes do express.json()
// ─────────────────────────────────────────────────────────────
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Erro na assinatura do webhook:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const email = session.customer_details?.email || null;
            const productKey = session.metadata?.product_key || "desconhecido";
            const productName = session.metadata?.product_name || "Produto";

            console.log("✅ Pagamento confirmado:", {
              sessionId: session.id,
              email,
              productKey,
              productName,
            });

            if (email) {
              await sendPurchaseEmail({
                email,
                productKey,
                productName,
                sessionId: session.id,
              });
              console.log("📧 E-mail enviado para:", email);
            }

            break;
          }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          console.log("❌ Falha na cobrança recorrente:", invoice.id);
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          console.log("ℹ️ Assinatura cancelada:", subscription.id);
          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object;
          console.log("❌ Pagamento falhou:", paymentIntent.id);
          break;
        }

        default:
          console.log("ℹ️ Evento Stripe recebido:", event.type);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Erro ao processar webhook:", err.message);
      return res.status(500).json({ error: "Erro interno no webhook" });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// MIDDLEWARES GERAIS
// ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ─────────────────────────────────────────────────────────────
// HEALTHCHECK
// ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    env: {
      hasSecretKey: Boolean(process.env.STRIPE_SECRET_KEY),
      hasWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      hasPriceEbook: Boolean(process.env.STRIPE_PRICE_EBOOK),
      hasPriceConsultoriaAvulsa: Boolean(
        process.env.STRIPE_PRICE_CONSULTORIA_AVULSA
      ),
      hasPriceConsultoriaMensal: Boolean(
        process.env.STRIPE_PRICE_CONSULTORIA_MENSAL
      ),
      baseUrl: BASE_URL,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// CRIAR CHECKOUT SESSION
// ─────────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !products[product]) {
      return res.status(400).json({ error: "Produto inválido." });
    }

    const selectedProduct = products[product];

    if (!selectedProduct.priceId) {
      return res.status(500).json({
        error: `Price ID não configurado para o produto: ${product}`,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: selectedProduct.mode,
      payment_method_types: ["card"],
      line_items: [
        {
          price: selectedProduct.priceId,
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?cancelado=1`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      metadata: {
        product_key: product,
        product_name: selectedProduct.productName,
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erro ao criar sessão de checkout:", err.message);
    return res.status(500).json({ error: "Erro ao criar checkout session." });
  }
});

// ─────────────────────────────────────────────────────────────
// VERIFICAR SESSÃO
// ─────────────────────────────────────────────────────────────
app.get("/verificar-sessao", async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({ error: "session_id obrigatório" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    return res.json({
      id: session.id,
      status: session.payment_status,
      customer_email: session.customer_details?.email || null,
      product_key: session.metadata?.product_key || null,
      product_name: session.metadata?.product_name || null,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar sessão:", err.message);
    return res.status(500).json({ error: "Erro ao verificar sessão." });
  }
});

// ─────────────────────────────────────────────────────────────
// LIBERAR DOWNLOAD DO EBOOK APÓS PAGAMENTO
// ─────────────────────────────────────────────────────────────
app.get("/download-ebook", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!sessionId) {
    return res.status(400).send("session_id obrigatório");
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const isPaid =
      session.payment_status === "paid" || session.status === "complete";

    const allowedProducts = [
      "ebook",
      "consultoria_avulsa",
      "consultoria_mensal",
    ];

    const isAllowed = allowedProducts.includes(session.metadata?.product_key);

    if (!isPaid) {
      return res.status(403).send("Pagamento ainda não confirmado.");
    }

    if (!isAllowed) {
      return res.status(403).send("Esta compra não dá acesso ao ebook.");
    }

    const filePath = path.join(
      PUBLIC_DIR,
      "downloads",
      "ebook-investimentos-para-iniciantes.pdf"
    );

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .send(
          "Arquivo do ebook não encontrado. Coloque o PDF em public/downloads/ebook-investimentos-para-iniciantes.pdf"
        );
    }

    return res.download(
      filePath,
      "ebook-investimentos-para-iniciantes.pdf"
    );
  } catch (err) {
    console.error("❌ Erro ao liberar ebook:", err.message);
    return res.status(500).send("Erro ao liberar o arquivo.");
  }
});

// ─────────────────────────────────────────────────────────────
// ROTAS DE PÁGINAS PRINCIPAIS
// ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/sucesso", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "sucesso.html"));
});

app.get("/politica-de-privacidade", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "politica-de-privacidade.html"));
});

app.get("/politica-de-cookies", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "politica-de-cookies.html"));
});

app.get("/termos-de-uso", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "termos-de-uso.html"));
});

// START
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em ${BASE_URL}`);
  });
}

module.exports = app;