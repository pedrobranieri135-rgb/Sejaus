// Catálogo-fonte da Seja US (extraído dos catálogos "US ADAPT" e "US Essential – First Chapter").
// Preços em centavos. `src` = página/recorte de origem no PDF (usado só pelo script de imagens).
// `sizes` = tamanhos disponíveis no catálogo para aquela cor; o seed gera o estoque a partir disso.

const ADAPT_SIZES = ["P", "M", "G", "GG", "XGG"];

const adaptColors = [
  { color: "Branca", slug: "branca", hex: "#F4F4F2", pages: [3, 4, 5] },
  { color: "Preta", slug: "preta", hex: "#121212", pages: [6, 7, 8] },
  { color: "Vinho", slug: "vinho", hex: "#5B1A22", pages: [9, 10, 11] },
  { color: "Cinza", slug: "cinza", hex: "#7C7D80", pages: [12, 13, 14] },
  { color: "Azul Marinho", slug: "marinho", hex: "#1C2A4A", pages: [15, 16, 17] },
];

const adaptPrints = [
  { n: 1, desc: "Logo US | ∞ centralizado no peito e US nas costas." },
  { n: 2, desc: "Logo US | ∞ discreto no peito e US nas costas." },
  { n: 3, desc: "US minimalista no peito e símbolo ∞ nas costas." },
];

const pad = (n) => String(n).padStart(2, "0");

const adapt = adaptPrints.map((p, i) => ({
  slug: `camiseta-us-adapt-estampa-${pad(p.n)}`,
  name: `Camiseta US Adapt — Estampa ${pad(p.n)}`,
  line: "adapt",
  gender: "masculino",
  category: "camisetas",
  price: 9900,
  badges: i === 0 ? ["Mais vendida"] : [],
  description:
    `Liberdade para cada movimento. ${p.desc} Modelagem masculina com toque gelado, anti-odor, alta elasticidade e proteção UV.`,
  fabric: "90% Poliamida | 10% Elastano",
  features: ["Toque gelado", "Anti-odor", "Alta elasticidade", "Proteção UV"],
  sizeGuide: "adapt",
  variants: adaptColors.map((c) => ({
    color: c.color,
    slug: c.slug,
    hex: c.hex,
    sizes: ADAPT_SIZES,
    src: [`adapt:p${pad(c.pages[i])}_raw1`, `adapt:p${pad(c.pages[i])}_raw2`],
  })),
}));

// helper para as peças Essential
const v = (color, slug, hex, sizes, ...src) => ({ color, slug, hex, sizes, src: src.map((s) => `ess:${s}`) });
const ess = (slug, name, category, price, variants, extra = {}) => ({
  slug, name, line: "essential", gender: "feminino", category, price, badges: [], features: [], fabric: null,
  sizeGuide: null, description: "", variants, ...extra,
});

