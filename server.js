require("dotenv").config();

const nodemailer = require("nodemailer");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DIR = path.join(__dirname, "public");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_DASHBOARD_SECRET = process.env.ADMIN_DASHBOARD_SECRET;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function requireSupabase(req, res, next) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !supabaseAdmin
  ) {
    return res.status(500).json({
      error: "Supabase não configurado no servidor.",
      missing: {
        SUPABASE_URL: !SUPABASE_URL,
        SUPABASE_ANON_KEY: !SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: !SUPABASE_SERVICE_ROLE_KEY,
      },
    });
  }
  next();
}

async function requireInvestorAuth(req, res, next) {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: "Supabase não configurado." });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!token) {
    return res.status(401).json({ error: "Token ausente." });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Sessão inválida ou expirada." });
  }

  req.investorUser = data.user;
  req.accessToken = token;
  next();
}

function requireAdminSecret(req, res, next) {
  const provided = req.headers["x-admin-secret"] || req.body?.adminSecret;

  if (!ADMIN_DASHBOARD_SECRET) {
    return res
      .status(500)
      .json({ error: "ADMIN_DASHBOARD_SECRET não configurado." });
  }

  if (!provided || provided !== ADMIN_DASHBOARD_SECRET) {
    return res.status(403).json({ error: "Acesso administrativo negado." });
  }

  next();
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundPct(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizePositions(currentPositions = [], targetMicro = []) {
  const currentMap = new Map(
    (Array.isArray(currentPositions) ? currentPositions : []).map((item) => [
      item.code,
      {
        code: item.code,
        name: item.name,
        amount: Number(item.amount || 0),
      },
    ])
  );

  return (Array.isArray(targetMicro) ? targetMicro : []).map((target) => {
    const current = currentMap.get(target.code);

    return {
      code: target.code,
      name: target.name,
      bucket: target.bucket || null,
      target_pct: Number(target.target_pct || 0),
      current_amount: Number(current?.amount || 0),
    };
  });
}

function buildRebalancePlan({
  positions,
  contributionAmount,
  rebalanceBandPp,
}) {
  const sanitizedContribution = Number(contributionAmount || 0);

  const totalCurrent = positions.reduce(
    (sum, item) => sum + Number(item.current_amount || 0),
    0
  );

  const totalAfterContribution = totalCurrent + sanitizedContribution;

  const enriched = positions.map((item) => {
    const currentAmount = Number(item.current_amount || 0);
    const targetPct = Number(item.target_pct || 0);

    const currentPct =
      totalCurrent > 0 ? (currentAmount / totalCurrent) * 100 : 0;

    const driftPp = currentPct - targetPct;
    const outsideBand = Math.abs(driftPp) > Number(rebalanceBandPp || 0);

    const targetAmountAfterContribution =
      totalAfterContribution * (targetPct / 100);

    return {
      code: item.code,
      name: item.name,
      bucket: item.bucket,
      target_pct: roundPct(targetPct),
      current_amount: roundMoney(currentAmount),
      current_pct: roundPct(currentPct),
      drift_pp: roundPct(driftPp),
      outside_band: outsideBand,
      target_amount_after_contribution: roundMoney(targetAmountAfterContribution),
    };
  });

  const shouldRebalance =
    sanitizedContribution > 0 || enriched.some((item) => item.outside_band);

  const rows = enriched.map((item) => {
    let suggestedContribution = 0;
    let suggestedSale = 0;
    let finalAmount = Number(item.current_amount || 0);
    let actionLabel = "Manter como está.";

    if (shouldRebalance) {
      const delta =
        Number(item.target_amount_after_contribution || 0) -
        Number(item.current_amount || 0);

      if (delta > 0.004) {
        suggestedContribution = roundMoney(delta);
        finalAmount = roundMoney(
          Number(item.current_amount || 0) + suggestedContribution
        );
        actionLabel = `Aportar ${suggestedContribution.toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
        })}.`;
      } else if (delta < -0.004) {
        suggestedSale = roundMoney(Math.abs(delta));
        finalAmount = roundMoney(
          Number(item.current_amount || 0) - suggestedSale
        );
        actionLabel = `Reduzir ${suggestedSale.toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
        })}.`;
      }
    }

    return {
      ...item,
      suggested_contribution: roundMoney(suggestedContribution),
      suggested_sale: roundMoney(suggestedSale),
      final_amount: roundMoney(finalAmount),
      action_label: actionLabel,
    };
  });

  const totalBuy = roundMoney(
    rows.reduce(
      (sum, item) => sum + Number(item.suggested_contribution || 0),
      0
    )
  );

  const totalSale = roundMoney(
    rows.reduce((sum, item) => sum + Number(item.suggested_sale || 0), 0)
  );

  const totalFinal = roundMoney(
    rows.reduce((sum, item) => sum + Number(item.final_amount || 0), 0)
  );

  const rowsWithFinalPct = rows.map((item) => ({
    ...item,
    post_rebalance_pct:
      totalFinal > 0
        ? roundPct((Number(item.final_amount || 0) / totalFinal) * 100)
        : 0,
  }));

  const assetsOutsideBand = enriched.filter((item) => item.outside_band).length;

  return {
    total_current: roundMoney(totalCurrent),
    contribution_amount: roundMoney(sanitizedContribution),
    total_after_contribution: roundMoney(totalAfterContribution),
    total_final: roundMoney(totalFinal),
    rebalance_band_pp: roundPct(rebalanceBandPp || 0),
    total_buy: totalBuy,
    total_sale: totalSale,
    assets_outside_band: assetsOutsideBand,
    plan: rowsWithFinalPct,
  };
}

function isApprovedPaymentStatus(status) {
  return status === "approved";
}

function getMercadoPagoApiBaseUrl() {
  return process.env.MP_API_BASE_URL || "https://api.mercadopago.com";
}

async function mpRequest(endpoint, options = {}) {
  if (!process.env.MP_ACCESS_TOKEN) {
    throw new Error("MP_ACCESS_TOKEN não configurado.");
  }

  const url = `${getMercadoPagoApiBaseUrl()}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`Mercado Pago API error ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function parseMpSignature(headerValue = "") {
  const result = {};
  String(headerValue)
    .split(",")
    .map((part) => part.trim())
    .forEach((part) => {
      const [key, value] = part.split("=");
      if (key && value) result[key] = value;
    });
  return result;
}

function verifyMercadoPagoWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  const xSignature = req.headers["x-signature"];
  const xRequestId = req.headers["x-request-id"];
  const dataId =
    req.query["data.id"] ||
    req.body?.data?.id ||
    req.body?.resource?.split("/").pop() ||
    "";

  if (!xSignature || !xRequestId || !dataId) return false;

  const parsed = parseMpSignature(xSignature);
  const ts = parsed.ts;
  const v1 = parsed.v1;

  if (!ts || !v1) return false;

  const manifest =
    `id:${dataId};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(v1)
    );
  } catch (_) {
    return false;
  }
}

function buildSessionFromMpPayment(payment) {
  const productKey = payment.external_reference || "desconhecido";
  const productName = products[productKey]?.productName || "Produto";

  return {
    id: String(payment.id),
    payment_status: payment.status || null,
    status: payment.status === "approved" ? "complete" : payment.status || null,
    customer_details: {
      email: payment.payer?.email || null,
      name:
        payment.additional_info?.payer?.first_name ||
        payment.card?.cardholder?.name ||
        null,
      phone:
        payment.additional_info?.payer?.phone?.number ||
        payment.payer?.phone?.number ||
        null,
    },
    customer_email: payment.payer?.email || null,
    metadata: {
      product: productKey,
      product_key: productKey,
      product_name: productName,
      return_to: null,
    },
    mode: "payment",
    amount_total:
      payment.transaction_amount !== undefined &&
      payment.transaction_amount !== null
        ? Math.round(Number(payment.transaction_amount) * 100)
        : null,
  };
}

async function getMercadoPagoPayment(paymentId) {
  return await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
  });
}

function normalizeReturnPath(input) {
  if (!input || typeof input !== "string") return "/";

  try {
    const urlObj = new URL(input, "http://dummy.com");

    let rawPath = urlObj.pathname;

    if (rawPath === "/index") rawPath = "/index.html";
    if (rawPath === "/consultoria") rawPath = "/consultoria.html";
    if (rawPath === "/ebook") rawPath = "/ebook.html";

    const safePaths = new Set([
      "/",
      "/index.html",
      "/consultoria.html",
      "/ebook.html",
    ]);

    if (!safePaths.has(rawPath)) {
      return "/";
    }

    return `${rawPath}${urlObj.search}${urlObj.hash}`;
  } catch (_) {
    return "/";
  }
}

// ─────────────────────────────────────────────────────────────
// CONFIG DOS PRODUTOS
// ─────────────────────────────────────────────────────────────
const products = {
  ebook: {
    unitPrice: Number(process.env.PRICE_EBOOK || 39.9),
    mode: "payment",
    productName: "Ebook Investimentos para Iniciantes",
  },
  consultoria_avulsa: {
    unitPrice: Number(process.env.PRICE_CONSULTORIA_AVULSA || 397),
    mode: "payment",
    productName: "Ebook + Consultoria Individual",
  },
  consultoria_avulsa_entrada: {
    unitPrice: Number(process.env.PRICE_CONSULTORIA_AVULSA_ENTRADA || 198.5),
    mode: "payment",
    productName: "Consultoria Inicial - Entrada 50%",
  },
  consultoria_premium: {
    unitPrice: Number(process.env.PRICE_CONSULTORIA_PREMIUM || 797),
    mode: "payment",
    productName: "Ebook + Consultoria Premium",
  },
  consultoria_premium_entrada: {
    unitPrice: Number(process.env.PRICE_CONSULTORIA_PREMIUM_ENTRADA || 398.5),
    mode: "payment",
    productName: "Consultoria Premium - Entrada 50%",
  },
};

// ─────────────────────────────────────────────────────────────
// E-MAIL
// ─────────────────────────────────────────────────────────────
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
  const downloadUrl = `${BASE_URL}/download-ebook?session_id=${encodeURIComponent(
    sessionId
  )}`;
  const investorAreaUrl = `${BASE_URL}/entrar`;

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
              <tr>
                <td style="background:#0c0e13;padding:32px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td>
                        <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#a07c30;">
                          ${headerLabel}
                        </p>
                        <p style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:700;letter-spacing:0.02em;color:#ffffff;line-height:1.2;">
                          Daniel<span style="color:#a07c30;">.</span>
                        </p>
                      </td>
                      <td align="right" valign="middle">
                        <span style="display:inline-block;padding:5px 12px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#ffffff;border:1px solid rgba(160,124,48,0.4);">
                          CEA · CVM Nº 003838-5
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:40px 40px 0;">
                  ${bodyHtml}
                </td>
              </tr>

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
          <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
            Garantia de 7 dias
          </p>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.8;">
            Depois que o plano final for enviado, com os valores de alocação liberados, você terá até
            <strong style="color:#0c0e13;">7 dias</strong> para avaliar a entrega.
            Se concluir que ela não gerou valor suficiente para você, basta responder este e-mail dentro desse prazo e solicitar o
            <strong style="color:#0c0e13;">reembolso</strong>.
          </p>
        </td>
      </tr>
    </table>
  `;

  let subject = "Compra confirmada";
  let html = "";

  if (productKey === "ebook") {
    subject = "Seu ebook está disponível · Daniel Ferreira";
    html = wrapEmail(
      "Confirmação de compra",
      `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">
        Seu ebook está pronto para download
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. O acesso ao <strong style="color:#0c0e13;">${productName}</strong> foi liberado.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Você já pode baixar o material pelo botão abaixo. Em caso de qualquer dificuldade com o acesso,
        basta responder este e-mail.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;">
        <tr>
          <td style="background:#a07c30;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
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
    `
    );
  } else if (productKey === "consultoria_avulsa") {
    subject = "Compra confirmada · Consultoria Inicial";
    html = wrapEmail(
      "Confirmação de compra",
      `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">
        Sua consultoria inicial foi confirmada
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. Sua contratação de <strong style="color:#0c0e13;">${productName}</strong> foi confirmada com sucesso.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Nesta etapa, eu vou conduzir a reunião com questionários e testes, analisar seu perfil,
        seu conhecimento, seu patrimônio e então preparar um <strong style="color:#0c0e13;">plano de investimentos pronto para execução</strong>.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:28px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              O que está incluso no seu plano
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.9;">
              · Reunião com questionários e testes<br>
              · Análise do perfil, conhecimento e patrimônio<br>
              · Plano de investimentos pronto para execução<br>
              · Upload do plano na área do investidor<br>
              · Gráfico de acompanhamento e rebalanceamento
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Você também receberá acesso à <strong style="color:#0c0e13;">área do investidor</strong>, onde o plano ficará centralizado para acompanhamento e execução prática.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
        <tr>
          <td style="background:#0c0e13;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook incluso
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:13px;color:#58607a;line-height:1.8;">
        Seu ebook já está liberado e pode ser baixado diretamente pelo botão acima.
      </p>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `
    );
  } else if (productKey === "consultoria_avulsa_entrada") {
    subject = "Entrada confirmada · Consultoria Inicial";
    html = wrapEmail(
      "Confirmação da entrada",
      `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Entrada confirmada
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">
        Sua consultoria inicial foi iniciada
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado. O pagamento da <strong style="color:#0c0e13;">entrada de 50%</strong> da sua consultoria foi confirmado com sucesso.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        A partir daqui, seguimos com a reunião, o diagnóstico do seu perfil, patrimônio, objetivos e restrições,
        e então eu monto a estrutura do seu plano de investimentos na área do investidor.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:28px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              Como funciona a partir de agora
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.9;">
              · Fazemos a reunião e o diagnóstico técnico<br>
              · Eu estruturo o plano e faço o upload na área do investidor<br>
              · Você visualiza a lógica da carteira e a construção da estratégia<br>
              · Os valores exatos por ativo ficam bloqueados nessa etapa<br>
              · Se você aprovar, eu envio o link para pagamento da segunda metade<br>
              · Após esse pagamento, libero os valores finais para execução
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Seu acesso à <strong style="color:#0c0e13;">área do investidor</strong> continuará sendo a base da entrega.
        É lá que a estrutura do plano ficará organizada até a liberação final.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
        <tr>
          <td style="background:#0c0e13;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook incluso
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:13px;color:#58607a;line-height:1.8;">
        Seu ebook já está liberado e pode ser baixado diretamente pelo botão acima.
      </p>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `
    );
  } else if (productKey === "consultoria_premium") {
    subject = "Compra confirmada · Consultoria Premium";
    html = wrapEmail(
      "Confirmação de compra",
      `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">
        Sua consultoria premium foi confirmada
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra. Sua contratação de <strong style="color:#0c0e13;">${productName}</strong> foi confirmada com sucesso.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        A versão premium inclui <strong style="color:#0c0e13;">tudo o que existe no plano inicial</strong>, com mais profundidade na explicação da carteira e maior apoio na fase de implementação.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:28px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              O que está incluso no seu plano premium
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.9;">
              · Tudo do plano inicial<br>
              · Apresentação detalhada dos investimentos<br>
              · Explicação do papel de cada ativo na carteira<br>
              · Seção de dúvidas dedicada<br>
              · Maior acompanhamento na fase de execução
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        O objetivo aqui é que você não apenas receba o plano, mas também entenda melhor a carteira,
        tire dúvidas com profundidade e implemente tudo com mais segurança.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Você também terá acesso à <strong style="color:#0c0e13;">área do investidor</strong> para acompanhar o plano,
        visualizar a carteira e usar a ferramenta de rebalanceamento.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
        <tr>
          <td style="background:#0c0e13;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook incluso
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:13px;color:#58607a;line-height:1.8;">
        Seu ebook já está liberado e pode ser baixado diretamente pelo botão acima.
      </p>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `
    );
  } else if (productKey === "consultoria_premium_entrada") {
    subject = "Entrada confirmada · Consultoria Premium";
    html = wrapEmail(
      "Confirmação da entrada",
      `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Entrada confirmada
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">
        Sua consultoria premium foi iniciada
      </h1>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado. O pagamento da <strong style="color:#0c0e13;">entrada de 50%</strong> da sua consultoria premium foi confirmado com sucesso.
      </p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Agora seguimos com a reunião, o diagnóstico do seu perfil e a construção do plano.
        Na versão premium, você também terá uma apresentação mais aprofundada da lógica da carteira,
        dos ativos e do papel de cada parte da estratégia.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#f7f6f3;border-left:3px solid #a07c30;margin-bottom:28px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
              Como funciona a partir de agora
            </p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#2a2f42;line-height:1.9;">
              · Fazemos a reunião e o diagnóstico técnico<br>
              · Eu estruturo o plano premium e faço o upload na área do investidor<br>
              · Você visualiza a lógica da carteira e recebe explicação aprofundada<br>
              · Os valores exatos por ativo ficam bloqueados nessa etapa<br>
              · Se você aprovar, eu envio o link para pagamento da segunda metade<br>
              · Após esse pagamento, libero os valores finais para execução completa
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Seu acesso à <strong style="color:#0c0e13;">área do investidor</strong> continuará sendo a base da entrega.
        É lá que a estrutura do plano ficará organizada até a liberação final.
      </p>

      ${guaranteeBlock}

      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
        <tr>
          <td style="background:#0c0e13;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook incluso
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:13px;color:#58607a;line-height:1.8;">
        Seu ebook já está liberado e pode ser baixado diretamente pelo botão acima.
      </p>

      <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:15px;color:#0c0e13;font-weight:600;">
        Daniel Ferreira
      </p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#58607a;">
        Consultor CEA · CVM Nº 003838-5
      </p>
    `
    );
  } else {
    subject = "Compra confirmada";
    html = wrapEmail(
      "Confirmação",
      `
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;">
        Pagamento confirmado
      </p>
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">
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
    `
    );
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: [email, "daniel@daferinvest.com.br"].filter(Boolean).join(", "),
    subject,
    html,
  });
}

async function sendAdminSaleEmail({
  buyerEmail,
  buyerName,
  buyerPhone,
  productKey,
  productName,
  sessionId,
  amountTotal,
  mode,
}) {
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.EMAIL_USER;

  const amountFormatted =
    typeof amountTotal === "number"
      ? new Intl.NumberFormat("pt-BR", {
          style: "currency",
          currency: "BRL",
        }).format(amountTotal / 100)
      : "Não informado";

  const isEntryPayment =
    productKey === "consultoria_avulsa_entrada" ||
    productKey === "consultoria_premium_entrada";

  const title = isEntryPayment
    ? "Você recebeu uma entrada de consultoria."
    : "Você vendeu.";

  const headerLabel = isEntryPayment
    ? "Nova entrada confirmada"
    : "Nova venda confirmada";

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
    </head>
    <body style="margin:0;padding:24px;background:#f7f6f3;font-family:Arial,sans-serif;color:#0c0e13;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center">
            <table width="640" cellpadding="0" cellspacing="0" border="0"
                   style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d4d1cb;">
              <tr>
                <td style="background:#0c0e13;padding:24px 28px;">
                  <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#a07c30;">
                    ${headerLabel}
                  </p>
                  <p style="margin:0;font-size:28px;font-family:Georgia,serif;color:#ffffff;">
                    Daniel<span style="color:#a07c30;">.</span>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:28px;">
                  <h1 style="margin:0 0 20px;font-size:24px;font-family:Georgia,serif;">${title}</h1>

                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>Produto</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${productName || "Não informado"}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>Tipo</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${mode || "payment"}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>Valor</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${amountFormatted}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>Nome do comprador</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${buyerName || "Não informado"}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>E-mail do comprador</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${buyerEmail || "Não informado"}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>Telefone</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${buyerPhone || "Não informado"}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;"><strong>Product key</strong></td>
                      <td style="padding:10px 0;border-bottom:1px solid #eee;">${productKey || "Não informado"}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 0;"><strong>Session ID</strong></td>
                      <td style="padding:10px 0;word-break:break-all;">${sessionId}</td>
                    </tr>
                  </table>

                  ${
                    buyerEmail
                      ? `
                    <div style="margin-top:24px;">
                      <a href="mailto:${buyerEmail}?subject=${encodeURIComponent(
                        "Agendamento da sua consultoria"
                      )}"
                         style="display:inline-block;padding:14px 22px;background:#a07c30;color:#fff;text-decoration:none;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">
                        Responder comprador
                      </a>
                    </div>
                  `
                      : ""
                  }

                  <p style="margin:24px 0 0;font-size:13px;color:#58607a;line-height:1.7;">
                    Esse e-mail foi enviado automaticamente pelo webhook do Mercado Pago após confirmação de pagamento.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const subjectPrefix = isEntryPayment
    ? "Entrada confirmada"
    : "Nova venda confirmada";

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: adminEmail,
    subject: `${subjectPrefix} · ${productName || "Produto"} · ${
      buyerEmail || "sem e-mail"
    }`,
    html,
  });
}

