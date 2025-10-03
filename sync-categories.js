// sync-sifam-categories.js - Tag products with SIFAM families/categories via proxy
import 'dotenv/config';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP  = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
const PROXY = process.env.PROXY_BASE || process.env.PROXY_URL || 'https://sifam-proxy.onrender.com';

if (!SHOP)  throw new Error('SHOPIFY_DOMAIN / SHOPIFY_STORE_DOMAIN manquant');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN / SHOPIFY_ADMIN_TOKEN manquant');

const tmo = (ms) => ({ signal: AbortSignal.timeout(ms) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, timeout = 25000) {
  const res = await fetch(url, tmo(timeout));
  if (!res.ok) throw new Error(`GET ${res.status} ${url}`);
  return res.json();
}

// Robust field pickers to deal with unknown SIFAM shapes
function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function guessSku(obj) {
  const candidates = [
    'REFERENCE', 'Reference', 'Ref', 'REF', 'ref',
    'ReferenceArticle', 'REFERENCEARTICLE', 'REF_ARTICLE', 'CODEARTICLE', 'CODE_ARTICLE',
    'CODE', 'Code', 'code'
  ];
  let v = pickFirst(obj, candidates);
  if (!v) {
    // try any string value that looks like a reference (alnum and / - _ .)
    for (const [k, val] of Object.entries(obj || {})) {
      if (typeof val === 'string' && /[A-Za-z0-9]/.test(val) && val.length <= 100) { v = val; break; }
    }
  }
  return v ? String(v).trim() : null;
}

function guessFamilyId(obj) {
  const v = pickFirst(obj, ['FID_FAMILLE', 'ID_FAMILLE', 'CODE_FAMILLE', 'id', 'ID', 'code']);
  return v != null ? String(v).trim() : null;
}

function guessFamilyLabel(obj) {
  const v = pickFirst(obj, ['LIBELLE', 'LIB_FAMILLE', 'NOM', 'NAME', 'label', 'Label']);
  return v != null ? String(v).trim() : null;
}

function guessSubCategoryLabel(obj) {
  const keys = Object.keys(obj || {});
  // Prefer explicit sub-family keys
  const preferred = keys.filter(k => /SSFAM|SOUS.?FAM|CATEG/i.test(k));
  const v = pickFirst(obj, preferred);
  if (v != null) return String(v).trim();
  // fallback: any other label-like field
  return null;
}

async function loadFamilies() {
  try {
    const data = await fetchJson(`${PROXY}/familles`, 25000);
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.familles) ? data.familles : []);
    const map = new Map(); // id -> label
    for (const f of arr) {
      const id = guessFamilyId(f);
      const label = guessFamilyLabel(f) || id || '';
      if (id) map.set(String(id), label);
    }
    return map;
  } catch (e) {
    console.warn('WARN: /familles fetch failed, will still try via /catalogue', e.message || e);
    return new Map();
  }
}

async function loadSkuToCategory() {
  const famMap = await loadFamilies();
  const skuMap = new Map(); // sku -> { dept, cat }

  // Try ALL catalogue first; if not working, iterate known family ids (if any)
  let familiesToScan = ['ALL'];
  if (!familiesToScan.length || famMap.size) familiesToScan = ['ALL', ...famMap.keys()];

  for (const fam of familiesToScan) {
    try {
      const url = `${PROXY}/catalogue?fam=${encodeURIComponent(fam)}`;
      const data = await fetchJson(url, 45000);
      const list = Array.isArray(data) ? data : (Array.isArray(data?.articles) ? data.articles : []);
      if (!list.length) continue;

      for (const a of list) {
        const sku = guessSku(a);
        if (!sku) continue;
        const dept = fam === 'ALL' ? (guessFamilyLabel(a) || null) : (famMap.get(String(fam)) || String(fam));
        const cat = guessSubCategoryLabel(a);
        const ex = skuMap.get(sku) || { dept: null, cat: null };
        skuMap.set(sku, {
          dept: ex.dept || dept || null,
          cat:  ex.cat  || cat  || null
        });
      }

      // small throttle
      await sleep(250);
    } catch (e) {
      // ignore and continue
    }
  }

  return skuMap;
}

// Shopify helpers
async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
    ...tmo(30000)
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.errors) throw new Error('GraphQL: ' + JSON.stringify(j?.errors || j));
  return j.data;
}

async function* iterProducts() {
  let cursor = null;
  const Q = `
    query($cursor:String){
      products(first:100, after:$cursor){
        edges{ cursor node{ id handle title tags variants(first:100){ edges{ node{ id sku } } } } }
        pageInfo{ hasNextPage endCursor }
      }
    }`;
  while (true) {
    const d = await gql(Q, { cursor });
    const edges = d.products?.edges || [];
    for (const e of edges) yield e.node;
    if (!d.products?.pageInfo?.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
}

async function addTags(resourceId, tagsToAdd) {
  if (!tagsToAdd.length) return;
  const M = `
    mutation($id:ID!, $tags:[String!]!){
      tagsAdd(id:$id, tags:$tags){ userErrors{ field message } }
    }`;
  const d = await gql(M, { id: resourceId, tags: tagsToAdd });
  const errs = d.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error('tagsAdd: ' + JSON.stringify(errs));
}

async function main() {
  console.log('-> Shopify :', SHOP, 'API', API_VERSION);
  console.log('-> Proxy   :', PROXY);

  const map = await loadSkuToCategory();
  console.log(`Loaded ${map.size} SKU -> category mappings from SIFAM`);

  let updated = 0, skipped = 0;
  for await (const p of iterProducts()) {
    const tags = new Set((p.tags || []).map(String));
    const skus = (p.variants?.edges || []).map(e => e.node?.sku).filter(Boolean);

    const want = [];
    for (const sku of skus) {
      const m = map.get(String(sku));
      if (!m) continue;
      if (m.dept) want.push(`dept:${m.dept}`);
      if (m.cat)  want.push(`cat:${m.cat}`);
    }
    const uniqueWant = [...new Set(want)];
    const toAdd = uniqueWant.filter(t => !tags.has(t));
    if (!toAdd.length) { skipped++; continue; }

    await addTags(p.id, toAdd);
    updated++;
    await sleep(200);
  }

  console.log(JSON.stringify({ updated, skipped }));
}

main().catch(e => { console.error(e); process.exit(1); });

