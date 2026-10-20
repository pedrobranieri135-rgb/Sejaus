import crypto from "node:crypto";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../lib/errors.js";

const SESSION_HOURS = 12;
export const SESSION_COOKIE = "us_admin";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const scrypt = (pw, salt, len) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key))));

// assíncrono: não trava o servidor enquanto calcula o hash
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// hash fixo para comparar mesmo quando o e-mail não existe (tempo de resposta igual)
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(crypto.randomBytes(12), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
})();

export const passwordSchema = z.string().min(10, "A senha precisa de pelo menos 10 caracteres").max(200);
export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }).strict();
export const adminSchema = z.object({
  name: z.string().trim().min(2).max(60),
  email: z.string().trim().toLowerCase().email().max(120),
  password: passwordSchema,
}).strict();

export async function login(db, email, password) {
  const admin = (await db.one("SELECT * FROM admins WHERE email = ?", [email]));
  const ok = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !ok) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  (await db.run("INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)", [sha256(token), admin.id, expires]));
  (await db.run("UPDATE admins SET last_login_at = now() WHERE id = ?", [admin.id]));
  (await db.run("DELETE FROM sessions WHERE expires_at < ?", [new Date().toISOString()]));
  return { token, maxAgeMs: SESSION_HOURS * 3600_000, admin: publicAdmin(admin) };
}

export async function sessionAdmin(db, token) {
  if (!token) return null;
  const row = (await db.one(`SELECT a.* FROM sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ?`, [sha256(token), new Date().toISOString()]));
  return row ? publicAdmin(row) : null;
}

export async function logout(db, token) {
  if (token) (await db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]));
}

const publicAdmin = (a) => ({ id: a.id, name: a.name, email: a.email, lastLoginAt: a.last_login_at, createdAt: a.created_at });

export async function listAdmins(db) {
  return (await db.all("SELECT * FROM admins ORDER BY id")).map(publicAdmin);
}

export async function createAdmin(db, input) {
  const a = adminSchema.parse(input);
  if ((await db.one("SELECT 1 FROM admins WHERE email = ?", [a.email]))) throw conflict("Já existe um usuário com esse e-mail");
  const row = await db.one("INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?) RETURNING *", [a.name, a.email, await hashPassword(a.password)]);
  return publicAdmin(row);
}

export async function deleteAdmin(db, id, currentId) {
  if (id === currentId) throw badRequest("Você não pode excluir o próprio usuário");
  if ((await db.one("SELECT COUNT(*) AS n FROM admins")).n <= 1) throw badRequest("A loja precisa de pelo menos um administrador");
  if ((await db.run("DELETE FROM admins WHERE id = ?", [id])).changes !== 1) throw notFound("Usuário não encontrado");
}

export async function changePassword(db, adminId, current, next) {
  const a = (await db.one("SELECT * FROM admins WHERE id = ?", [adminId]));
  if (!a || !(await verifyPassword(current, a.password_hash))) throw badRequest("Senha atual incorreta", { field: "current" });
  (await db.run("UPDATE admins SET password_hash = ? WHERE id = ?", [await hashPassword(passwordSchema.parse(next)), adminId]));
  // derruba as outras sessões desse usuário
  (await db.run("DELETE FROM sessions WHERE admin_id = ?", [adminId]));
}

/** Cria o primeiro admin a partir do .env (ou com senha aleatória exibida no terminal). */
export async function ensureBootstrapAdmin(db, config) {
  if ((await db.one("SELECT COUNT(*) AS n FROM admins")).n > 0) return null;
  const email = (config.adminEmail || "admin@sejaus.com.br").toLowerCase();
  const password = config.adminPassword || crypto.randomBytes(9).toString("base64url");
  // ON CONFLICT: duas instâncias subindo juntas não criam o admin duas vezes
  const r = await db.run("INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING",
    ["Administrador", email, await hashPassword(password)]);
  return r.changes ? { email, password, generated: !config.adminPassword } : null;
}

export async function audit(db, who, action, detail) {
  (await db.run("INSERT INTO admin_log (admin, action, detail) VALUES (?, ?, ?)", [who, action, detail == null ? null : String(detail).slice(0, 500)]));
}