async function handleConfirmedSale(session) {
  const email = session.customer_details?.email || session.customer_email || null;
  const buyerName = session.customer_details?.name || null;
  const buyerPhone = session.customer_details?.phone || null;
  const productKey =
    session.metadata?.product ||
    session.metadata?.product_key ||
    "desconhecido";
  const productName =
    session.metadata?.product_name ||
    products[productKey]?.productName ||
    "Produto";
  const amountTotal = session.amount_total ?? null;
  const mode = session.mode || "payment";

  console.log("✅ Venda confirmada:", {
    sessionId: session.id,
    email,
    buyerName,
    buyerPhone,
    productKey,
    productName,
    paymentStatus: session.payment_status,
    amountTotal,
  });

  if (email) {
    await sendPurchaseEmail({
      email,
      productKey,
      productName,
      sessionId: session.id,
    });
    console.log("📧 E-mail enviado para comprador:", email);
  } else {
    console.log("⚠️ Compra confirmada sem e-mail do comprador:", session.id);
  }

  await sendAdminSaleEmail({
    buyerEmail: email,
    buyerName,
    buyerPhone,
    productKey,
    productName,
    sessionId: session.id,
    amountTotal,
    mode,
  });
  console.log("📨 E-mail interno enviado para o admin");
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARES
// ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ─────────────────────────────────────────────────────────────
// ROTAS ESTÁTICAS
// ─────────────────────────────────────────────────────────────
app.get(["/", "/api"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get(["/consultoria", "/api/consultoria"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "consultoria.html"));
});

app.get(["/ebook", "/api/ebook"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "ebook.html"));
});

