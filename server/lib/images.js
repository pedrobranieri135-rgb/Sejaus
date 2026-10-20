// Endereço público das fotos. Catálogo original: arquivos estáticos em /img/p.
// Fotos enviadas pelo painel: Supabase Storage (id "up-…") ou disco local em desenvolvimento (id "lo-…").
const cfg = { supabaseUrl: null, bucket: "produtos" };

export function configureImages({ supabaseUrl, bucket }) {
  cfg.supabaseUrl = supabaseUrl ? supabaseUrl.replace(/\/+$/, "") : null;
  if (bucket) cfg.bucket = bucket;
}

export const storagePublicBase = () => (cfg.supabaseUrl ? `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.bucket}` : null);

export function imageUrls(id) {
  if (id.startsWith("up-") && cfg.supabaseUrl) {
    const root = `${storagePublicBase()}/p/${id}`;
    return { id, lg: `${root}.webp`, sm: `${root}-s.webp` };
  }
  return { id, lg: `/img/p/${id}.webp`, sm: `/img/p/${id}-s.webp` };
}
