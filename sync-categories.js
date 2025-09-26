  // sync-categories.js — ajoute des tags dept:/cat: basés sur les préfixes SKU
import 'dotenv/config';
import fs from 'node:fs';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP  = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;

if (!SHOP || !TOKEN) throw new Error('SHOPIFY_* manquants');

const MAP = JSON.parse(fs.readFileSync('./category-map.json','utf8'));

// GraphQL helpers
const tmo = ms => ({ signal: AbortSignal.timeout(ms) });
const gql = async (query, variables = {}) => {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }), ...tmo(25000)
  });
  const j = await r.json().catch(()=>null);
  if (!r.ok || !j || j.errors) throw new Error('GraphQL: ' + JSON.stringify(j?.errors || j));
  return j.data;
};

async function* iterProducts() {
  let cursor = null;
  const Q = `
    query($cursor:String){
      products(first:100, after:$cursor){
        edges{
          cursor
          node{
            id handle title tags
            variants(first:100){ edges{ node{ id sku } } }
          }
        }
        pageInfo{ hasNextPage endCursor }
      }
    }`;
  while (true) {
    const d = await gql(Q, { cursor });
    for (const e of d.products.edges) yield e.node;
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
}

// Trouve dept/cat à partir des préfixes SKU
function classifyBySkuPrefix(skus) {
  const upperSkus = skus.map(s => String(s || '').toUpperCase());
  for (const [dept, cats] of Object.entries(MAP)) {
    for (const [cat, prefixes] of Object.entries(cats)) {
      const hit = upperSkus.some(sku => prefixes.some(p => sku.startsWith(p.toUpperCase())));
      if (hit) return { dept, cat };
    }
  }
  return null;
}

// Ajoute des tags sans écraser les existants
async function addTags(resourceId, tagsToAdd) {
  const M = `
    mutation($id:ID!, $tags:[String!]!){
      tagsAdd(id:$id, tags:$tags){ userErrors{ field message } }
    }`;
  const d = await gql(M, { id: resourceId, tags: tagsToAdd });
  const errs = d.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error('tagsAdd: ' + JSON.stringify(errs));
}

async function main() {
  let updated=0, skipped=0;
  for await (const p of iterProducts()) {
    const skus = (p.variants?.edges || []).map(e => e.node?.sku).filter(Boolean);
    if (!skus.length) { skipped++; continue; }

    const found = classifyBySkuPrefix(skus);
    if (!found) { skipped++; continue; }

    const want = [`dept:${found.dept}`, `cat:${found.cat}`];
    const has = new Set((p.tags || []).map(String));
    const toAdd = want.filter(t => !has.has(t));
    if (!toAdd.length) { skipped++; continue; }

    await addTags(p.id, toAdd);
    updated++;
    await new Promise(r => setTimeout(r, 200)); // throttle léger
  }
  console.log(JSON.stringify({ updated, skipped }));
}
main().catch(e => { console.error(e); process.exit(1); });