app.get(["/preview", "/api/preview"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "preview.html"));
});

app.get(["/sucesso", "/api/sucesso"], (req, res) => {
  const paymentId =
    req.query.session_id ||
    req.query.payment_id ||
    req.query.collection_id ||
    null;

  if (
    paymentId &&
    String(req.query.session_id || "") !== String(paymentId)
  ) {
    const redirectUrl = new URL("/sucesso", BASE_URL);
    redirectUrl.searchParams.set("session_id", String(paymentId));

    if (req.query.status) {
      redirectUrl.searchParams.set("status", String(req.query.status));
    }

    if (req.query.external_reference) {
      redirectUrl.searchParams.set(
        "produto",
        String(req.query.external_reference)
      );
    }

    if (req.query.preference_id) {
      redirectUrl.searchParams.set(
        "preference_id",
        String(req.query.preference_id)
      );
    }

    return res.redirect(302, redirectUrl.toString());
  }

  return res.sendFile(path.join(PUBLIC_DIR, "sucesso.html"));
});

app.get(["/entrar", "/api/entrar"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "entrar.html"));
});

app.get("/area-investidor", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "area-investidor.html"));
});

app.get("/admin-dashboard", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin-dashboard.html"));
});

// ─────────────────────────────────────────────────────────────
// HEALTHCHECK
// ─────────────────────────────────────────────────────────────
app.get(["/health", "/api/health"], (_req, res) => {
  res.json({
    ok: true,
    env: {
      hasMpAccessToken: Boolean(process.env.MP_ACCESS_TOKEN),
      hasMpWebhookSecret: Boolean(process.env.MP_WEBHOOK_SECRET),
      hasPriceEbook: Boolean(process.env.PRICE_EBOOK || 39.9),
      hasPriceConsultoriaAvulsa: Boolean(
        process.env.PRICE_CONSULTORIA_AVULSA || 397
      ),
      hasPriceConsultoriaAvulsaEntrada: Boolean(
        process.env.PRICE_CONSULTORIA_AVULSA_ENTRADA || 198.5
      ),
      hasPriceConsultoriaPremium: Boolean(
        process.env.PRICE_CONSULTORIA_PREMIUM || 797
      ),
      hasPriceConsultoriaPremiumEntrada: Boolean(
        process.env.PRICE_CONSULTORIA_PREMIUM_ENTRADA || 398.5
      ),
      hasEmailHost: Boolean(process.env.EMAIL_HOST),
      hasEmailUser: Boolean(process.env.EMAIL_USER),
      hasAdminNotifyEmail: Boolean(process.env.ADMIN_NOTIFY_EMAIL),
      baseUrl: BASE_URL,
      mpApiBaseUrl: getMercadoPagoApiBaseUrl(),
    },
  });
});

