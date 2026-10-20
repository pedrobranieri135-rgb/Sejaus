// Tabela de frete demonstrativa por região (1º dígito do CEP). Troque por Melhor Envio/Correios em produção.
const TABLE = {
  0: { region: "SP (capital/RM)", padrao: [1490, 3, 5], expresso: [2490, 1, 2] },
  1: { region: "SP (interior)", padrao: [1690, 3, 6], expresso: [2690, 1, 3] },
  2: { region: "RJ / ES", padrao: [1890, 4, 7], expresso: [2990, 2, 3] },
  3: { region: "MG", padrao: [1890, 4, 7], expresso: [2990, 2, 3] },
  4: { region: "BA / SE", padrao: [2490, 6, 9], expresso: [3990, 3, 4] },
  5: { region: "PE / AL / PB / RN", padrao: [2690, 7, 10], expresso: [4290, 3, 5] },
  6: { region: "CE / PI / MA / Norte", padrao: [2990, 8, 12], expresso: [4990, 4, 6] },
  7: { region: "Centro-Oeste / TO / RO / AC", padrao: [2490, 5, 9], expresso: [3990, 2, 4] },
  8: { region: "PR / SC", padrao: [1990, 4, 7], expresso: [3290, 2, 3] },
  9: { region: "RS", padrao: [2190, 5, 8], expresso: [3490, 2, 4] },
};

export function shippingOptions(cep, subtotalAfterDiscount, freeShippingCents, { freeCoupon = false } = {}) {
  const row = TABLE[Number(cep[0])];
  const free = freeCoupon || subtotalAfterDiscount >= freeShippingCents;
  const opt = (id, label, [price, min, max]) => ({
    id, label, priceCents: id === "padrao" && free ? 0 : price, originalCents: price, days: [min, max],
  });
  return {
    region: row.region,
    freeShippingCents,
    remainingForFree: Math.max(0, freeShippingCents - subtotalAfterDiscount),
    options: [opt("padrao", "Entrega padrão", row.padrao), opt("expresso", "Entrega expressa", row.expresso)],
  };
}
