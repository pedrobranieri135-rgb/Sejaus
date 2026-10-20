export const CARRIERS = { correios: "Correios", jadlog: "Jadlog", loggi: "Loggi", "j&t": "J&T Express", outro: "Outra transportadora" };

/** Detecta a transportadora pelo formato do código (padrão Correios: AA123456789BR). */
export function detectCarrier(code) {
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(code)) return "correios";
  if (/^\d{14}$/.test(code)) return "jadlog";
  return "outro";
}

// Melhor Rastreio consulta Correios, Jadlog, Loggi e outras pelo mesmo código
export const trackingUrl = (code) => `https://www.melhorrastreio.com.br/rastreio/${encodeURIComponent(code)}`;