// ─────────────────────────────────────────────────────────────
// AUTH / INVESTOR AREA
// ─────────────────────────────────────────────────────────────
const INVESTOR_TABLE = "userData";
const INVESTOR_PK = "auth_user_id";

app.get("/api/supabase-config", requireSupabase, (req, res) => {
  return res.json({
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
  });
});

app.post("/api/admin/login", requireAdminSecret, async (req, res) => {
  try {
    return res.json({ ok: true });
  } catch (error) {
    console.error("Erro no login admin:", error);
    return res.status(500).json({ error: "Erro interno ao autenticar admin." });
  }
});

app.get(
  "/api/investor/me",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    try {
      const user = req.investorUser;

      const { data: investorData, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("*")
        .eq(INVESTOR_PK, user.id)
        .maybeSingle();

      if (error) throw error;

      return res.json({
        authUser: {
          id: user.id,
          email: user.email,
        },
        investorData: investorData || {},
      });
    } catch (error) {
      console.error("Erro ao buscar perfil do investidor:", error);
      return res
        .status(500)
        .json({ error: "Erro ao carregar área do investidor." });
    }
  }
);

app.post(
  "/api/investor/questionnaire",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    try {
      const user = req.investorUser;
      const payload = req.body || {};

      const row = {
        [INVESTOR_PK]: user.id,
        client_email: payload.client_email || user.email || null,
        client_name: payload.client_name || payload.full_name || null,
        questionnaire_answers:
          payload.questionnaire_answers ||
          payload.questionnaire_json ||
          payload.answers ||
          payload ||
          null,
        last_client_access_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .upsert(row, {
          onConflict: INVESTOR_PK,
        })
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, investorData: data });
    } catch (error) {
      console.error("Erro ao salvar questionário:", error);
      return res.status(500).json({ error: "Erro ao salvar questionário." });
    }
  }
);

