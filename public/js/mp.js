// Formulário de cartão do Mercado Pago (Card Payment Brick).
// Os dados do cartão são digitados em campos seguros do Mercado Pago; a loja recebe só um token de uso único.
const SDK_URL = "https://sdk.mercadopago.com/js/v2";

let sdkPromise = null;
let mpInstance = null;
let controller = null;

function loadSdk() {
  sdkPromise ??= new Promise((resolve, reject) => {
    if (window.MercadoPago) return resolve(window.MercadoPago);
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => (window.MercadoPago ? resolve(window.MercadoPago) : reject(new Error("SDK indisponível")));
    s.onerror = () => { sdkPromise = null; reject(new Error("Não foi possível carregar o pagamento com cartão. Verifique sua conexão.")); };
    document.head.append(s);
  });
  return sdkPromise;
}

export async function unmountCardBrick() {
  const c = controller;
  controller = null;
  try { await c?.unmount(); } catch { /* já removido junto com o HTML */ }
}

/**
 * Monta o formulário no elemento #containerId.
 * onSubmit recebe o cartão já tokenizado e deve devolver uma Promise (o botão "Pagar" fica carregando até ela terminar).
 */
export async function mountCardBrick(containerId, { publicKey, amountCents, email, cpf, maxInstallments, onSubmit, onError, onReady }) {
  await unmountCardBrick();
  const MercadoPago = await loadSdk();
  mpInstance ??= new MercadoPago(publicKey, { locale: "pt-BR" });
  if (!document.getElementById(containerId)) return; // o cliente trocou de etapa enquanto carregava
  controller = await mpInstance.bricks().create("cardPayment", containerId, {
    initialization: {
      amount: Number((amountCents / 100).toFixed(2)),
      payer: { email, ...(cpf ? { identification: { type: "CPF", number: cpf } } : {}) },
    },
    customization: {
      paymentMethods: { maxInstallments, minInstallments: 1, types: { excluded: ["debit_card"] } },
      visual: {
        hideFormTitle: true,
        texts: { formSubmit: "Pagar" },
        style: {
          theme: "flat",
          customVariables: {
            baseColor: "#000000",
            buttonTextColor: "#ffffff",
            borderRadiusMedium: "10px",
            borderRadiusLarge: "14px",
            fontSizeMedium: "15px",
            formBackgroundColor: "#ffffff",
          },
        },
      },
    },
    callbacks: {
      onReady: () => onReady?.(),
      onError: (err) => onError?.(err),
      onSubmit: (cardData) => onSubmit({
        token: cardData.token,
        paymentMethodId: cardData.payment_method_id,
        type: "credit_card",
        installments: Number(cardData.installments) || 1,
        issuerId: cardData.issuer_id ?? undefined,
        identification: cardData.payer?.identification?.number
          ? { type: cardData.payer.identification.type || "CPF", number: String(cardData.payer.identification.number).replace(/\D/g, "") }
          : undefined,
      }),
    },
  });
}
