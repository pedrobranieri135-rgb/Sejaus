# Seja US — loja virtual + painel

Loja das linhas **US Adapt** (camisetas masculinas) e **US Essential** (moda fitness feminina), com painel administrativo completo.

## Rodar

```bash
npm install
cp .env.example .env   # ajuste WhatsApp, chave Pix e o primeiro usuário do painel
npm run dev            # loja: http://localhost:3000   painel: http://localhost:3000/admin
```

| Comando | O que faz |
|---|---|
| `npm run dev` | servidor com recarga automática |
| `npm test` | 57 testes (estoque, pedidos concorrentes, cupons, painel, migrações, Storage, Mercado Pago) contra o Postgres |
| `npm run demo` | cria ~30 pedidos de demonstração (e-mails @exemplo.com) para ver o painel com números |
| `npm run seed` | recria o catálogo original e **apaga todos os pedidos** |

## Painel (/admin)
- **Login** por e-mail e senha (hash scrypt, sessão em cookie HttpOnly/SameSite=Strict, 12h). O primeiro usuário vem de `ADMIN_EMAIL`/`ADMIN_PASSWORD`; os demais são criados em Configurações.
- **Painel**: vendas do dia e da semana, ticket médio, pedidos aguardando pagamento e para enviar, alertas de estoque.
- **Pedidos**: filtros por status, data e busca (código, nome, e-mail, CPF, telefone, rastreio); detalhe com histórico, mudança de status, **código de rastreio** (Correios detectado automaticamente), nota interna, WhatsApp do cliente, **guia de separação para imprimir** e exportação CSV.
- **Produtos**: cadastro e edição com cores, **upload de fotos** (JPG/PNG/WEBP, convertidas para WEBP), grade de tamanhos e estoque, **preço promocional (de/por)**, selos, pausar/ativar e **preços em massa** com prévia (promoção, reajuste, encerrar promoção).
- **Estoque**: ajuste rápido por tamanho, filtros de baixo/zerado.
- **Cupons**: porcentagem, valor fixo ou **frete grátis**; compra mínima, limite de usos, **só primeira compra**, **1 uso por cliente** (CPF/e-mail), validade, restrição por linha.
- **Clientes**: histórico de compras, total gasto, exportação CSV (clientes e newsletter).
- **Relatórios**: faturamento por dia, comparação com o período anterior, mais vendidos, cor/tamanho campeões, por linha, categoria, pagamento, estado, desempenho dos cupons, exportação CSV.
- **Configurações**: WhatsApp, Pix, frete grátis, prazo de pagamento, faixa de aviso do site, usuários, troca de senha e **registro de atividades**.

## Publicar na Vercel
1. Importe este repositório na Vercel (**Add New → Project**). Não precisa mudar framework, build nem pasta: o `vercel.json` já configura tudo.
2. Em **Environment Variables**, cole o conteúdo do arquivo `.env.vercel` (gerado localmente, fora do git).
3. **Deploy.** Na primeira requisição o servidor confere as tabelas e cria o usuário do painel, se não existir.

Como roda:
- `public/` é servido pela CDN da Vercel; `/api/*` vai para a função `api/index.js` (Express).
- Banco pelo **pooler do Supabase em modo transação** (porta 6543) com o usuário `loja_app`, que só enxerga o schema `loja`.
- Cron diário (`/api/cron/expire-orders`, protegido por `CRON_SECRET`) expira pedidos não pagos; abrir o painel também faz isso.
- Fotos enviadas pelo painel são reduzidas no navegador (limite de 4,5 MB por requisição da Vercel) e vão para o Supabase Storage.

## Pagamento automático (Mercado Pago)
Integração pela **API de Orders** (Checkout Transparente): o cliente paga sem sair do site.
- **Pix:** QR Code exclusivo do pedido; a tela confirma sozinha quando o pagamento cai.
- **Cartão:** formulário oficial do Mercado Pago (Card Payment Brick) dentro do checkout, até `MP_MAX_INSTALLMENTS` parcelas. Os dados do cartão vão direto para o Mercado Pago; a loja só recebe um token.
- **Confirmação:** webhook `/api/webhooks/mercadopago` (tópico "Order", assinatura `x-signature` validada) + consulta na tela do Pix + verificação ao abrir o painel e no cron. A situação sempre é conferida na API do Mercado Pago.
- **Recusa de cartão:** o pedido é cancelado na hora e o estoque volta; o cliente vê o motivo e tenta de novo.
- **Cancelar no painel um pedido pago:** estorna o valor pelo Mercado Pago antes de cancelar.
- **O dinheiro cai na conta dona das credenciais.** Em produção, use as credenciais da conta Mercado Pago do dono da loja.

| Variável | O quê |
|---|---|
| `MP_PUBLIC_KEY` / `MP_ACCESS_TOKEN` | Suas integrações → aplicação → Credenciais (teste ou produção) |
| `MP_WEBHOOK_SECRET` | Suas integrações → aplicação → Webhooks → assinatura secreta |
| `MP_MAX_INSTALLMENTS` | parcelas máximas no cartão (padrão 3) |
| `MP_TEST_PAYER_NAME` | só para teste: `APRO` faz o Pix de teste ser aprovado sozinho (ignorado com credencial de produção) |

## Antes de publicar
- Trocar `ADMIN_PASSWORD` (ou a senha pelo painel) e definir `NODE_ENV=production` (ativa cookie Secure)
- Frete usa tabela por região (`server/lib/shipping.js`) — integrar Melhor Envio/Correios para cotação real
- Cartão: o pedido é criado e o cliente recebe link de pagamento pelo WhatsApp; para cobrança automática, integrar Mercado Pago/Pagar.me
- Backups: Supabase faz backup diário automático (planos pagos permitem restaurar em ponto no tempo)