app.post(
  "/api/admin/investor-access",
  requireSupabase,
  requireAdminSecret,
  async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();

      const clientName = String(req.body?.client_name || req.body?.name || "")
        .trim();

      if (!email) {
        return res.status(400).json({ error: "Informe um e-mail." });
      }

      const { data: existingUsers, error: listError } =
        await supabaseAdmin.auth.admin.listUsers({
          page: 1,
          perPage: 1000,
        });

      if (listError) throw listError;

      const existingUser = existingUsers?.users?.find(
        (item) => String(item.email || "").toLowerCase() === email
      );

      let userId = existingUser?.id || null;
      let createdPassword = null;

      if (!userId) {
        createdPassword = Math.random().toString(36).slice(-10) + "A1!";
        const { data: newUserData, error: createError } =
          await supabaseAdmin.auth.admin.createUser({
            email,
            password: createdPassword,
            email_confirm: true,
          });

        if (createError) throw createError;

        userId = newUserData.user.id;
      }

      const { data: investorData, error: profileError } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .upsert(
          {
            [INVESTOR_PK]: userId,
            client_email: email,
            client_name: clientName || null,
            client_status: "active",
            updated_at: new Date().toISOString(),
            last_client_access_at: new Date().toISOString(),
          },
          { onConflict: INVESTOR_PK }
        )
        .select()
        .single();

      if (profileError) throw profileError;

      return res.json({
        ok: true,
        user_id: userId,
        created: !existingUser,
        temporary_password: createdPassword,
        investorData,
      });
    } catch (error) {
      console.error("Erro ao liberar acesso do investidor:", error);
      return res.status(500).json({ error: "Erro ao liberar acesso." });
    }
  }
);

