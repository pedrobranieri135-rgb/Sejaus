import {
  $, api, confirmBox, errorToast, esc, fmtDate, frame, loading, moneyField, parseMoney, pill, showFieldErrors, state, toast, view,
} from "./core.js";

const ACTIONS = {
  login: "entrou no painel", login_falhou: "errou a senha", senha_alterada: "trocou a senha", status_pedido: "mudou o status do pedido",
  rastreio: "informou rastreio", produto_criado: "criou o produto", produto_editado: "editou o produto", produto_ativado: "ativou o produto",
  produto_pausado: "pausou o produto", produto_excluido: "excluiu o produto", precos_em_massa: "alterou preços em massa", upload_foto: "enviou foto",
  estoque: "ajustou estoque", cupom_criado: "criou o cupom", cupom_editado: "editou o cupom", cupom_excluido: "excluiu o cupom",
  cupom_desativado: "desativou o cupom", exportou_pedidos: "exportou pedidos", exportou_clientes: "exportou clientes",
  configuracoes: "alterou configurações", usuario_criado: "adicionou o usuário", usuario_excluido: "removeu um usuário",
};

export async function settingsView() {
  frame("Configurações");
  loading();
  const [s, users, log] = await Promise.all([api("/settings"), api("/users"), api("/log")]);
  const e = s.effective;
  view().innerHTML = `
    <form class="form-section" id="store-form" novalidate>
      <h2>Loja</h2>
      <div class="fgrid">
        <label class="field s3"><span>WhatsApp da loja <span class="hint">(DDI + DDD + número)</span></span><input name="whatsapp" value="${esc(e.whatsapp)}" inputmode="tel"></label>
        <label class="field s3"><span>Faixa de aviso no topo do site</span><input name="announcement" value="${esc(e.announcement)}" maxlength="160"></label>
        <label class="field s2"><span>Chave Pix</span><input name="pixKey" value="${esc(e.pixKey)}" maxlength="77"></label>
        <label class="field s2"><span>Nome no Pix <span class="hint">(até 25)</span></span><input name="pixMerchantName" value="${esc(e.pixMerchantName)}" maxlength="25"></label>
        <label class="field s2"><span>Cidade no Pix <span class="hint">(até 15)</span></span><input name="pixMerchantCity" value="${esc(e.pixMerchantCity)}" maxlength="15"></label>
        <div class="field s3"><span>Frete grátis a partir de</span><span class="money-input"><input name="freeShippingCents" inputmode="decimal" value="${moneyField(e.freeShippingCents)}"></span></div>
        <label class="field s3"><span>Prazo para pagar o pedido (horas) <span class="hint">depois disso cancela e devolve o estoque</span></span><input name="orderTtlHours" type="number" min="1" max="240" value="${e.orderTtlHours}"></label>
      </div>
      <div class="actions-row"><button class="btn btn-dark" type="submit">Salvar configurações</button><a class="btn btn-ghost" href="https://wa.me/${esc(e.whatsapp)}" target="_blank" rel="noopener">Testar WhatsApp</a></div>
    </form>

    <div class="grid-2">
      <section class="form-section"><h2>Usuários do painel</h2>
        <ul class="alert-list">${users.map((u) => `<li><span><b>${esc(u.name)}</b><br><span class="muted">${esc(u.email)} · último acesso ${u.lastLoginAt ? fmtDate(u.lastLoginAt) : "nunca"}</span></span>
          ${u.id === state.me.id ? pill("on", "Você") : `<button class="btn btn-ghost btn-sm" data-del-user="${u.id}" data-name="${esc(u.name)}">Remover</button>`}</li>`).join("")}</ul>
        <form id="user-form" class="fgrid" novalidate>
          <label class="field s3"><span>Nome</span><input name="name" maxlength="60" required></label>
          <label class="field s3"><span>E-mail</span><input name="email" type="email" required></label>
          <label class="field s4"><span>Senha inicial <span class="hint">(mín. 10 caracteres)</span></span><input name="password" type="password" minlength="10" autocomplete="new-password" required></label>
          <button class="btn btn-dark s2" type="submit" style="align-self:end">Adicionar</button>
        </form>
      </section>
      <form class="form-section" id="pass-form" novalidate><h2>Minha senha</h2>
        <label class="field"><span>Senha atual</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>Nova senha <span class="hint">(mín. 10 caracteres)</span></span><input name="next" type="password" autocomplete="new-password" minlength="10" required></label>
        <button class="btn btn-dark" type="submit" style="justify-self:start">Trocar senha</button>
        <p class="muted">Depois de trocar, você entra de novo com a senha nova.</p>
      </form>
    </div>

    <section class="card-box"><div class="box-head"><h2>Atividade recente</h2><span class="muted">quem fez o quê no painel</span></div>
      <ul class="log-list">${log.length ? log.slice(0, 60).map((l) => `<li><span class="muted">${fmtDate(l.at)}</span><span><b>${esc(l.admin)}</b> ${esc(ACTIONS[l.action] || l.action)}${l.detail ? ` <span class="muted">${esc(l.detail)}</span>` : ""}</span></li>`).join("") : "<li>Nada registrado ainda.</li>"}</ul>
    </section>`;

  $("#store-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      whatsapp: f.whatsapp.value, announcement: f.announcement.value, pixKey: f.pixKey.value, pixMerchantName: f.pixMerchantName.value,
      pixMerchantCity: f.pixMerchantCity.value, freeShippingCents: parseMoney(f.freeShippingCents.value) ?? 0, orderTtlHours: Number(f.orderTtlHours.value),
    };
    try {
      await api("/settings", { method: "PUT", body });
      showFieldErrors(f, null);
      toast("Configurações salvas. A loja já usa os novos dados.");
    } catch (err) { if (!showFieldErrors(f, err)) errorToast(err); }
  });
  $("#user-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api("/users", { method: "POST", body: { name: f.name.value, email: f.email.value, password: f.password.value } });
      toast("Usuário adicionado");
      settingsView();
    } catch (err) { if (!showFieldErrors(f, err)) errorToast(err); }
  });
  $("#pass-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api("/me/password", { method: "POST", body: { current: f.current.value, next: f.next.value } });
      toast("Senha trocada. Entre novamente.");
      setTimeout(() => location.reload(), 1200);
    } catch (err) { if (!showFieldErrors(f, err)) errorToast(err); }
  });
  view().addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-del-user]");
    if (!b) return;
    if (!(await confirmBox(`Remover o acesso de ${b.dataset.name}?`, { confirm: "Remover", danger: true }))) return;
    try {
      await api(`/users/${b.dataset.delUser}`, { method: "DELETE" });
      toast("Acesso removido");
      settingsView();
    } catch (err) { errorToast(err); }
  });
}
