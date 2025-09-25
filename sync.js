// sync.js — Synchro PRIX_PUBLIC (HT) -> Shopify Variant.price
// Node 18+ (fetch natif) — ESM

// ====== Config ENV (accepte deux conventions de noms) ======
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP        = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN       = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
const PROXY       = process.env.PROXY_BASE      || process.env.PROXY_URL || 'https://sifam-proxy.onrender.com';
const DEC         = Number.parseInt(process.env.CURRENCY_DECIMALS || '2', 10);
const ONLY_SKU = (process.env.ONLY_SKU || '').trim();


// Garde-fous
if (!SHOP)  throw new Error('SHOPIFY_DOMAIN / SHOPIFY_STORE_DOMAIN manquant');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN / SHOPIFY_ADMIN_TOKEN manquant');
if (!Number.isFinite(DEC) || DEC < 0 || DEC > 4) throw new Error('CURRENCY_DECIMALS invalide');

// Logs utiles
console.log('-> Shopify :', SHOP, 'API', API_VERSION);
console.log('-> Proxy   :', PROXY);

// ====== Utilitaires ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toRef = (s) => s.replace(/\//g, '~'); // règle Sifam
const withTimeout = (ms) => ({ signal: AbortSignal.timeout(ms) });

// Requêtes GraphQL Shopify (avec petits retries)
async function gql(query, variables = {}, retries = 2) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      ...withTimeout(20000)
    });
    let payload;
    try { payload = await res.json(); } catch { payload = null; }

    if (res.ok && payload && !payload.errors) return payload.data;

    // userErrors sont renvoyés dans data.*.userErrors, pas dans payload.errors
    // On laisse le caller gérer ces cas-là. Ici on retry seulement erreurs réseau/serveur.
    const shouldRetry = !res.ok || !!payload?.errors;
    if (attempt < retries && shouldRetry) {
      await sleep(600 * (attempt + 1));
      continue;
    }
    throw new Error(`GraphQL fail: status=${res.status} body=${JSON.stringify(payload)}`);
  }
}

// Itérateur sur toutes les variantes avec pagination
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

// Récupère PRIX_PUBLIC via ton proxy pour un SKU donné
async function priceForSku(sku) {
  if (!sku) return null;
  const u = `${PROXY}/stock/${encodeURIComponent(toRef(sku))}`;
  const res = await fetch(u, withTimeout(15000)).catch(() => null);
  if (!res || !res.ok) return null;

  let body;
  try { body = await res.json(); } catch { return null; }
  const obj = Array.isArray(body) ? body[0] : body;
  if (!obj || obj.PRIX_PUBLIC == null) return null;

  const n = Number(String(obj.PRIX_PUBLIC).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(DEC));
}

// Met à jour le prix d’une variante Shopify
async function setPrice(variantGid, price) {
  // 1) tentative GraphQL
  const mutation = `
    mutation UpdateVariant($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant { id price }
        userErrors { field message }
      }
    }`;
  try {
    const data = await gql(mutation, { input: { id: variantGid, price: price.toFixed(DEC) } });
    const errs = data.productVariantUpdate?.userErrors || [];
    if (errs.length) throw new Error('userErrors: ' + JSON.stringify(errs));
    return;
  } catch (e) {
    if (!String(e.message).includes("productVariantUpdate")) throw e;
  }

  // 2) fallback REST /variants/{id}.json
  const numericId = String(variantGid).split('/').pop();
  const url = `https://${SHOP}/admin/api/${API_VERSION}/variants/${numericId}.json`;
  const body = { variant: { id: Number(numericId), price: Number(price.toFixed(DEC)) } };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(30000), // 30s pour être large
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`REST PUT failed ${res.status}: ${txt}`);
  }
}


  // 2) Fallback REST Admin: /admin/api/{version}/variants/{numericId}.json
  const numericId = String(variantGid).split('/').pop(); // extrait 1234567890 de gid://shopify/ProductVariant/1234567890
  const url = `https://${SHOP}/admin/api/${API_VERSION}/variants/${numericId}.json`;
  const body = { variant: { id: Number(numericId), price: Number(price.toFixed(DEC)) } };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`REST PUT failed ${res.status}: ${txt}`);
  }
}


// ====== Programme principal ======
async function main() {
  let updated = 0, skipped = 0, emptySku = 0, failed = 0;

  for await (const v of iterVariants()) {
    if (!v.sku) { emptySku++; continue; }
    if (ONLY_SKU && v.sku !== ONLY_SKU) { continue; }


    const p = await priceForSku(v.sku);
    if (p == null) { skipped++; continue; }

    try {
      await setPrice(v.id, p);
      updated++;
    } catch (e) {
      failed++;
      console.error(`[FAIL] variant ${v.id} sku ${v.sku}:`, e.message || e);
    }

    // throttle doux pour rester sous les limites API
    await sleep(200);
  }

  console.log(JSON.stringify({ updated, skipped, emptySku, failed }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
