// sync-images.js — Import photos Sifam -> Shopify, attache aux variantes (avec fallback base64)
// Node 18+ (fetch natif) — ESM
import 'dotenv/config';

// ====== ENV ======
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP        = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN       = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
const PROXY       = process.env.PROXY_BASE      || process.env.PROXY_URL || 'https://sifam-proxy.onrender.com';
const SIFAM_KEY   = process.env.SIFAM_API_KEY || '';
const ONLY_SKU    = (process.env.ONLY_SKU || '').trim();            // ex: "7673" pour tester 1 SKU
const MAX_UPLOADS = parseInt(process.env.MAX_UPLOADS || '0', 10);   // 0 = illimité

if (!SHOP)  throw new Error('SHOPIFY_DOMAIN / SHOPIFY_STORE_DOMAIN manquant');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN / SHOPIFY_ADMIN_TOKEN manquant');

console.log('-> Shopify :', SHOP, 'API', API_VERSION);
console.log('-> Proxy   :', PROXY);
if (ONLY_SKU)    console.log('-> ONLY_SKU:', ONLY_SKU);
if (MAX_UPLOADS) console.log('-> MAX_UPLOADS:', MAX_UPLOADS);

// ====== Utils ======
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const toRef  = (s)  => s.replace(/\//g, '~'); // règle Sifam
const norm   = (url) => String(url || '').trim().replace(/^http:/i, 'http:').replace(/^https:/i, 'https:');
const tmo    = (ms) => ({ signal: AbortSignal.timeout(ms) });

async function retry(fn, tries = 3, baseDelay = 700) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(baseDelay * (i + 1)); }
  }
  throw last;
}

// ====== GraphQL Admin (lecture produits/variantes/images) ======
async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    ...tmo(25000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    throw new Error(`GraphQL fail: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data;
}

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
    const edges = data.products.edges || [];
    for (const e of edges) yield e.node;
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
}

// ====== Photos Sifam (proxy puis fallback direct API) ======
async function fetchSifamPhotos(sku) {
  const ref = toRef(sku);

  // 1) Proxy
  try {
    const r = await fetch(`${PROXY}/photos/${encodeURIComponent(ref)}`, tmo(20000));
    if (r.ok) {
      const body = await r.json();
      const arr = Array.isArray(body) ? body : body?.photos || [];
      if (arr && arr.length) return arr.map(norm);
    }
  } catch {}

  // 2) Fallback direct Sifam
  if (SIFAM_KEY) {
    try {
      const u = `http://api.sifam.fr/api/photos/${encodeURIComponent(ref)}.json?generique=1&api_key=${encodeURIComponent(SIFAM_KEY)}`;
      const r = await fetch(u, tmo(20000));
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) return arr.map(norm);
      }
    } catch {}
  }

  return [];
}

// ====== Fallback base64 quand Shopify refuse l'URL distante ======
async function fetchBinary(url) {
  const res = await fetch(url, tmo(30000));
  if (!res.ok) throw new Error(`GET ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  return { buf, type };
}

function guessExt(contentType, fallback = 'jpg') {
  const t = contentType.toLowerCase();
  if (t.includes('png'))  return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif'))  return 'gif';
  return fallback;
}

// ====== Upload image (src direct, sinon attachment base64) ======
async function uploadImage(productId, srcUrl, variantIds = []) {
  const pid = String(productId).split('/').pop(); // GID -> id numérique
  const apiUrl = `https://${SHOP}/admin/api/${API_VERSION}/products/${pid}/images.json`;

  // 1) Tentative par URL
  {
    const payload = { image: { src: srcUrl } };
    if (variantIds.length) {
      payload.image.variant_ids = variantIds.map(v => Number(String(v).split('/').pop()));
    }
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...tmo(30000)
    });

    if (res.ok) {
      const out = await res.json();
      return out?.image?.id || null;
    }

    const txt = await res.text().catch(() => '');
    if (!txt.includes('Image URL is invalid')) {
      throw new Error(`Image POST failed ${res.status}: ${txt}`);
    }
  }

  // 2) Fallback base64
  const { buf, type } = await fetchBinary(srcUrl);
  const mb = buf.length / (1024 * 1024);
  if (mb > 20) throw new Error(`Image trop lourde (${mb.toFixed(1)} MB)`);

  const ext = guessExt(type);
  const base64 = buf.toString('base64');

  const payload2 = {
    image: {
      attachment: base64,
      filename: `sifam_${Date.now()}.${ext}`,
    }
  };
  if (variantIds.length) {
    payload2.image.variant_ids = variantIds.map(v => Number(String(v).split('/').pop()));
  }

  const res2 = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload2),
    ...tmo(45000)
  });

  if (!res2.ok) {
    const txt2 = await res2.text().catch(() => '');
    throw new Error(`Image ATTACH failed ${res2.status}: ${txt2}`);
  }

  const out2 = await res2.json();
  return out2?.image?.id || null;
}

// ====== Main ======
async function main() {
  let uploaded = 0, skipped = 0, failed = 0, touchedProducts = 0;

  for await (const p of iterProducts()) {
    // Images déjà présentes
    const existing = new Set(
      (p.images?.edges || []).map(e => norm(e.node?.src)).filter(Boolean)
    );

    // Variantes avec SKU
    const variants = (p.variants?.edges || []).map(e => e.node).filter(v => v?.sku);
    if (ONLY_SKU && !variants.some(v => v.sku === ONLY_SKU)) continue;

    // Pour éviter d'importer la même URL 15x
    const planned = new Set();

    for (const v of variants) {
      if (ONLY_SKU && v.sku !== ONLY_SKU) continue;

      // Photos Sifam
      let photos = [];
      try {
        photos = await retry(() => fetchSifamPhotos(v.sku), 3, 800);
      } catch (e) {
        failed++;
        console.error(`[ERR photos] sku ${v.sku}:`, e.message || e);
        continue;
      }
      if (!photos.length) { skipped++; continue; }

      const primary = photos[0];
      if (!primary || existing.has(primary) || planned.has(primary)) {
        skipped++;
        continue;
      }

      try {
        console.log(`[IMG] product ${p.id} sku ${v.sku} -> ${primary}`);
        await uploadImage(p.id, primary, [v.id]);
        uploaded++;
        touchedProducts++;
        existing.add(primary);
        planned.add(primary);
      } catch (e) {
        failed++;
        console.error(`[FAIL upload] product ${p.id} sku ${v.sku}:`, e.message || e);
      }

      // throttle
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
