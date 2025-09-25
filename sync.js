// sync.js — synchro PRIX_PUBLIC (HT) -> Shopify Variant.price
// ESM + Node 20 (fetch natif)

const SHOP = process.env.SHOPIFY_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN;
const PROXY = process.env.PROXY_BASE || "https://sifam-proxy.onrender.com";
const DEC = parseInt(process.env.CURRENCY_DECIMALS || "2", 10);

const gql = async (query, variables = {}) => {
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors || j));
  return j.data;
};

async function* variants() {
  let cursor = null;
  while (true) {
    const q = `query($cursor:String){
      productVariants(first:250, after:$cursor){
        edges{ cursor node{ id sku } }
        pageInfo{ hasNextPage endCursor }
      }}`;
    const d = await gql(q, { cursor });
    const pv = d.productVariants;
    for (const e of pv.edges) yield e.node;
    if (!pv.pageInfo.hasNextPage) break;
    cursor = pv.pageInfo.endCursor;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const toRef = s => s.replace(/\//g, "~"); // règle Sifam

async function priceForSku(sku) {
  if (!sku) return null;
  const u = `${PROXY}/stock/${encodeURIComponent(toRef(sku))}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const body = await r.json();
  const obj = Array.isArray(body) ? body[0] : body;
  if (!obj || obj.PRIX_PUBLIC == null) return null;
  const n = Number(String(obj.PRIX_PUBLIC).replace(",", "."));
  return Number.isFinite(n) ? Number(n.toFixed(DEC)) : null;
}

async function setPrice(variantId, price) {
  const m = `mutation($input:ProductVariantInput!){
    productVariantUpdate(input:$input){
      productVariant{ id price }
      userErrors{ field message }
    }}`;
  const d = await gql(m, { input: { id: variantId, price: price.toFixed(DEC) } });
  const errs = d.productVariantUpdate.userErrors;
  if (errs?.length) throw new Error("userErrors: " + JSON.stringify(errs));
}

async function main() {
  let updated = 0, skipped = 0;
  for await (const v of variants()) {
    if (!v.sku) { skipped++; continue; }
    const p = await priceForSku(v.sku);
    if (p == null) { skipped++; continue; }
    await setPrice(v.id, p);
    updated++;
    await sleep(200); // throttle doux
  }
  console.log(JSON.stringify({ updated, skipped }));
}

main().catch(e => { console.error(e); process.exit(1); });
