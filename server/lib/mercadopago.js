// Cliente da API de Orders do Mercado Pago (Checkout Transparente).
// Docs: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders
import crypto from "node:crypto";
import { HttpError } from "./errors.js";

const API = "https://api.mercadopago.com";
const money = (cents) => (cents / 100).toFixed(2); // a API recebe valores como texto "123.45"

export class MercadoPagoError extends Error {
  constructor(status, body) {
    super(body?.message || body?.errors?.[0]?.message || `Mercado Pago respondeu ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function createMercadoPago({ accessToken, timeoutMs = 15_000 }) {
  if (!accessToken) return null;

  async function call(method, path, { body, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
    let res;
    try {
      res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new MercadoPagoError(0, { message: `Sem resposta do Mercado Pago (${err.name})` });
    }
    const data = await res.json().catch(() => ({}));
    // 402 = pagamento recusado: a order existe (status "failed") e o motivo vem em errors[].details
    if (res.status === 402 && data?.data?.id) {
      const reason = String(data.errors?.[0]?.details?.[0] ?? "").split(":").pop().trim() || null;
      return { ...data.data, _rejection: reason };
    }
    if (!res.ok) throw new MercadoPagoError(res.status, data);
    return data;
  }

  return {
    /** Pix: QR Code exclusivo do pedido, com prazo. */
    createPixOrder({ code, totalCents, payer, expiresInHours }) {
      const hours = Math.min(Math.max(expiresInHours, 1), 24 * 30); // Mercado Pago: mínimo 30 min, máximo 30 dias
      return call("POST", "/v1/orders", {
        idempotencyKey: `pix-${code}`,
        body: {
          type: "online",
          processing_mode: "automatic",
          external_reference: code,
          total_amount: money(totalCents),
          payer: { email: payer.email, first_name: payer.firstName },
          transactions: {
            payments: [{ amount: money(totalCents), payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: `PT${hours}H` }],
          },
        },
      });
    },

    /** Cartão: o token vem do formulário do Mercado Pago no navegador (os dados do cartão não passam pela loja). */
    createCardOrder({ code, totalCents, payer, card, attemptKey }) {
      return call("POST", "/v1/orders", {
        idempotencyKey: `card-${code}-${attemptKey}`,
        body: {
          type: "online",
          processing_mode: "automatic",
          external_reference: code,
          total_amount: money(totalCents),
          payer: {
            email: payer.email,
            first_name: payer.firstName,
            ...(card.identification ? { identification: card.identification } : {}),
          },
          transactions: {
            payments: [{
              amount: money(totalCents),
              payment_method: { id: card.paymentMethodId, type: card.type || "credit_card", token: card.token, installments: card.installments },
            }],
          },
        },
      });
    },

    getOrder: (id) => call("GET", `/v1/orders/${encodeURIComponent(id)}`),
    /** A credencial é de conta de teste? (consulta 1x por instância) */
    isTestAccount() {
      this._test ??= call("GET", "/users/me").then((u) => (u.tags || []).includes("test_user")).catch(() => false);
      return this._test;
    },
    cancelOrder: (id) => call("POST", `/v1/orders/${encodeURIComponent(id)}/cancel`, { idempotencyKey: `cancel-${id}` }),
    refundOrder: (id) => call("POST", `/v1/orders/${encodeURIComponent(id)}/refund`, { idempotencyKey: `refund-${id}` }),
  };
}

/** Lê o resultado de uma order do Mercado Pago no formato que a loja usa. */
export function summarize(mpOrder) {
  const pay = mpOrder?.transactions?.payments?.[0] ?? {};
  const pm = pay.payment_method ?? {};
  return {
    mpOrderId: mpOrder?.id ?? null,
    mpPaymentId: pay.id ?? null,
    status: mpOrder?.status ?? null, // processed | action_required | processing | canceled | refunded | failed | expired
    statusDetail: mpOrder?._rejection ?? pay.status_detail ?? mpOrder?.status_detail ?? null,
    paymentStatusDetail: pay.status_detail ?? null,
    externalReference: mpOrder?.external_reference ?? null,
    paidCents: mpOrder?.status === "processed" ? Math.round(Number(mpOrder?.total_paid_amount ?? mpOrder?.total_amount ?? 0) * 100) : 0,
    totalCents: Math.round(Number(mpOrder?.total_amount ?? 0) * 100),
    pix: pm.qr_code ? { qrCode: pm.qr_code, qrCodeBase64: pm.qr_code_base64, ticketUrl: pm.ticket_url } : null,
    method: pm.id ?? null,
    installments: pm.installments ?? null,
  };
}

/** "pago" | "pendente" | "recusado" | "cancelado" | "estornado" */
export function paymentState(summary) {
  const s = summary.status;
  if (s === "processed") return "pago";
  if (s === "refunded") return "estornado";
  if (s === "canceled" || s === "expired") return "cancelado";
  if (s === "failed") return "recusado";
  return "pendente"; // action_required, processing, created…
}

// Mensagens amigáveis para recusas de cartão (status_detail da API).
const REJECTIONS = {
  rejected_insufficient_amount: "Saldo ou limite insuficiente. Tente outro cartão.",
  insufficient_amount: "Saldo ou limite insuficiente. Tente outro cartão.",
  rejected_bad_filled_security_code: "Código de segurança (CVV) incorreto.",
  bad_filled_security_code: "Código de segurança (CVV) incorreto.",
  rejected_bad_filled_date: "Data de validade incorreta.",
  bad_filled_date: "Data de validade incorreta.",
  rejected_bad_filled_other: "Confira os dados do cartão e tente de novo.",
  bad_filled_other: "Confira os dados do cartão e tente de novo.",
  rejected_call_for_authorize: "O banco pediu autorização. Ligue para o seu banco e tente novamente.",
  call_for_authorize: "O banco pediu autorização. Ligue para o seu banco e tente novamente.",
  rejected_card_disabled: "Cartão desabilitado. Ative o cartão com o banco ou use outro.",
  card_disabled: "Cartão desabilitado. Ative o cartão com o banco ou use outro.",
  rejected_duplicated_payment: "Pagamento duplicado. Se já pagou, confira seus pedidos.",
  rejected_high_risk: "Pagamento recusado pela análise de segurança. Tente outro cartão ou Pix.",
  high_risk: "Pagamento recusado pela análise de segurança. Tente outro cartão ou Pix.",
  rejected_max_attempts: "Muitas tentativas com este cartão. Use outro cartão ou Pix.",
  rejected_by_issuer: "O banco emissor recusou o pagamento. Tente outro cartão ou pague com Pix.",
  rejected_other_reason: "Pagamento recusado. Tente outro cartão ou pague com Pix.",
  rejected_insufficient_data: "Faltaram dados do cartão. Confira e tente de novo.",
  rejected_card_type_not_allowed: "Esse tipo de cartão não é aceito. Use um cartão de crédito.",
  rejected_blacklist: "Pagamento recusado. Tente outro cartão ou pague com Pix.",
  rejected_invalid_installments: "Número de parcelas indisponível para este cartão.",
  max_attempts: "Muitas tentativas com este cartão. Use outro cartão ou Pix.",
};
export const rejectionMessage = (detail) => REJECTIONS[detail] || "Pagamento recusado pelo cartão. Tente outro cartão ou pague com Pix.";

/**
 * Valida a assinatura do webhook (x-signature) conforme a documentação do Mercado Pago:
 * manifest "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" assinado com HMAC-SHA256 (hex) usando a chave secreta do webhook.
 */
export function verifyWebhookSignature({ xSignature, xRequestId, dataId, secret, toleranceMs = 15 * 60_000, now = Date.now() }) {
  if (!secret || !xSignature) return false;
  const parts = Object.fromEntries(String(xSignature).split(",").map((p) => p.trim().split("=").map((s) => s.trim())));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  // ts pode vir em segundos ou milissegundos
  const tsMs = ts.length > 11 ? Number(ts) : Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > toleranceMs) return false;
  let manifest = "";
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  const ok = (m) => crypto.timingSafeEqual(Buffer.from(crypto.createHmac("sha256", secret).update(m).digest("hex")), Buffer.from(v1.toLowerCase()));
  // alguns ids alfanuméricos são assinados como recebidos (maiúsculas); aceita as duas formas
  if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1.toLowerCase()))) return true;
  const raw = `${dataId ? `id:${dataId};` : ""}${xRequestId ? `request-id:${xRequestId};` : ""}ts:${ts};`;
  return ok(raw);
}

export const mpUnavailable = () => new HttpError(503, "O pagamento online está indisponível agora. Tente Pix novamente em instantes ou finalize pelo WhatsApp.");
