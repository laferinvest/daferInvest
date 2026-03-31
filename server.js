require("dotenv").config();

const nodemailer = require("nodemailer");
const express = require("express");
const path = require("path");
const fs = require("fs");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
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
        finalAmount = roundMoney(Number(item.current_amount || 0) + suggestedContribution);
        actionLabel = `Aportar ${suggestedContribution.toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
        })}.`;
      } else if (delta < -0.004) {
        suggestedSale = roundMoney(Math.abs(delta));
        finalAmount = roundMoney(Number(item.current_amount || 0) - suggestedSale);
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
    rows.reduce((sum, item) => sum + Number(item.suggested_contribution || 0), 0)
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
    </table>
  `;

  const wrapEmail = (headerLabel, bodyHtml) => `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#f7f6f3;-webkit-font-smoothing:antialiased;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f6f3;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d4d1cb;">
              <tr>
                <td style="background:#0c0e13;padding:32px 40px;">
                  <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#a07c30;">${headerLabel}</p>
                  <p style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.2;">Daniel<span style="color:#a07c30;">.</span></p>
                </td>
              </tr>
              <tr><td style="padding:40px 40px 0;">${bodyHtml}</td></tr>
              <tr><td>${emailFooter}</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const subject = "Compra confirmada";
  const html = wrapEmail(
    "Confirmação de compra",
    `
      <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0c0e13;line-height:1.3;">Sua compra foi confirmada</h1>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Obrigado pela sua compra de <strong style="color:#0c0e13;">${productName}</strong>.
      </p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#2a2f42;line-height:1.8;">
        Seu ebook pode ser baixado pelo link abaixo. A sua área do investidor ficará disponível em <strong>${investorAreaUrl}</strong> assim que o seu usuário for criado no Supabase.
      </p>
      <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;">
        <tr>
          <td style="background:#a07c30;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Baixar ebook agora</a>
          </td>
        </tr>
      </table>
    `
  );

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject,
    html,
  });
}

async function sendAdminSaleEmail({
  buyerEmail,
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

  const html = `
    <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8" /></head>
    <body style="margin:0;padding:24px;background:#f7f6f3;font-family:Arial,sans-serif;color:#0c0e13;">
      <table width="100%">
        <tr>
          <td align="center">
            <table width="640" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d4d1cb;">
              <tr>
                <td style="background:#0c0e13;padding:24px 28px;">
                  <p style="margin:0;color:#fff;font-size:28px;font-family:Georgia,serif;">Daniel<span style="color:#a07c30;">.</span></p>
                </td>
              </tr>
              <tr>
                <td style="padding:28px;">
                  <h1 style="margin:0 0 20px;font-size:24px;font-family:Georgia,serif;">Você vendeu.</h1>
                  <p><strong>Produto:</strong> ${productName}</p>
                  <p><strong>Tipo:</strong> ${mode}</p>
                  <p><strong>Valor:</strong> ${amountFormatted}</p>
                  <p><strong>E-mail:</strong> ${buyerEmail || "Não informado"}</p>
                  <p><strong>Product key:</strong> ${productKey}</p>
                  <p><strong>Session ID:</strong> ${sessionId}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body></html>
  `;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: adminEmail,
    subject: `Nova venda confirmada · ${productName} · ${
      buyerEmail || "sem e-mail"
    }`,
    html,
  });
}

async function handleConfirmedSale(session) {
  const email = session.customer_details?.email || session.customer_email || null;
  const productKey = session.metadata?.product_key || "desconhecido";
  const productName = session.metadata?.product_name || "Produto";
  const amountTotal = session.amount_total ?? null;
  const mode = session.mode || "payment";

  if (email) {
    await sendPurchaseEmail({
      email,
      productKey,
      productName,
      sessionId: session.id,
    });
  }

  await sendAdminSaleEmail({
    buyerEmail: email,
    productKey,
    productName,
    sessionId: session.id,
    amountTotal,
    mode,
  });
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK STRIPE
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
          if (session.payment_status === "paid") {
            await handleConfirmedSale(session);
          }
          break;
        }

        case "checkout.session.async_payment_succeeded": {
          await handleConfirmedSale(event.data.object);
          break;
        }

        default:
          console.log("ℹ️ Evento Stripe recebido:", event.type);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Erro ao processar webhook:", err);
      return res.status(500).json({ error: "Erro interno no webhook" });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// MIDDLEWARES
// ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
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
      hasSupabaseUrl: Boolean(SUPABASE_URL),
      hasSupabaseAnonKey: Boolean(SUPABASE_ANON_KEY),
      hasSupabaseServiceRoleKey: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      baseUrl: BASE_URL,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// SUPABASE CONFIG PARA O FRONT