app.get(
  "/api/admin/investors",
  requireSupabase,
  requireAdminSecret,
  async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("*")
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return res.json({ investors: data || [] });
    } catch (error) {
      console.error("Erro ao listar investidores:", error);
      return res.status(500).json({ error: "Erro ao listar investidores." });
    }
  }
);

app.get(
  "/api/admin/investors/:userId",
  requireSupabase,
  requireAdminSecret,
  async (req, res) => {
    try {
      const { userId } = req.params;

      const { data, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("*")
        .eq(INVESTOR_PK, userId)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({ error: "Investidor não encontrado." });
      }

      return res.json({ investor: data });
    } catch (error) {
      console.error("Erro ao carregar investidor:", error);
      return res.status(500).json({ error: "Erro ao carregar investidor." });
    }
  }
);

app.patch(
  "/api/admin/investors/:userId/plan",
  requireSupabase,
  requireAdminSecret,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const updates = req.body || {};

      const payload = {
        client_name: updates.client_name ?? undefined,
        client_email: updates.client_email ?? undefined,
        plan_type: updates.plan_type ?? undefined,
        client_status: updates.client_status ?? undefined,
        currency: updates.currency ?? undefined,
        profile_label: updates.profile_label ?? undefined,
        profile_index:
          updates.profile_index !== undefined &&
          updates.profile_index !== null &&
          updates.profile_index !== ""
            ? Number(updates.profile_index)
            : undefined,
        risk_capacity_score:
          updates.risk_capacity_score !== undefined &&
          updates.risk_capacity_score !== null &&
          updates.risk_capacity_score !== ""
            ? Number(updates.risk_capacity_score)
            : undefined,
        risk_tolerance_score:
          updates.risk_tolerance_score !== undefined &&
          updates.risk_tolerance_score !== null &&
          updates.risk_tolerance_score !== ""
            ? Number(updates.risk_tolerance_score)
            : undefined,
        risk_implementation_score:
          updates.risk_implementation_score !== undefined &&
          updates.risk_implementation_score !== null &&
          updates.risk_implementation_score !== ""
            ? Number(updates.risk_implementation_score)
            : undefined,
        risk_diagnostic_confidence:
          updates.risk_diagnostic_confidence ?? undefined,
        planning_method_code: updates.planning_method_code ?? undefined,
        planning_method_label: updates.planning_method_label ?? undefined,
        profile_summary: updates.profile_summary ?? undefined,
        advisor_notes: updates.advisor_notes ?? undefined,
        rebalance_band_pp:
          updates.rebalance_band_pp !== undefined &&
          updates.rebalance_band_pp !== null &&
          updates.rebalance_band_pp !== ""
            ? Number(updates.rebalance_band_pp)
            : undefined,
        drift_warning_pp:
          updates.drift_warning_pp !== undefined &&
          updates.drift_warning_pp !== null &&
          updates.drift_warning_pp !== ""
            ? Number(updates.drift_warning_pp)
            : undefined,
        allow_sells:
          updates.allow_sells !== undefined
            ? Boolean(updates.allow_sells)
            : undefined,
        target_macro: updates.target_macro ?? undefined,
        target_micro: updates.target_micro ?? undefined,
        current_positions: updates.current_positions ?? undefined,
        allocation_history: updates.allocation_history ?? undefined,
        rebalance_history: updates.rebalance_history ?? undefined,
        questionnaire_answers: updates.questionnaire_answers ?? undefined,
        plan_outputs: updates.plan_outputs ?? undefined,
        restrictions_json: updates.restrictions_json ?? undefined,
        metadata_json: updates.metadata_json ?? undefined,
        last_recommendation_date:
          updates.last_recommendation_date ?? undefined,
        last_snapshot_date: updates.last_snapshot_date ?? undefined,
        updated_at: new Date().toISOString(),
      };

      const sanitizedPayload = Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== undefined)
      );

      const { data, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .update(sanitizedPayload)
        .eq(INVESTOR_PK, userId)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, investor: data });
    } catch (error) {
      console.error("Erro ao salvar plano:", error);
      return res.status(500).json({ error: "Erro ao salvar plano." });
    }
  }
);

