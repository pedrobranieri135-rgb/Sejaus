// Pagamento online (Mercado Pago, API de Orders): cria a cobrança do pedido, sincroniza o status
// (webhook, consulta do cliente na tela do Pix e rotina de expiração) e trata cancelamento/estorno.
import { HttpError } from "../lib/errors.js";
import { mpUnavailable, paymentState, rejectionMessage, summarize } from "../lib/mercadopago.js";
import { expireStaleOrders, updateOrderStatus } from "./checkout.js";

const firstName = (full) => String(full).trim().split(/\s+/)[0].slice(0, 40);

async function logEvent(db, orderId, source, mpStatus, detail) {
  await db.run("INSERT INTO payment_events (order_id, source, mp_status, detail) VALUES (?, ?, ?, ?)", [orderId, source, mpStatus, detail ? String(detail).slice(0, 300) : null]);
}

async function saveSummary(db, orderId, sm, extra = {}) {
  await db.run(`UPDATE orders SET payment_provider = 'mercadopago', mp_order_id = COALESCE(?, mp_order_id), mp_payment_id = COALESCE(?, mp_payment_id),
      payment_status = ?, payment_detail = ?, paid_cents = CASE WHEN ? > 0 THEN ? ELSE paid_cents END,
      installments = COALESCE(?, installments), card_brand = COALESCE(?, card_brand), payment_checked_at = now(), updated_at = now()
    WHERE id = ?`,
  [sm.mpOrderId, sm.mpPaymentId, extra.state ?? paymentState(sm), sm.statusDetail, sm.paidCents, sm.paidCents,
    sm.installments ?? null, sm.method && sm.method !== "pix" ? sm.method : null, orderId]);
}

/**
 * Inicia o pagamento logo após o pedido ser gravado (estoque já reservado).
 * Pix → QR Code do pedido. Cartão → cobra na hora; se recusado, cancela o pedido e devolve o estoque.
 */
export async function startPayment(db, config, mp, order, input) {
  // nome de teste ("APRO" aprova o Pix de teste) só vale com credencial de conta de TESTE; em produção, nunca
  const useTestName = config.mpTestPayerName && (await mp.isTestAccount());
  const payer = { email: input.customer.email, firstName: useTestName ? config.mpTestPayerName : firstName(input.customer.name) };

  if (input.payment === "pix") {
    let mpOrder;
    try {
      mpOrder = await mp.createPixOrder({ code: order.code, totalCents: order.totalCents, payer, expiresInHours: config.orderTtlHours });
    } catch (err) {
      console.error("[mercadopago] pix:", err.status, JSON.stringify(err.body ?? err.message).slice(0, 300));
      // pedido continua reservado; o cliente pode pagar pelo WhatsApp ou tentar de novo pela página do pedido
      await db.run("UPDATE orders SET payment_provider = 'mercadopago', payment_status = 'erro', payment_detail = ? WHERE code = ?", [`pix_indisponivel:${err.status}`, order.code]);
      return { error: "Não conseguimos gerar o Pix agora. Fale com a gente no WhatsApp para concluir o pagamento." };
    }
    const sm = summarize(mpOrder);
    const row = await db.one("SELECT id FROM orders WHERE code = ?", [order.code]);
    await saveSummary(db, row.id, sm);
    if (sm.pix) {
      await db.run("UPDATE orders SET pix_qr_code = ?, pix_qr_base64 = ?, pix_ticket_url = ?, pix_expires_at = now() + make_interval(hours => ?) WHERE id = ?",
        [sm.pix.qrCode, sm.pix.qrCodeBase64, sm.pix.ticketUrl, Math.min(Math.max(config.orderTtlHours, 1), 720), row.id]);
    }
    await logEvent(db, row.id, "criacao", sm.status, sm.statusDetail);
    return { state: paymentState(sm) };
  }

  if (input.payment === "cartao") {
    const card = input.card;
    let mpOrder;
    try {
      mpOrder = await mp.createCardOrder({ code: order.code, totalCents: order.totalCents, payer, card, attemptKey: card.token.slice(-12) });
    } catch (err) {
      console.error("[mercadopago] cartão:", err.status, JSON.stringify(err.body ?? err.message).slice(0, 300));
      await updateOrderStatus(db, config, order.code, "cancelado", "Falha ao processar o cartão");
      throw err.status >= 500 || err.status === 0 ? mpUnavailable() : new HttpError(402, "Não foi possível processar este cartão. Confira os dados ou pague com Pix.", { field: "card" });
    }
    const sm = summarize(mpOrder);
    const row = await db.one("SELECT id FROM orders WHERE code = ?", [order.code]);
    await saveSummary(db, row.id, sm);
    await logEvent(db, row.id, "criacao", sm.status, sm.statusDetail);
    const state = paymentState(sm);
    if (state === "pago") {
      await markPaid(db, config, order.code, sm, "Cartão aprovado");
      return { state };
    }
    if (state === "recusado" || state === "cancelado") {
      await updateOrderStatus(db, config, order.code, "cancelado", `Cartão recusado (${sm.statusDetail ?? "sem detalhe"})`);
      throw new HttpError(402, rejectionMessage(sm.statusDetail), { field: "card", reason: sm.statusDetail });
    }
    return { state }; // em análise: o webhook confirma depois
  }
  return null;
}