// ─────────────────────────────────────────────────────────────
app.get("/api/supabase-config", requireSupabase, (_req, res) => {
  res.json({
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
  });
});

// ─────────────────────────────────────────────────────────────
// ÁREA DO INVESTIDOR - DADOS DO CLIENTE
// ─────────────────────────────────────────────────────────────
app.get(
  "/api/investor/me",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    const user = req.investorUser;

    const { data, error } = await supabaseAdmin
      .from("userData")
      .select("*")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Erro ao buscar userData:", error);
      return res
        .status(500)
        .json({ error: "Erro ao buscar dados do investidor." });
    }

    if (!data) {
      return res
        .status(404)
        .json({ error: "Cadastro do investidor não encontrado." });
    }

    await supabaseAdmin
      .from("userData")
      .update({ last_client_access_at: new Date().toISOString() })
      .eq("auth_user_id", user.id);

    return res.json({
      authUser: {
        id: user.id,
        email: user.email,
      },
      investorData: data,
    });
  }
);

// ─────────────────────────────────────────────────────────────
// SALVAR POSIÇÃO DO DIA
// ─────────────────────────────────────────────────────────────
app.post(
  "/api/investor/snapshot",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    const user = req.investorUser;
    const { snapshotDate, currentPositions } = req.body || {};

    if (!snapshotDate || !Array.isArray(currentPositions)) {
      return res.status(400).json({
        error: "snapshotDate e currentPositions são obrigatórios.",
      });
    }

    const { data: currentRow, error: loadError } = await supabaseAdmin
      .from("userData")
      .select("allocation_history")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (loadError) {
      return res
        .status(500)
        .json({ error: "Erro ao carregar histórico atual." });
    }

    const allocationHistory = Array.isArray(currentRow?.allocation_history)
      ? currentRow.allocation_history
      : [];

    const nextHistory = [
      ...allocationHistory,
      {
        snapshotDate,
        capturedAt: new Date().toISOString(),
        positions: currentPositions,
      },
    ];

    const { error: updateError } = await supabaseAdmin
      .from("userData")
      .update({
        current_positions: currentPositions,
        allocation_history: nextHistory,
        last_snapshot_date: snapshotDate,
      })
      .eq("auth_user_id", user.id);

    if (updateError) {
      return res.status(500).json({ error: "Erro ao salvar snapshot." });
    }

    return res.json({ ok: true, allocationHistory: nextHistory });
  }
);

