// sync.js — Synchro PRIX_PUBLIC Sifam -> Shopify Variant.price
// Node 18+ (fetch natif) — ESM
import 'dotenv/config';

// ====== ENV ======
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP        = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN       = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
const PROXY       = process.env.PROXY_BASE || process.env.PROXY_URL || 'https://sifam-proxy.onrender.com';
const DEC         = Number.parseInt(process.env.CURRENCY_DECIMALS || '2', 10);
const VAT_RATE    = Number(process.env.VAT_RATE || '0'); // ex: 0.21 pour BE
const ONLY_SKU    = (process.env.ONLY_SKU || '').trim();
const MAX_UPDATES = Number.parseInt(process.env.MAX_UPDATES || '0', 10);

if (!SHOP)  throw new Error('SHOPIFY_DOMAIN / SHOPIFY_STORE_DOMAIN manquant');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN / SHOPIFY_ADMIN_TOKEN manquant');

console.log('-> Shopify :', SHOP, 'API', API_VERSION);
console.log('-> Proxy   :', PROXY);
if (ONLY_SKU)    console.log('-> ONLY_SKU:', ONLY_SKU);
if (MAX_UPDATES) console.log('-> MAX_UPDATES:', MAX_UPDATES);
if (VAT_RATE)    console.log('-> TVA appliquée:', VAT_RATE * 100, '%');

// ====== Utils ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toRef = (s)  => s.replace(/\//g, '~'); // règle Sifam
const tmo   = (ms) => ({ signal: AbortSignal.timeout(ms) });

async function retry(fn, { tries = 3, baseDelay = 800 }) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(baseDelay * (i + 1)); }
  }
  throw last;
}

// ====== GraphQL Admin (lecture variantes) ======
async function gql(query, variables = {}, retries = 2) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      ...tmo(20000)
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }

    if (res.ok && payload && !payload.errors) return payload.data;

    const shouldRetry = !res.ok || !!payload?.errors;
    if (attempt < retries && shouldRetry) { await sleep(600 * (attempt + 1)); continue; }
    throw new Error(`GraphQL fail: status=${res.status} body=${JSON.stringify(payload)}`);
  }
}

async function* iterVariants() {
  let cursor = null;
  const query = `
    query Variants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          cursor
          node { id sku }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  while (true) {
    const data = await gql(query, { cursor });
    const pv = data.productVariants;
    for (const e of pv.edges) yield e.node;
    if (!pv.pageInfo.hasNextPage) break;
    cursor = pv.pageInfo.endCursor;
  }
}

// ====== Prix depuis le proxy Sifam ======
async function priceForSku(sku) {
  if (!sku) return null;
  const url = `${PROXY}/stock/${encodeURIComponent(toRef(sku))}`;
  const once = async () => {
    const res = await fetch(url, tmo(35000));
    if (!res.ok) throw new Error(`Proxy ${res.status}`);
    const body = await res.json();
    const obj  = Array.isArray(body) ? body[0] : body;
    if (!obj || obj.PRIX_PUBLIC == null) return null;

    const n = Number(String(obj.PRIX_PUBLIC).replace(',', '.')); // HT
    if (!Number.isFinite(n)) return null;

    const gross = VAT_RATE ? n * (1 + VAT_RATE) : n; // ajoute TVA si définie
    return Number(gross.toFixed(DEC));
  };
  return retry(once, { tries: 3, baseDelay: 900 });
}

// ====== Update prix via REST Admin ======
async function setPriceRest(variantGid, price) {
  const numericId = String(variantGid).split('/').pop();
  const url  = `https://${SHOP}/admin/api/${API_VERSION}/variants/${numericId}.json`;
  const body = { variant: { id: Number(numericId), price: Number(price.toFixed(DEC)) } };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    ...tmo(30000)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`REST PUT failed ${res.status}: ${txt}`);
  }
}

// ====== Main ======
async function main() {
  let updated = 0, skipped = 0, emptySku = 0, failed = 0;

  for await (const v of iterVariants()) {
    if (!v.sku) { emptySku++; continue; }
    if (ONLY_SKU && v.sku !== ONLY_SKU) continue;

    let p = null;
    try {
      p = await priceForSku(v.sku);
    } catch (e) {
      failed++;
      console.error(`[TIMEOUT/ERR] proxy sku ${v.sku}:`, e.message || e);
      continue;
    }
    if (p == null) { skipped++; continue; }

    try {
      await setPriceRest(v.id, p);
      updated++;
    } catch (e) {
      failed++;
      console.error(`[FAIL] variant ${v.id} sku ${v.sku}:`, e.message || e);
    }

    await sleep(300); // throttle
    if (MAX_UPDATES > 0 && updated >= MAX_UPDATES) break;
  }

  console.log(JSON.stringify({ updated, skipped, emptySku, failed, onlySku: ONLY_SKU || null }));
}

main().catch(err => { console.error(err); process.exit(1); });
