// sync-images.js — Import photos Sifam -> Shopify, attache aux variantes
// Node 18+ (fetch natif) — ESM
import 'dotenv/config';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP        = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN       = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
const PROXY       = process.env.PROXY_BASE      || process.env.PROXY_URL || 'https://sifam-proxy.onrender.com';
const SIFAM_KEY   = process.env.SIFAM_API_KEY || '';
const ONLY_SKU    = (process.env.ONLY_SKU || '').trim();           // test ciblé
const MAX_UPLOADS = parseInt(process.env.MAX_UPLOADS || '0', 10);  // 0 = illimité
const T_OUT       = (ms) => ({ signal: AbortSignal.timeout(ms) });

if (!SHOP)  throw new Error('SHOPIFY_DOMAIN / SHOPIFY_STORE_DOMAIN manquant');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN / SHOPIFY_ADMIN_TOKEN manquant');

console.log('-> Shopify :', SHOP, 'API', API_VERSION);
console.log('-> Proxy   :', PROXY);
if (ONLY_SKU)    console.log('-> ONLY_SKU:', ONLY_SKU);
if (MAX_UPLOADS) console.log('-> MAX_UPLOADS:', MAX_UPLOADS);

// Utils
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const toRef  = (s)  => s.replace(/\//g, '~'); // règle Sifam (refs avec '/')
const norm   = (url) => String(url || '').trim().replace(/^http:/i, 'http:').replace(/^https:/i, 'https:'); // normalisation simple

async function retry(fn, tries = 3, baseDelay = 600) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(baseDelay * (i + 1)); }
  }
  throw last;
}

// GraphQL Admin: on lit produits/variants/images en batch
async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    ...T_OUT(25000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    throw new Error(`GraphQL fail: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data;
}

// On parcourt les produits avec variantes et images existantes
async function* iterProducts() {
  let cursor = null;
  const query = `
    query Products($cursor: String) {
      products(first: 50, after: $cursor) {
        edges {
          cursor
          node {
            id
            title
            images(first: 100) { edges { node { id src altText } } }
            variants(first: 100) { edges { node { id sku } } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  while (true) {
    const data = await gql(query, { cursor });
    const edges = data.products.edges;
    for (const e of edges) yield e.node;
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
}

// Récupère les photos Sifam via proxy, sinon fallback direct API Sifam
async function fetchSifamPhotos(sku) {
  const ref = toRef(sku);
  // 1) Proxy
  try {
    const r = await fetch(`${PROXY}/photos/${encodeURIComponent(ref)}`, T_OUT(20000));
    if (r.ok) {
      const body = await r.json();
      const arr = Array.isArray(body) ? body : body?.photos || [];
      if (arr && arr.length) return arr.map(norm);
    }
  } catch {}
  // 2) Fallback direct Sifam si on a une clé
  if (SIFAM_KEY) {
    try {
      const u = `http://api.sifam.fr/api/photos/${encodeURIComponent(ref)}.json?generique=1&api_key=${encodeURIComponent(SIFAM_KEY)}`;
      const r = await fetch(u, T_OUT(20000));
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) return arr.map(norm);
      }
    } catch {}
  }
  return [];
}

// Upload image par URL et (optionnel) lier à une ou plusieurs variantes
async function uploadImage(productId, srcUrl, variantIds = []) {
  const pid = String(productId).split('/').pop(); // GID -> id numérique
  const url = `https://${SHOP}/admin/api/${API_VERSION}/products/${pid}/images.json`;

  // Shopify peut importer directement via src. Si ça échoue, on pourra faire un fallback base64 (coûteux).
  const payload = { image: { src: srcUrl } };
  if (variantIds.length) {
    payload.image.variant_ids = variantIds.map(v => Number(String(v).split('/').pop()));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...T_OUT(30000)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Image POST failed ${res.status}: ${txt}`);
  }
  const out = await res.json();
  return out?.image?.id || null;
}

async function main() {
  let uploaded = 0, skipped = 0, failed = 0, touchedProducts = 0;

  for await (const p of iterProducts()) {
    // Carte des images déjà présentes (src normalisés)
    const existing = new Set(
      (p.images?.edges || []).map(e => norm(e.node?.src)).filter(Boolean)
    );

    // Map variante -> sku
    const variants = (p.variants?.edges || []).map(e => e.node).filter(v => v?.sku);
    if (ONLY_SKU && !variants.some(v => v.sku === ONLY_SKU)) continue;

    // Pour éviter d’envoyer 15 fois la même image si toutes les variantes ont la même
    const planned = new Set(); // URLs qu’on prévoit d’uploader pour ce produit

    for (const v of variants) {
      if (ONLY_SKU && v.sku !== ONLY_SKU) continue;

      // Récupère photos Sifam pour cette variante
      let photos = [];
      try {
        photos = await retry(() => fetchSifamPhotos(v.sku), 3, 800);
      } catch (e) {
        failed++;
        console.error(`[ERR photos] sku ${v.sku}:`, e.message || e);
        continue;
      }
      if (!photos.length) { skipped++; continue; }

      // On prend la première pertinente comme "image principale" de la variante
      const primary = photos[0];

      // Si déjà présente, on ne réimporte pas; sinon on planifie l’upload
      if (!primary || existing.has(primary) || planned.has(primary)) {
        skipped++;
        continue;
      }

      try {
        // Upload et attache à la variante
        await uploadImage(p.id, primary, [v.id]);
        uploaded++;
        touchedProducts++;
        existing.add(primary);
        planned.add(primary);
      } catch (e) {
        failed++;
        console.error(`[FAIL upload] product ${p.id} sku ${v.sku}:`, e.message || e);
      }

      // throttle léger
      await sleep(250);

      if (MAX_UPLOADS > 0 && uploaded >= MAX_UPLOADS) {
        console.log(JSON.stringify({ uploaded, skipped, failed, touchedProducts, onlySku: ONLY_SKU || null, limited: true }));
        return;
      }
    }
  }

  console.log(JSON.stringify({ uploaded, skipped, failed, touchedProducts, onlySku: ONLY_SKU || null }));
}

main().catch(e => { console.error(e); process.exit(1); });