app.post(
  "/api/investor/snapshot",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    try {
      const user = req.investorUser;
      const snapshotDate = req.body?.snapshotDate || req.body?.snapshot_date;
      const currentPositions = Array.isArray(
        req.body?.currentPositions || req.body?.current_positions
      )
        ? req.body.currentPositions || req.body.current_positions
        : [];

      if (!snapshotDate) {
        return res.status(400).json({ error: "Informe a data da posição." });
      }

      const { data: investorData, error: loadError } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("allocation_history, current_positions")
        .eq(INVESTOR_PK, user.id)
        .maybeSingle();

      if (loadError) throw loadError;

      const allocationHistory = Array.isArray(investorData?.allocation_history)
        ? [...investorData.allocation_history]
        : [];

      const nextSnapshot = {
        snapshotDate,
        positions: currentPositions,
      };

      const existingIndex = allocationHistory.findIndex(
        (item) => item?.snapshotDate === snapshotDate
      );

      if (existingIndex >= 0) {
        allocationHistory[existingIndex] = nextSnapshot;
      } else {
        allocationHistory.push(nextSnapshot);
      }

      allocationHistory.sort((a, b) =>
        String(a?.snapshotDate || "").localeCompare(
          String(b?.snapshotDate || "")
        )
      );

      const { data, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .update({
          current_positions: currentPositions,
          allocation_history: allocationHistory,
          last_snapshot_date: snapshotDate,
          last_client_access_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq(INVESTOR_PK, user.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, investorData: data });
    } catch (error) {
      console.error("Erro ao salvar snapshot:", error);
      return res.status(500).json({ error: "Erro ao salvar posição." });
    }
  }
);

app.post(
  "/api/investor/rebalance-plan",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    try {
      const user = req.investorUser;
      const contributionAmount = Number(
        req.body?.contributionAmount ?? req.body?.contribution_amount ?? 0
      );

      const allowSells =
        req.body?.allowSells !== undefined
          ? Boolean(req.body.allowSells)
          : req.body?.allow_sells !== undefined
          ? Boolean(req.body.allow_sells)
          : true;

      const snapshotDate =
        req.body?.snapshotDate || req.body?.snapshot_date || null;

      const rawCurrentPositions =
        req.body?.currentPositions || req.body?.current_positions || [];

      const { data: investorData, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("target_micro, rebalance_band_pp, rebalance_history")
        .eq(INVESTOR_PK, user.id)
        .maybeSingle();

      if (error) throw error;

      if (!investorData?.target_micro) {
        return res.status(400).json({
          error: "Plano ainda não publicado para este investidor.",
        });
      }

      const positions = normalizePositions(
        rawCurrentPositions,
        investorData.target_micro || []
      );

      const rebalance = buildRebalancePlan({
        positions,
        contributionAmount,
        rebalanceBandPp:
          investorData.rebalance_band_pp !== null &&
          investorData.rebalance_band_pp !== undefined
            ? Number(investorData.rebalance_band_pp)
            : 5,
      });

      const planRows = allowSells
        ? rebalance.plan
        : rebalance.plan.map((item) => {
            if (Number(item.suggested_sale || 0) <= 0) return item;
            const adjustedFinalAmount = roundMoney(
              Number(item.current_amount || 0)
            );
            return {
              ...item,
              suggested_sale: 0,
              final_amount: adjustedFinalAmount,
              post_rebalance_pct:
                rebalance.total_final > 0
                  ? roundPct((adjustedFinalAmount / rebalance.total_final) * 100)
                  : 0,
              action_label:
                Number(item.suggested_contribution || 0) > 0
                  ? `Aportar ${Number(
                      item.suggested_contribution || 0
                    ).toLocaleString("pt-BR", {
                      style: "currency",
                      currency: "BRL",
                    })}.`
                  : "Manter como está.",
            };
          });

      const responsePlan = {
        ...rebalance,
        plan: planRows,
        allow_sells: allowSells,
      };

      const rebalanceHistory = Array.isArray(investorData?.rebalance_history)
        ? [...investorData.rebalance_history]
        : [];

      rebalanceHistory.push({
        snapshotDate,
        contributionAmount: roundMoney(contributionAmount),
        allowSells: allowSells,
        plan: responsePlan.plan,
        generatedAt: new Date().toISOString(),
      });

      await supabaseAdmin
        .from(INVESTOR_TABLE)
        .update({
          rebalance_history: rebalanceHistory,
          last_client_access_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq(INVESTOR_PK, user.id);

      return res.json(responsePlan);
    } catch (error) {
      console.error("Erro ao gerar rebalanceamento:", error);
      return res
        .status(500)
        .json({ error: "Erro ao calcular rebalanceamento." });
    }
  }
);

app.post(
  "/api/investor/rebalance-preview",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    try {
      const user = req.investorUser;
      const contributionAmount = Number(
        req.body?.contributionAmount ?? req.body?.contribution_amount ?? 0
      );

      const rawCurrentPositions =
        req.body?.currentPositions || req.body?.current_positions || [];

      const { data: investorData, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("target_micro, rebalance_band_pp")
        .eq(INVESTOR_PK, user.id)
        .maybeSingle();

      if (error) throw error;

      if (!investorData?.target_micro) {
        return res.status(400).json({
          error: "Plano ainda não publicado para este investidor.",
        });
      }

      const positions = normalizePositions(
        rawCurrentPositions,
        investorData.target_micro || []
      );

      const plan = buildRebalancePlan({
        positions,
        contributionAmount,
        rebalanceBandPp:
          investorData.rebalance_band_pp !== null &&
          investorData.rebalance_band_pp !== undefined
            ? Number(investorData.rebalance_band_pp)
            : 5,
      });

      return res.json({ ok: true, plan });
    } catch (error) {
      console.error("Erro ao gerar rebalanceamento:", error);
      return res
        .status(500)
        .json({ error: "Erro ao gerar simulação de rebalanceamento." });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// MERCADO PAGO CHECKOUT PRO
// ─────────────────────────────────────────────────────────────
app.post(
  [
    "/create-checkout-session",
    "/api/create-checkout-session",
    "/create-mp-preference",
    "/api/create-mp-preference",
  ],
  async (req, res) => {
    try {
      const { product, productKey, returnTo, customerEmail } = req.body || {};
      const selectedProductKey = productKey || product;
      const selected = products[selectedProductKey];

      if (!selected?.unitPrice) {
        return res.status(400).json({ error: "Produto inválido." });
      }

      const normalizedReturnTo = normalizeReturnPath(returnTo);

      const successUrl =
        `${BASE_URL}/sucesso` +
        `?produto=${encodeURIComponent(selectedProductKey)}` +
        `&return_to=${encodeURIComponent(normalizedReturnTo)}`;

      const failureUrlObj = new URL(normalizedReturnTo, BASE_URL);
      failureUrlObj.searchParams.set("cancelado", "1");

      const pendingUrl =
        `${BASE_URL}/sucesso` +
        `?pendente=1` +
        `&produto=${encodeURIComponent(selectedProductKey)}` +
        `&return_to=${encodeURIComponent(normalizedReturnTo)}`;

      const preferencePayload = {
        items: [
          {
            id: selectedProductKey,
            title: selected.productName,
            quantity: 1,
            unit_price: Number(selected.unitPrice),
            currency_id: "BRL",
          },
        ],
        payer: customerEmail ? { email: customerEmail } : undefined,
        external_reference: selectedProductKey,
        notification_url: `${BASE_URL}/webhook`,
        back_urls: {
          success: successUrl,
          failure: failureUrlObj.toString(),
          pending: pendingUrl,
        },
        auto_return: "approved",
        metadata: {
          product: selectedProductKey,
          product_key: selectedProductKey,
          product_name: selected.productName,
          return_to: normalizedReturnTo,
        },
      };

      const preference = await mpRequest("/checkout/preferences", {
        method: "POST",
        body: JSON.stringify(preferencePayload),
      });

      return res.json({
        url: preference.init_point,
        init_point: preference.init_point,
        sandbox_init_point: preference.sandbox_init_point || null,
        preference_id: preference.id,
      });
    } catch (error) {
      console.error("Erro ao criar preferência do Mercado Pago:", {
        message: error.message,
        status: error.status,
        data: error.data,
      });
      return res.status(500).json({ error: "Erro ao iniciar checkout." });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// VERIFICAR SESSÃO
// ─────────────────────────────────────────────────────────────
app.get(["/verificar-sessao", "/api/verificar-sessao"], async (req, res) => {
  try {
    const sessionId = req.query.session_id || req.query.payment_id;

    if (!sessionId) {
      return res.status(400).json({ error: "session_id obrigatório" });
    }

    const payment = await getMercadoPagoPayment(sessionId);
    const session = buildSessionFromMpPayment(payment);

    return res.json({
      id: session.id,
      status: session.payment_status,
      checkout_status: session.status,
      customer_email:
        session.customer_details?.email || session.customer_email || null,
      customer_name: session.customer_details?.name || null,
      customer_phone: session.customer_details?.phone || null,
      product_key:
        session.metadata?.product || session.metadata?.product_key || null,
      product_name: session.metadata?.product_name || null,
      mode: session.mode || null,
      amount_total: session.amount_total ?? null,
      raw_status_detail: payment.status_detail || null,
      payment_method_id: payment.payment_method_id || null,
      payment_type_id: payment.payment_type_id || null,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar pagamento:", err.message, err.data);
    return res.status(500).json({ error: "Erro ao verificar sessão." });
  }
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK MERCADO PAGO
// ─────────────────────────────────────────────────────────────
app.post(
  ["/webhook", "/api/webhook", "/mp-webhook", "/api/mp-webhook"],
  async (req, res) => {
    try {
      const body = req.body || {};

      if (!verifyMercadoPagoWebhookSignature(req)) {
        return res.status(401).json({ error: "Assinatura do webhook inválida." });
      }

      res.json({ received: true });

      const isPaymentEvent =
        body.type === "payment" ||
        body.action === "payment.created" ||
        body.action === "payment.updated" ||
        req.query.type === "payment" ||
        req.query.topic === "payment";

      if (!isPaymentEvent) {
        console.log("ℹ️ Evento Mercado Pago ignorado:", {
          type: body.type || null,
          action: body.action || null,
          topic: req.query.topic || null,
        });
        return;
      }

      const paymentId =
        body.data?.id ||
        req.query["data.id"] ||
        body.resource?.split("/").pop() ||
        null;

      if (!paymentId) {
        console.log("⚠️ Webhook Mercado Pago sem payment id:", body);
        return;
      }

      const payment = await getMercadoPagoPayment(paymentId);
      const session = buildSessionFromMpPayment(payment);

      if (isApprovedPaymentStatus(payment.status)) {
        await handleConfirmedSale(session);
      } else {
        console.log("ℹ️ Pagamento recebido, mas ainda não aprovado:", {
          paymentId: payment.id,
          status: payment.status,
          statusDetail: payment.status_detail,
          productKey:
            session.metadata?.product || session.metadata?.product_key || null,
          customerEmail:
            session.customer_details?.email || session.customer_email || null,
        });
      }
    } catch (error) {
      console.error("Erro ao processar webhook Mercado Pago:", {
        message: error.message,
        status: error.status,
        data: error.data,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// DOWNLOAD EBOOK
// ─────────────────────────────────────────────────────────────
app.get(["/download-ebook", "/api/download-ebook"], async (req, res) => {
  try {
    const paymentId = req.query.session_id || req.query.payment_id;

    if (!paymentId) {
      return res.status(400).send("Sessão não informada.");
    }

    const payment = await getMercadoPagoPayment(paymentId);
    const session = buildSessionFromMpPayment(payment);

    if (!isApprovedPaymentStatus(payment.status)) {
      return res.status(403).send("Pagamento ainda não confirmado.");
    }

    const allowedProducts = new Set([
      "ebook",
      "consultoria_avulsa",
      "consultoria_avulsa_entrada",
      "consultoria_premium",
      "consultoria_premium_entrada",
    ]);

    const productKey =
      session.metadata?.product || session.metadata?.product_key;

    if (!allowedProducts.has(productKey)) {
      return res.status(403).send("Produto sem acesso ao ebook.");
    }

    const ebookPath = path.join(
      PUBLIC_DIR,
      "downloads",
      "ebook-investimentos-para-iniciantes.pdf"
    );

    if (!fs.existsSync(ebookPath)) {
      return res.status(404).send("Arquivo do ebook não encontrado.");
    }

    return res.download(
      ebookPath,
      "ebook-investimentos-para-iniciantes.pdf"
    );
  } catch (error) {
    console.error("Erro no download do ebook:", {
      message: error.message,
      status: error.status,
      data: error.data,
    });
    return res.status(500).send("Erro ao liberar download.");
  }
});

// ─────────────────────────────────────────────────────────────
// FALLBACKS
// ─────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const requested = req.path.replace(/^\/+/, "");
  const candidate = path.join(PUBLIC_DIR, requested);

  if (
    requested &&
    fs.existsSync(candidate) &&
    fs.statSync(candidate).isFile()
  ) {
    return res.sendFile(candidate);
  }

  return res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

// ─────────────────────────────────────────────────────────────
// START / EXPORT
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em ${BASE_URL}`);
  });
}

module.exports = app;