// ─────────────────────────────────────────────────────────────
// CALCULAR REBALANCEAMENTO
// ─────────────────────────────────────────────────────────────
app.post(
  "/api/investor/rebalance-plan",
  requireSupabase,
  requireInvestorAuth,
  async (req, res) => {
    try {
      const user = req.investorUser;
      const { snapshotDate, currentPositions, contributionAmount } =
        req.body || {};

      const parsedContribution =
        contributionAmount === "" ||
        contributionAmount === null ||
        contributionAmount === undefined
          ? 0
          : Number(contributionAmount);

      if (!snapshotDate) {
        return res.status(400).json({
          error: "A data da carteira é obrigatória.",
        });
      }

      if (!Array.isArray(currentPositions) || currentPositions.length === 0) {
        return res.status(400).json({
          error: "As posições atuais da carteira são obrigatórias.",
        });
      }

      if (Number.isNaN(parsedContribution) || parsedContribution < 0) {
        return res.status(400).json({
          error: "O novo aporte deve ser um número maior ou igual a zero.",
        });
      }

      const { data: investorData, error: investorError } = await supabaseAdmin
        .from("userData")
        .select("*")
        .eq("auth_user_id", user.id)
        .single();

      if (investorError || !investorData) {
        return res.status(404).json({
          error: "Dados do investidor não encontrados.",
        });
      }

      const targetMicro = Array.isArray(investorData.target_micro)
        ? investorData.target_micro
        : [];

      if (targetMicro.length === 0) {
        return res.status(400).json({
          error: "Não existe alocação micro cadastrada para este cliente.",
        });
      }

      const normalizedPositions = normalizePositions(currentPositions, targetMicro);

      const rebalanceBandPp = Number(investorData.rebalance_band_pp || 0);

      const result = buildRebalancePlan({
        positions: normalizedPositions,
        contributionAmount: parsedContribution,
        rebalanceBandPp,
      });

      const rebalanceHistory = Array.isArray(investorData.rebalance_history)
        ? investorData.rebalance_history
        : [];

      const eventRecord = {
        snapshotDate,
        createdAt: new Date().toISOString(),
        contributionAmount: result.contribution_amount,
        summary: {
          totalCurrent: result.total_current,
          totalAfterContribution: result.total_after_contribution,
          totalFinal: result.total_final,
          rebalanceBandPp: result.rebalance_band_pp,
          totalBuy: result.total_buy,
          totalSale: result.total_sale,
          assetsOutsideBand: result.assets_outside_band,
        },
        plan: result.plan,
      };

      await supabaseAdmin
        .from("userData")
        .update({ rebalance_history: [...rebalanceHistory, eventRecord] })
        .eq("auth_user_id", user.id);

      return res.json({
        ok: true,
        snapshotDate,
        contributionAmount: result.contribution_amount,
        summary: {
          totalCurrent: result.total_current,
          totalAfterContribution: result.total_after_contribution,
          totalFinal: result.total_final,
          rebalanceBandPp: result.rebalance_band_pp,
          totalBuy: result.total_buy,
          totalSale: result.total_sale,
          assetsOutsideBand: result.assets_outside_band,
        },
        plan: result.plan,
      });
    } catch (err) {
      console.error("❌ Erro ao calcular rebalanceamento:", err);
      return res.status(500).json({
        error: "Erro interno ao calcular rebalanceamento.",
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// CRIAR USUÁRIO DO INVESTIDOR NO SUPABASE
// ─────────────────────────────────────────────────────────────
app.post(
  "/admin/create-investor-user",
  requireSupabase,
  requireAdminSecret,
  async (req, res) => {
    const {
      email,
      password,
      clientName,
      planType = "consultoria_avulsa",
      clientStatus = "active",
      profileLabel = null,
      profileIndex = null,
      profileSummary = null,
      targetMacro = [],
      targetMicro = [],
    } = req.body || {};

    if (!email || !password || !clientName) {
      return res
        .status(400)
        .json({ error: "email, password e clientName são obrigatórios." });
    }

    const { data: created, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: clientName },
      });

    if (createError) {
      return res.status(400).json({ error: createError.message });
    }

    const authUserId = created.user?.id;

    const { error: upsertError } = await supabaseAdmin.from("userData").upsert({
      auth_user_id: authUserId,
      client_email: email,
      client_name: clientName,
      plan_type: planType,
      client_status: clientStatus,
      profile_label: profileLabel,
      profile_index: profileIndex,
      profile_summary: profileSummary,
      target_macro: targetMacro,
      target_micro: targetMicro,
    });

    if (upsertError) {
      return res.status(500).json({
        error: "Usuário Auth criado, mas falhou ao gravar userData.",
        details: upsertError.message,
        auth_user_id: authUserId,
      });
    }

    return res.json({
      ok: true,
      auth_user_id: authUserId,
      email,
      tempPassword: password,
      message:
        "Usuário do investidor criado com sucesso no Supabase Auth e em userData.",
    });
  }
);

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
      selectedProduct.mode === "subscription" ? ["card"] : ["card", "boleto"];

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
      checkout_status: session.status,
      customer_email:
        session.customer_details?.email || session.customer_email || null,
      product_key: session.metadata?.product_key || null,
      product_name: session.metadata?.product_name || null,
      mode: session.mode || null,
      amount_total: session.amount_total ?? null,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar sessão:", err.message);
    return res.status(500).json({ error: "Erro ao verificar sessão." });
  }
});

// ─────────────────────────────────────────────────────────────
// LIBERAR DOWNLOAD DO EBOOK
// ─────────────────────────────────────────────────────────────
app.get("/download-ebook", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!sessionId) {
    return res.status(400).send("session_id obrigatório");
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const isPaid = session.payment_status === "paid";
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

    const ebookPath = path.join(
      PUBLIC_DIR,
      "ebook",
      "Investimentos para Iniciantes.pdf"
    );

    if (!fs.existsSync(ebookPath)) {
      return res.status(404).send("Arquivo do ebook não encontrado.");
    }

    return res.download(ebookPath, "Investimentos-para-Iniciantes.pdf");
  } catch (err) {
    console.error("❌ Erro ao liberar download:", err.message);
    return res.status(500).send("Erro ao liberar download.");
  }
});

// ─────────────────────────────────────────────────────────────
// ROTAS DE PÁGINAS
// ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "index.html"))
);

app.get("/sucesso", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "sucesso.html"))
);

app.get("/entrar", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "entrar.html"))
);

app.get("/area-investidor", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "area-investidor.html"))
);

app.get("/politica-de-privacidade", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "politica-de-privacidade.html"))
);

app.get("/politica-de-cookies", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "politica-de-cookies.html"))
);

app.get("/termos-de-uso", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "termos-de-uso.html"))
);

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em ${BASE_URL}`);
  });
}

module.exports = app;