const essential = [
  ess("blusa-manga-longa-tule", "Blusa Manga Longa Tule", "blusas", 14900, [
    v("Preto", "preto", "#141414", ["Único"], "p02_3"),
    v("Café", "cafe", "#5A3328", ["Único"], "p02_1"),
    v("Lavanda", "lavanda", "#A9AEDB", ["Único"], "p03_1"),
    v("Amarelo", "amarelo", "#F0E39A", ["Único"], "p03_2"),
    v("Rosa", "rosa", "#E7A49A", ["Único"], "p03_4"),
  ], { description: "Tule leve e transparente, com manga longa e passador de polegar. Tamanho único — veste do P ao G.", features: ["Tamanho único (P ao G)", "Tule respirável", "Passador de polegar"] }),

  ess("colete-ziper", "Colete Zíper", "coletes", 15900, [
    v("Rosa", "rosa", "#F2C4CF", ["M"], "p04_1"),
    v("Azul Marinho", "marinho", "#1E2C57", ["G"], "p04_3"),
    v("Preto", "preto", "#141414", ["G"], "p04_4"),
    v("Café", "cafe", "#4E2D22", ["G"], "p04_2"),
  ], { description: "Colete com zíper frontal e modelagem slim que valoriza a silhueta, do treino ao dia a dia.", features: ["Modelagem slim", "Zíper frontal"] }),

  ess("conjunto-jaqueta-top-calca", "Conjunto Jaqueta, Top e Calça", "conjuntos", 34900, [
    v("Rosé", "rose", "#A57B76", ["G/GG"], "p05_2", "p05_3"),
    v("Branco", "branco", "#F3F3F1", ["P/M"], "p06_2"),
    v("Azul Marinho", "marinho", "#1D2A55", ["G/GG"], "p07_1", "p07_3"),
    v("Gelo", "gelo", "#E9E3EE", ["M"], "p08_2"),
    v("Sálvia", "salvia", "#A9B8A1", ["M"], "p09_2"),
  ], { badges: ["Look completo"], description: "Trio jaqueta, top e calça em tecido de alta elasticidade. O look completo para chegar e sair do treino com estilo.", features: ["3 peças", "Alta elasticidade"] }),

  ess("conjunto-jaqueta-calca-cos-dobravel", "Conjunto Jaqueta e Calça com Cós Dobrável", "conjuntos", 28900, [
    v("Azul Céu", "azul-ceu", "#C5D6E8", ["G/GG"], "p10_2"),
  ], { description: "Jaqueta cropped e calça wide com cós dobrável para ajustar o caimento do seu jeito.", features: ["Cós dobrável", "Calça wide"] }),

  ess("conjunto-jaqueta-top-legging-bolso", "Conjunto Jaqueta, Top e Legging com Bolso", "conjuntos", 32900, [
    v("Preto", "preto", "#141414", ["P"], "p11_2"),
  ], { description: "Jaqueta com zíper, top de costas vazadas e legging com bolso lateral. Performance em 3 peças.", features: ["3 peças", "Legging com bolso"] }),

  ess("conjunto-jaqueta-legging-bolso", "Conjunto Jaqueta e Legging com Bolso", "conjuntos", 26900, [
    v("Oliva", "oliva", "#6E6A4E", ["P", "M"], "p12_1"),
  ], { description: "Jaqueta com zíper e passador de polegar + legging de cintura alta com bolso.", features: ["Legging com bolso", "Passador de polegar"] }),

  ess("macacao-seamless", "Macacão Seamless", "macacoes", 25900, [
    v("Café", "cafe", "#4A2E25", ["M", "G"], "p13_1"),
  ], { description: "Macacão longo sem costura com zíper frontal. Compressão na medida e conforto o dia inteiro.", features: ["Sem costura", "Zíper frontal"] }),

  ess("macaquinho-decote-costas", "Macaquinho Decote Costas", "macacoes", 21900, [
    v("Azul", "azul", "#6E95CF", ["P", "M"], "p14_2", "p14_3"),
    v("Preto", "preto", "#141414", ["M", "G"], "p15_2"),
    v("Caramelo", "caramelo", "#9A5A32", ["P", "M"], "p15_3"),
    v("Café", "cafe", "#4E2D22", ["P", "M", "G"], "p15_4"),
  ], { badges: ["Queridinho"], description: "Macaquinho com decote profundo nas costas e bolsos laterais. Sustentação e liberdade de movimento.", features: ["Decote nas costas", "Bolsos laterais"] }),

  ess("macaquinho-seamless", "Macaquinho Seamless", "macacoes", 22900, [
    v("Preto", "preto", "#141414", ["P/M"], "p16_2", "p16_3"),
  ], { description: "Macaquinho sem costura com textura sutil e costas abertas.", features: ["Sem costura", "Costas abertas"] }),

  ess("macaquinho-blackout", "Macaquinho Blackout", "macacoes", 24900, [
    v("Rosa", "rosa", "#C98A8E", ["P", "M"], "p17_2", "p17_3"),
  ], { description: "Tecido blackout com zero transparência e alças cruzadas nas costas.", features: ["Tecido blackout", "Zero transparência", "Alças cruzadas"] }),

  ess("macaquinho-canelado", "Macaquinho Canelado", "macacoes", 24900, [
    v("Amarelo", "amarelo", "#EFE39B", ["P", "M"], "p18_1", "p18_2"),
    v("Off-white", "off-white", "#EFEAE0", ["P"], "p19_1"),
    v("Vermelho", "vermelho", "#B3172B", ["P"], "p19_2"),
    v("Nude", "nude", "#D8C2B0", ["M"], "p19_3"),
  ], { description: "Canelado com tecido blackout e zero transparência. Costas com tiras cruzadas.", features: ["Tecido canelado", "Blackout", "Zero transparência"] }),

  ess("top-compressao-regulavel", "Top Compressão Regulável", "tops", 17900, [
    v("Preto", "preto", "#141414", ["M/G"], "p20_1"),
  ], { description: "Top de alta sustentação com fecho frontal e alças reguláveis nas costas.", features: ["Alta sustentação", "Alças reguláveis", "Fecho frontal"] }),

  ess("conjunto-top-shorts-duplo", "Conjunto Top e Shorts Duplo", "conjuntos", 24900, [
    v("Preto", "preto", "#141414", ["P", "M"], "p21_2", "p21_3"),
  ], { description: "Top de alças largas + shorts duplo (saia-shorts) com bermuda interna.", features: ["Shorts duplo", "Bermuda interna"] }),

  ess("conjunto-top-shorts-canelado", "Conjunto Top e Shorts Canelado", "conjuntos", 24900, [
    v("Verde", "verde", "#6F7E5B", ["G"], "p22_2", "p22_3"),
  ], { description: "Canelado com zero transparência. Top nadador e shorts de cintura alta.", features: ["Tecido canelado", "Zero transparência"] }),

  ess("conjunto-top-shorts-seamless", "Conjunto Top e Shorts Seamless", "conjuntos", 22900, [
    v("Preto", "preto", "#141414", ["M", "G"], "p23_2", "p23_3"),
  ], { description: "Sem costura, com top de tiras nas costas e shorts modelador.", features: ["Sem costura", "Tiras nas costas"] }),

  ess("conjunto-top-frente-unica-shorts", "Conjunto Top Frente Única e Shorts", "conjuntos", 24900, [
    v("Amarelo", "amarelo", "#EDE58F", ["M"], "p24_1", "p24_2"),
    v("Verde", "verde", "#2E6A57", ["M", "G"], "p25_1"),
  ], { description: "Top frente única com amarração no pescoço e shorts de compressão.", features: ["Frente única", "Compressão"] }),

  ess("conjunto-top-shorts", "Conjunto Top e Shorts", "conjuntos", 24900, [
    v("Bege", "bege", "#E3CDAE", ["P", "M"], "p26_1", "p26_2"),
    v("Rosa", "rosa", "#DD95B3", ["P", "M"], "p27_1", "p27_2"),
  ], { description: "Conjunto com vivos contrastantes em off-white, top de alças largas e shorts de cintura alta.", features: ["Vivos contrastantes", "Cintura alta"] }),

  ess("conjunto-top-shorts-bolsos", "Conjunto Top e Shorts com Bolsos", "conjuntos", 28900, [
    v("Terracota", "terracota", "#A45C44", ["M", "G"], "p28_2", "p28_3"),
    v("Azul Marinho", "marinho", "#1C2550", ["M"], "p29_2", "p29_3"),
    v("Menta", "menta", "#B7CDB8", ["P", "M"], "p30_2", "p30_3"),
  ], { description: "Tecido canelado com brilho acetinado, shorts com forro e bolsos laterais.", features: ["Tecido canelado", "Shorts com forro", "Bolsos"] }),

  ess("conjunto-top-legging", "Conjunto Top e Legging", "conjuntos", 28900, [
    v("Bege", "bege", "#E5D3B5", ["P", "M"], "p31_2", "p31_3"),
    v("Verde", "verde", "#4F5A3E", ["M"], "p32_2", "p32_3"),
    v("Rosa", "rosa", "#E09BB6", ["P", "M", "G"], "p33_2", "p33_3"),
  ], { description: "Top com faixa contrastante e legging de cintura alta. Básico que vira statement.", features: ["Cintura alta", "Faixa contrastante"] }),

  ess("conjunto-top-legging-canelado", "Conjunto Top e Legging Canelado", "conjuntos", 28900, [
    v("Preto", "preto", "#141414", ["M", "G"], "p34_2", "p34_3"),
    v("Nude", "nude", "#D8BFAE", ["P", "M"], "p35_2", "p35_3"),
  ], { description: "Tecido canelado com zero transparência, pronto para agachamento sem medo.", features: ["Tecido canelado", "Zero transparência"] }),

  ess("conjunto-top-legging-bolso", "Conjunto Top e Legging Bolso", "conjuntos", 25900, [
    v("Off-white", "off-white", "#EEE8DA", ["M"], "p36_2"),
  ], { description: "Top de alças finas e legging com bolso lateral. Sofisticação no treino.", features: ["Legging com bolso", "Alças finas"] }),

  ess("conjunto-regata-calca-flare", "Conjunto Regata e Calça Flare", "conjuntos", 25900, [
    v("Rosa", "rosa", "#EE93AE", ["P", "M", "G"], "p37_2", "p37_3"),
    v("Off-white", "off-white", "#F1EEE6", ["P", "M"], "p38_3"),
    v("Preto", "preto", "#141414", ["G"], "p38_2"),
  ], { badges: ["Novo"], description: "Regata com decote nas costas e calça flare de cintura alta que alonga a silhueta.", features: ["Calça flare", "Cintura alta"] }),

  ess("conjunto-top-calca-flare", "Conjunto Top e Calça Flare", "conjuntos", 25900, [
    v("Azul Marinho", "marinho", "#1D2552", ["G"], "p39_2", "p39_3"),
    v("Preto", "preto", "#141414", ["M"], "p40_2"),
    v("Vinho", "vinho", "#6A1427", ["M"], "p40_3"),
  ], { badges: ["Novo"], description: "Top cropped nadador e calça flare. Do pilates ao café pós-treino.", features: ["Calça flare", "Top cropped"] }),
];

export const products = [...adapt, ...essential];

export const sizeGuides = {
  adapt: {
    title: "Tabela de medidas — Camiseta masculina US Adapt",
    columns: ["Tamanho", "A · Largura (tórax)", "B · Altura (comprimento)", "C · Manga (comprimento)"],
    rows: [
      ["P", 52, 69, 21],
      ["M", 54, 70, 22],
      ["G", 56, 72, 23],
      ["GG", 58, 74, 24],
      ["XGG", 60, 75, 26],
    ],
    note: "Medidas em centímetros (cm).",
  },
};

export const categories = {
  camisetas: "Camisetas",
  blusas: "Blusas",
  coletes: "Coletes",
  conjuntos: "Conjuntos",
  macacoes: "Macacões & Macaquinhos",
  tops: "Tops",
};
