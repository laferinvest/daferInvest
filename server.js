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
                <td style="background:#0c0e13;padding:18px 40px;border-bottom:1px solid rgba(255,255,255,0.08);">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#a07c30;font-weight:700;">
                    ${headerLabel}
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:40px;">
                  ${bodyHtml}
                </td>
              </tr>
              <tr>
                <td>
                  ${emailFooter}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  let subject = "";
  let html = "";

  if (productKey === "ebook") {
    subject = "Seu ebook já está disponível";
    html = wrapEmail(
      "Compra confirmada",
      `
      <h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:28px;line-height:1.25;color:#0c0e13;font-weight:700;">
        Pagamento confirmado.
      </h1>
      <p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#232737;">
        Seu acesso ao <strong>${productName}</strong> foi liberado.
      </p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#232737;">
        Para baixar o material, use o botão abaixo.
      </p>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
        <tr>
          <td align="center" style="background:#a07c30;">
            <a href="${downloadUrl}" style="display:inline-block;padding:14px 24px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Baixar ebook
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.8;color:#58607a;">
        Se tiver qualquer dificuldade, basta responder este e-mail.
      </p>
      `
    );
  } else {
    subject = "Compra confirmada · próximos passos da sua consultoria";
    html = wrapEmail(
      "Compra confirmada",
      `
      <h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:28px;line-height:1.25;color:#0c0e13;font-weight:700;">
        Pagamento confirmado.
      </h1>
      <p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#232737;">
        Sua compra de <strong>${productName}</strong> foi confirmada.
      </p>
      <p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#232737;">
        A partir de agora, o processo segue pela sua área do investidor.
      </p>
      <ol style="margin:0 0 24px 18px;padding:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.9;color:#232737;">
        <li>Você acessa sua área do investidor.</li>
        <li>Preenche o questionário inicial.</li>
        <li>Eu analiso suas informações e entro em contato para os próximos passos.</li>
      </ol>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
        <tr>
          <td align="center" style="background:#a07c30;">
            <a href="${investorAreaUrl}" style="display:inline-block;padding:14px 24px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
              Entrar na área do investidor
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.8;color:#58607a;">
        O ebook também está incluído e poderá ser acessado conforme a liberação do seu processo.
      </p>
      `
    );
  }

  await transporter.sendMail({
    from: `"Daniel Ferreira" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to: email,
    subject,
    html,
  });
}

function isStripeSessionPaid(session) {
  if (!session) return false;

  if (session.payment_status === "paid") return true;
  if (session.status === "complete" && session.payment_status === "no_payment_required") {
    return true;
  }

  return false;
}

function normalizeReturnPath(input) {
  if (!input || typeof input !== "string") return "/";

  try {
    const urlObj = new URL(input, "http://dummy.com");
    
    let rawPath = urlObj.pathname;
    
    if (rawPath === "/index") rawPath = "/index.html";
    if (rawPath === "/consultoria") rawPath = "/consultoria.html";
    if (rawPath === "/ebook") rawPath = "/ebook.html";

    const safePaths = new Set(["/", "/index.html", "/consultoria.html", "/ebook.html"]);

    if (!safePaths.has(rawPath)) {
      return "/";
    }

    return `${rawPath}${urlObj.search}${urlObj.hash}`;
  } catch (_) {
    return "/";
  }
}

function absoluteUrlFromPath(pathname) {
  return new URL(pathname, BASE_URL).toString();
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARES
// ─────────────────────────────────────────────────────────────
app.use(
  "/webhook",
  express.raw({
    type: "application/json",
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ─────────────────────────────────────────────────────────────
// ROTAS ESTÁTICAS
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/consultoria", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "consultoria.html"));
});

app.get("/ebook", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "ebook.html"));
});

app.get("/consultoria", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "consultoria.html"));
});

app.get("/sucesso", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "sucesso.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// AUTH / INVESTOR AREA
// ─────────────────────────────────────────────────────────────
app.get("/entrar", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "entrar.html"));
});

app.get("/area-investidor", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "area-investidor.html"));
});

app.get("/admin-dashboard", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin-dashboard.html"));
});

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

      if (error) {
        throw error;
      }

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

      if (error) {
        throw error;
      }

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

      if (listError) {
        throw listError;
      }

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

        if (createError) {
          throw createError;
        }

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

      if (profileError) {
        throw profileError;
      }

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

      if (error) {
        throw error;
      }

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

      if (error) {
        throw error;
      }

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

      if (error) {
        throw error;
      }

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

      if (loadError) {
        throw loadError;
      }

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
        String(a?.snapshotDate || "").localeCompare(String(b?.snapshotDate || ""))
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

      if (error) {
        throw error;
      }

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

      const snapshotDate = req.body?.snapshotDate || req.body?.snapshot_date || null;

      const rawCurrentPositions =
        req.body?.currentPositions || req.body?.current_positions || [];

      const { data: investorData, error } = await supabaseAdmin
        .from(INVESTOR_TABLE)
        .select("target_micro, rebalance_band_pp, rebalance_history")
        .eq(INVESTOR_PK, user.id)
        .maybeSingle();

      if (error) {
        throw error;
      }

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
            const adjustedFinalAmount = roundMoney(Number(item.current_amount || 0));
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
                  ? `Aportar ${Number(item.suggested_contribution || 0).toLocaleString("pt-BR", {
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

      if (error) {
        throw error;
      }

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
// STRIPE CHECKOUT
// ─────────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { product, returnTo } = req.body || {};
    const selected = products[product];

    if (!selected?.priceId) {
      return res.status(400).json({ error: "Produto inválido." });
    }

    const normalizedReturnTo = normalizeReturnPath(returnTo);
    const successUrl = new URL("/sucesso", BASE_URL);

    successUrl.search = "";
    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
    successUrl.searchParams.set("produto", product);
    successUrl.searchParams.set("return_to", normalizedReturnTo);

    const cancelUrlObj = new URL(normalizedReturnTo, BASE_URL);
    cancelUrlObj.searchParams.set("cancelado", "1");

    const session = await stripe.checkout.sessions.create({
      mode: selected.mode,
      line_items: [
        {
          price: selected.priceId,
          quantity: 1,
        },
      ],
      billing_address_collection: "required",
      phone_number_collection: {
        enabled: true,
      },
      locale: "pt-BR",
      allow_promotion_codes: true,
      success_url: successUrl.toString(),
      cancel_url: cancelUrlObj.toString(),
      metadata: {
        product,
        product_name: selected.productName,
        return_to: normalizedReturnTo,
      },
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("Erro ao criar sessão de checkout:", error);
    return res.status(500).json({ error: "Erro ao iniciar checkout." });
  }
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK STRIPE
// ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error("⚠️ Erro na assinatura do webhook:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (!isStripeSessionPaid(session)) {
        return res.status(200).json({ received: true });
      }

      const customerEmail =
        session.customer_details?.email || session.customer_email;
      const productKey = session.metadata?.product;
      const productName =
        session.metadata?.product_name || products[productKey]?.productName;

      if (customerEmail && productKey && productName) {
        await sendPurchaseEmail({
          email: customerEmail,
          productKey,
          productName,
          sessionId: session.id,
        });
      }
    }

    if (event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;

      const customerEmail =
        session.customer_details?.email || session.customer_email;
      const productKey = session.metadata?.product;
      const productName =
        session.metadata?.product_name || products[productKey]?.productName;

      if (customerEmail && productKey && productName) {
        await sendPurchaseEmail({
          email: customerEmail,
          productKey,
          productName,
          sessionId: session.id,
        });
      }
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Erro ao processar webhook:", error);
    return res.status(500).json({ error: "Erro ao processar webhook." });
  }
});

// ─────────────────────────────────────────────────────────────
// DOWNLOAD EBOOK
// ─────────────────────────────────────────────────────────────
app.get("/download-ebook", async (req, res) => {
  try {
    const sessionId = req.query.session_id;

    if (!sessionId) {
      return res.status(400).send("Sessão não informada.");
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!isStripeSessionPaid(session)) {
      return res.status(403).send("Pagamento ainda não confirmado.");
    }

    const allowedProducts = new Set([
      "ebook",
      "consultoria_avulsa",
      "consultoria_mensal",
      "consultoria_premium",
    ]);

    const productKey = session.metadata?.product;

    if (!allowedProducts.has(productKey)) {
      return res.status(403).send("Produto sem acesso ao ebook.");
    }

    const ebookPath = path.join(PUBLIC_DIR, "Daniel Ferreira - Ebook de Investimentos para Iniciantes.pdf");

    if (!fs.existsSync(ebookPath)) {
      return res.status(404).send("Arquivo do ebook não encontrado.");
    }

    return res.download(
      ebookPath,
      "Daniel Ferreira - Ebook de Investimentos para Iniciantes.pdf"
    );
  } catch (error) {
    console.error("Erro no download do ebook:", error);
    return res.status(500).send("Erro ao liberar download.");
  }
});

// ─────────────────────────────────────────────────────────────
// FALLBACKS
// ─────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const requested = req.path.replace(/^\/+/, "");
  const candidate = path.join(PUBLIC_DIR, requested);

  if (requested && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return res.sendFile(candidate);
  }

  return res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em ${BASE_URL}`);
});