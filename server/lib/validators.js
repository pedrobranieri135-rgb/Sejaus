import { z } from "zod";

export const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

export const onlyDigits = (s) => String(s ?? "").replace(/\D/g, "");

export function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

// remove caracteres de controle e espaços duplicados
const clean = (s) => s.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
const text = (min, max, label) =>
  z.string({ required_error: `${label} é obrigatório` }).transform(clean)
    .pipe(z.string().min(min, `${label} é obrigatório`).max(max, `${label} muito longo`));

export const cepSchema = z.string().transform(onlyDigits).pipe(z.string().length(8, "CEP inválido"));
export const couponSchema = z.string().transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9_-]{2,30}$/, "Cupom inválido"));

export const itemsSchema = z.array(z.object({
  sku: z.coerce.number().int().positive(),
  qty: z.coerce.number().int().min(1, "Quantidade mínima é 1").max(10, "Máximo de 10 unidades por item"),
}).strict()).min(1, "Carrinho vazio").max(20, "Itens demais no carrinho");

export const quoteSchema = z.object({
  items: itemsSchema,
  cep: cepSchema.optional(),
  coupon: couponSchema.optional().or(z.literal("").transform(() => undefined)),
}).strict();

export const orderSchema = z.object({
  items: itemsSchema,
  customer: z.object({
    name: text(3, 80, "Nome").refine((s) => s.includes(" "), "Informe nome e sobrenome"),
    email: z.string().trim().toLowerCase().email("E-mail inválido").max(120),
    phone: z.string().transform(onlyDigits).pipe(z.string().regex(/^\d{10,11}$/, "Telefone inválido (DDD + número)")),
    cpf: z.string().transform(onlyDigits).refine(isValidCpf, "CPF inválido"),
  }).strict(),
  address: z.object({
    cep: cepSchema,
    street: text(2, 120, "Rua"),
    number: text(1, 10, "Número"),
    complement: z.string().transform(clean).pipe(z.string().max(60)).optional().default(""),
    district: text(2, 60, "Bairro"),
    city: text(2, 60, "Cidade"),
    state: z.string().trim().toUpperCase().refine((s) => UFS.includes(s), "UF inválida"),
  }).strict(),
  shipping: z.enum(["padrao", "expresso"], { errorMap: () => ({ message: "Escolha a forma de entrega" }) }),
  payment: z.enum(["pix", "cartao", "whatsapp"], { errorMap: () => ({ message: "Escolha a forma de pagamento" }) }),
  // cartão: só o token gerado pelo formulário do Mercado Pago (número/CVV nunca chegam aqui)
  card: z.object({
    token: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, "Cartão inválido"),
    paymentMethodId: z.string().regex(/^[a-z_]{2,30}$/),
    type: z.enum(["credit_card", "debit_card"]).default("credit_card"),
    installments: z.coerce.number().int().min(1).max(12),
    issuerId: z.union([z.string(), z.number()]).optional(),
    identification: z.object({ type: z.string().max(10), number: z.string().regex(/^\d{11,14}$/) }).strict().optional(),
  }).strict().optional(),
  coupon: couponSchema.optional().or(z.literal("").transform(() => undefined)),
}).strict();

export const newsletterSchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(120),
}).strict();

export const trackSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^US-[A-Z0-9]{6}$/, "Código inválido"),
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(120),
});

export const ORDER_STATUSES = ["aguardando_pagamento", "pago", "em_separacao", "enviado", "entregue", "cancelado"];

export const statusUpdateSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().max(200).optional(),
}).strict();

export const stockUpdateSchema = z.object({
  qty: z.coerce.number().int().min(0).max(100000),
}).strict();

/** Converte ZodError em { campo: mensagem } legível para o front. */
export function formatZodError(err) {
  const fields = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}