async function markPaid(db, config, code, sm, note) {
  const o = await db.one("SELECT id, status FROM orders WHERE code = ?", [code]);
  if (o.status === "aguardando_pagamento") {
    await updateOrderStatus(db, config, code, "pago", note);
    await db.run("UPDATE orders SET paid_at = COALESCE(paid_at, now()) WHERE id = ?", [o.id]);
  } else if (o.status === "cancelado") {
    // pagou depois de o pedido expirar: não reativa sozinho (o estoque pode ter sido vendido); avisa no painel
    await db.run("UPDATE orders SET payment_status = 'pago_apos_cancelamento', paid_at = COALESCE(paid_at, now()) WHERE id = ?", [o.id]);
    await db.run("INSERT INTO order_events (order_id, status, note) VALUES (?, 'cancelado', ?)", [o.id, "ATENÇÃO: pagamento aprovado depois do cancelamento. Estorne ou reative o pedido."]);
  }
}

/** Busca a situação real no Mercado Pago e aplica no pedido. Fonte da verdade: a API, nunca o corpo do webhook. */
export async function syncPayment(db, config, mp, { code, mpOrderId }, source = "consulta") {
  const order = code
    ? await db.one("SELECT * FROM orders WHERE code = ?", [code])
    : await db.one("SELECT * FROM orders WHERE mp_order_id = ?", [mpOrderId]);
  const id = mpOrderId || order?.mp_order_id;
  if (!id) return order ? { order, changed: false } : null;
  const mpOrder = await mp.getOrder(id);
  const sm = summarize(mpOrder);
  const local = order ?? (sm.externalReference ? await db.one("SELECT * FROM orders WHERE code = ?", [sm.externalReference]) : null);
  if (!local) return null;
  if (sm.externalReference && sm.externalReference !== local.code) return null; // order de outro pedido: ignora
  const state = paymentState(sm);
  const before = local.payment_status;
  await saveSummary(db, local.id, sm, { state: local.payment_status === "pago_apos_cancelamento" ? local.payment_status : state });
  if (before !== state) await logEvent(db, local.id, source, sm.status, sm.statusDetail);
  if (state === "pago") await markPaid(db, config, local.code, sm, source === "webhook" ? "Pagamento confirmado pelo Mercado Pago" : "Pagamento confirmado");
  if ((state === "cancelado" || state === "recusado") && local.status === "aguardando_pagamento") {
    await updateOrderStatus(db, config, local.code, "cancelado", state === "recusado" ? "Pagamento recusado" : "Pix expirado no Mercado Pago");
  }
  return { order: await db.one("SELECT * FROM orders WHERE id = ?", [local.id]), changed: before !== state };
}

/** Antes de expirar pedidos vencidos, confere no Mercado Pago (um Pix pago com webhook perdido não é cancelado). */
export async function expireWithSync(db, config, mp) {
  if (mp) {
    const cutoff = new Date(Date.now() - config.orderTtlHours * 3600_000).toISOString();
    const stale = await db.all("SELECT code FROM orders WHERE status = 'aguardando_pagamento' AND mp_order_id IS NOT NULL AND created_at < ? LIMIT 50", [cutoff]);
    for (const { code } of stale) {
      try {
        const r = await syncPayment(db, config, mp, { code }, "expiracao");
        if (r?.order?.status === "aguardando_pagamento" && r.order.mp_order_id) await mp.cancelOrder(r.order.mp_order_id).catch(() => {});
      } catch (err) { console.error("[expiração] sync", code, err.message); }
    }
  }
  return expireStaleOrders(db, config.orderTtlHours);
}

/** Pedidos aguardando que não tiveram retorno recente: confere em lote (painel aberto / cron). */
export async function syncPending(db, config, mp, { limit = 20, olderThanSec = 60 } = {}) {
  if (!mp) return 0;
  const rows = await db.all(`SELECT code FROM orders WHERE status = 'aguardando_pagamento' AND mp_order_id IS NOT NULL
    AND (payment_checked_at IS NULL OR payment_checked_at < now() - make_interval(secs => ?)) ORDER BY id DESC LIMIT ?`, [olderThanSec, limit]);
  let n = 0;
  for (const { code } of rows) {
    try { if ((await syncPayment(db, config, mp, { code }, "verificacao"))?.changed) n++; } catch (err) { console.error("[sync]", code, err.message); }
  }
  return n;
}

/** Cancelamento pelo painel: Pix pendente → cancela a cobrança; pagamento aprovado → estorna antes de cancelar. */
export async function cancelWithPayment(db, config, mp, code) {
  const o = await db.one("SELECT * FROM orders WHERE code = ?", [code]);
  if (!o || !mp || !o.mp_order_id) return { refunded: false };
  if (o.payment_status === "pago" || o.payment_status === "pago_apos_cancelamento") {
    try {
      const r = await mp.refundOrder(o.mp_order_id);
      const sm = summarize(r);
      await saveSummary(db, o.id, sm, { state: "estornado" });
      await logEvent(db, o.id, "estorno", sm.status, "estorno total pelo painel");
      return { refunded: true };
    } catch (err) {
      console.error("[mercadopago] estorno:", err.status, JSON.stringify(err.body ?? err.message).slice(0, 300));
      throw new HttpError(502, "O Mercado Pago não confirmou o estorno. Nada foi cancelado; tente de novo ou estorne pelo app do Mercado Pago.");
    }
  }
  if (o.payment_status === "pendente") await mp.cancelOrder(o.mp_order_id).catch(() => {});
  return { refunded: false };
}
