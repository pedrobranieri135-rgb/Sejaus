// Gera o payload "Pix Copia e Cola" (BR Code / EMV estático) com CRC16-CCITT.

const field = (id, value) => `${id}${String(value.length).padStart(2, "0")}${value}`;

const ascii = (s, max) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 .-]/g, "").toUpperCase().slice(0, max);

export function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function pixPayload({ key, name, city, amountCents, txid }) {
  const account = field("00", "br.gov.bcb.pix") + field("01", key);
  const payload =
    field("00", "01") +
    field("26", account) +
    field("52", "0000") +
    field("53", "986") +
    field("54", (amountCents / 100).toFixed(2)) +
    field("58", "BR") +
    field("59", ascii(name, 25)) +
    field("60", ascii(city, 15)) +
    field("62", field("05", ascii(txid, 25).replace(/[^A-Z0-9]/g, "") || "***")) +
    "6304";
  return payload + crc16(payload);
}
