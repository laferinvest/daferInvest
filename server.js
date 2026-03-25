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
  consultoria_premium: {
    priceId: process.env.STRIPE_PRICE_CONSULTORIA_PREMIUM,
    mode: "payment",
    productName: "Ebook + Consultoria Premium",
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

  // ── Bloco de rodapé reutilizável ──────────────────────────────
  const emailFooter = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:40px;border-top:1px solid #d4d1cb;">
      <tr>
        <td style="padding:28px 40px 0;text-align:left;">
          <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:18px;font-weight:700;letter-spacing:0.06em;color:#0c0e13;">
            Daniel<span style="color:#a07c30;">.</span>
          </p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#58607a;line-height:1.7;">
            Daniel Oliveira Ferreira · Consultor de Valores Mobiliários Autônomo<br>
            Registrado na CVM sob o nº 003838-5 · CEA certificado pela ANBIMA
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 40px 32px;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:10px;color:#8a90a2;line-height:1.7;">
            As informações contidas neste e-mail têm caráter informativo e educacional, não constituindo recomendação de investimento.
            Investimentos envolvem riscos. Rentabilidade passada não é garantia de rentabilidade futura.
          </p>
        </td>
      </tr>
    </table>
  `;

  // ── Wrapper HTML externo reutilizável ─────────────────────────
  const wrapEmail = (headerLabel, bodyHtml) => `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
    </head>
    <body style="margin:0;padding:0;background:#f7f6f3;-webkit-font-smoothing:antialiased;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f6f3;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
                   style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d4d1cb;">

              <!-- Header -->
              <tr>
                <td style="background:#0c0e13;padding:32px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td>
                        <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                                  letter-spacing:0.18em;text-transform:uppercase;color:#a07c30;">
                          ${headerLabel}
                        </p>
                        <p style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:700;
                                  letter-spacing:0.02em;color:#ffffff;line-height:1.2;">
                          Daniel<span style="color:#a07c30;">.</span>
                        </p>
                      </td>
                      <td align="right" valign="middle">
                        <span style="display:inline-block;padding:5px 12px;font-family:Arial,sans-serif;
                                     font-size:9px;font-weight:700;letter-spacing:0.14em;
                                     text-transform:uppercase;color:#ffffff;
                                     border:1px solid rgba(160,124,48,0.4);">
                          CEA · CVM Nº 003838-5
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:40px 40px 0;">
                  ${bodyHtml}
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td>${emailFooter}</td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const guaranteeBlock = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:32px;">
      <tr>
        <td style="padding:18px 20px;">
          <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                    letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
            Garantia de 7 dias
          </p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.8;">
            Você conta com uma garantia de 7 dias. Se entender que o material ou o serviço
            não é adequado para você, basta responder este e-mail, no prazo de até
            <strong style="color:#0c0e13;">7 dias após a compra</strong>, e solicitar o
            <strong style="color:#0c0e13;">reembolso integral</strong>.
          </p>
        </td>
      </tr>
    </table>
  `;

  let subject = "Compra confirmada";
  let html = "";

  if (productKey === "ebook") {
    subject = "Seu ebook está disponível · Daniel Ferreira";
    html = wrapEmail("Confirmação de compra", `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;
                letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;
                 color:#0c0e13;line-height:1.3;">
        Seu ebook está pronto para download
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. O acesso ao <strong style="color:#0c0e13;">${productName}</strong>
        foi liberado e você já pode fazer o download pelo botão abaixo.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        O link é pessoal e intransferível. Em caso de qualquer dificuldade com o acesso,
        basta responder a este e-mail e eu retorno em até 1 dia útil.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;">
        <tr>
          <td style="background:#a07c30;">
            <a href="${downloadUrl}"
               style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;
                      font-size:11px;font-weight:700;letter-spacing:0.12em;
                      text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook agora
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `);

  } else if (productKey === "consultoria_avulsa") {
    subject = "Compra confirmada · Ebook + Consultoria Estratégica";
    html = wrapEmail("Confirmação de compra", `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;
                letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;
                 color:#0c0e13;line-height:1.3;">
        Ebook liberado e consultoria agendada em breve
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. Sua compra de <strong style="color:#0c0e13;">${productName}</strong>
        foi confirmada com sucesso.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        O ebook já está disponível para download. Para a consultoria estratégica, você receberá
        as instruções de agendamento em até <strong style="color:#0c0e13;">1 dia útil</strong>.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td style="background:#a07c30;">
            <a href="${downloadUrl}"
               style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;
                      font-size:11px;font-weight:700;letter-spacing:0.12em;
                      text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook agora
            </a>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:28px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                      letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              O que está incluso no seu plano
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.9;">
              · Sessão individual completa<br>
              · Diagnóstico do perfil de risco<br>
              · Análise do momento financeiro e dos objetivos<br>
              · Avaliação da carteira atual, quando houver<br>
              · Plano de investimentos por escrito<br>
              · Orientação para manutenção da carteira e rebalanceamentos<br>
              · Suporte por e-mail por 30 dias
            </p>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:32px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                      letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              Próximos passos
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.8;">
              Em até 1 dia útil você receberá um e-mail com o link para agendar sua
              sessão de consultoria individual. Fique atento à sua caixa de entrada.
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `);

  } else if (productKey === "consultoria_premium") {
    subject = "Compra confirmada · Ebook + Consultoria Premium";
    html = wrapEmail("Confirmação de compra", `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;
                letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;
                 color:#0c0e13;line-height:1.3;">
        Bem-vindo à Consultoria Premium
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. Sua compra de <strong style="color:#0c0e13;">${productName}</strong>
        foi confirmada com sucesso.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        O ebook já está liberado para download. Em até <strong style="color:#0c0e13;">1 dia útil</strong>
        você receberá as instruções completas para darmos início ao processo, incluindo um
        formulário de contexto financeiro que preparo antes da nossa reunião.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td style="background:#a07c30;">
            <a href="${downloadUrl}"
               style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;
                      font-size:11px;font-weight:700;letter-spacing:0.12em;
                      text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook agora
            </a>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:28px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                      letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              O que está incluso no seu plano
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.9;">
              · Raio-X financeiro completo enviado antes da reunião<br>
              · Reunião estratégica aprofundada<br>
              · Diagnóstico do perfil, objetivos e estrutura patrimonial<br>
              · Apresentação com plano de investimentos detalhado<br>
              · Proposta de organização da carteira por classes de ativos<br>
              · Guia de execução com próximos passos mês a mês<br>
              · 2 reuniões de retorno para ajustes e acompanhamento<br>
              · Suporte por WhatsApp por 30 dias<br>
              · Suporte por e-mail por 60 dias
            </p>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:32px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                      letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              Próximos passos
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.8;">
              Em até 1 dia útil você receberá um e-mail com o link de agendamento e
              o formulário de contexto financeiro. Preencha-o com antecedência, pois ele é
              a base do Raio-X que preparo antes da nossa reunião.
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `);

  } else {
    html = wrapEmail("Confirmação", `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;
                letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;
                 color:#0c0e13;line-height:1.3;">
        Sua compra foi confirmada
      </h1>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. Em caso de dúvidas, responda diretamente a este e-mail.
      </p>

      ${guaranteeBlock}

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `);
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

    const paymentMethods =
      selectedProduct.mode === "subscription"
        ? ["card"]
        : ["card", "boleto", "pix"];

    const session = await stripe.checkout.sessions.create({
      mode: selectedProduct.mode,
      payment_method_types: paymentMethods,
      line_items: [
        {
          price: selectedProduct.priceId,
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?cancelado=1`,
      locale: "pt-BR",
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
      "consultoria_premium",
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