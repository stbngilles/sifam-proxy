// sync-categories.js — tags dept:/cat: via préfixes SKU + fallback mots-clés titre
import 'dotenv/config';
import fs from 'node:fs';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP  = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
if (!SHOP || !TOKEN) throw new Error('SHOPIFY_* manquants');

const MAP = JSON.parse(fs.readFileSync('./category-map.json','utf8'));

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

/* ---------- Classification ---------- */
// 1) Préfixes SKU (MAP)
function classifyBySkuPrefix(skus) {
  const upperSkus = skus.map(s => String(s || '').toUpperCase());
  for (const [dept, cats] of Object.entries(MAP)) {
    for (const [cat, prefixes] of Object.entries(cats)) {
      const hit = upperSkus.some(sku =>
        prefixes.some(p => sku.startsWith(String(p).toUpperCase()))
      );
      if (hit) return { dept, cat, why: 'sku-prefix' };
    }
  }
  return null;
}

// 2) Fallback: mots-clés du titre
function classifyByTitle(title) {
  const t = String(title || '').toUpperCase();
  const rules = [
    { dept: 'MOTEUR / DEMARRAGE',        cat: 'SONDE LAMBDA',         test: /\bLAMBDA\b/ },
    { dept: 'ECLAIRAGE & SIGNALISATION', cat: 'AMPOULES',             test: /\bAMPOULE(S)?\b|LEDDRIVING/ },
    { dept: 'ECLAIRAGE & SIGNALISATION', cat: 'CENTRALES & RELAIS',   test: /\bCENTRALE|RELAIS?\b/ },
    { dept: 'ELECTRIQUE MOTO',           cat: 'BOITIER',              test: /\bBOI(TIER|T\.)|ECU\b/ },
    { dept: 'ELECTRIQUE MOTO',           cat: 'CONTACTEUR & CLEF',    test: /\bCONTACTEUR|CLE(F|FS)?|NEIMAN|SERRURE\b/ },
    { dept: 'ELECTRIQUE MOTO',           cat: 'CONNECTIQUE',          test: /\bCOSSE|CONNECT(ION|EUR|IQUE)\b/ },
    { dept: 'MOTEUR / DEMARRAGE',        cat: 'DEMARREUR',            test: /\bDEMARREUR\b/ },
    { dept: 'MOTEUR / DEMARRAGE',        cat: 'EMBRAYAGE DEMARREUR',  test: /\bEMBRAYAGE.+DEMARREUR|ROUE.?LIBRE\b/ },
    { dept: 'MOTEUR / DEMARRAGE',        cat: 'POMPE A ESSENCE',      test: /\bPOMPE.+ESSENCE|FUEL.+PUMP|GAS.?PUMP\b/ }
  ];
  for (const r of rules) if (r.test.test(t)) return { dept: r.dept, cat: r.cat, why: 'title-rule' };
  return null;
}

/* ---------- Mutations ---------- */
async function addTags(resourceId, tagsToAdd) {
  const M = `
    mutation($id:ID!, $tags:[String!]!){
      tagsAdd(id:$id, tags:$tags){ userErrors{ field message } }
    }`;
  const d = await gql(M, { id: resourceId, tags: tagsToAdd });
  const errs = d.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error('tagsAdd: ' + JSON.stringify(errs));
}

/* ---------- Main ---------- */
async function main() {
  let updated = 0, skipped = 0;
  for await (const p of iterProducts()) {
    const skus = (p.variants?.edges || []).map(e => e.node?.sku).filter(Boolean);
    const bySku   = skus.length ? classifyBySkuPrefix(skus) : null;
    const byTitle = bySku ? null : classifyByTitle(p.title);
    const choice  = bySku || byTitle;
    if (!choice) { skipped++; continue; }

    const want = [`dept:${choice.dept}`, `cat:${choice.cat}`];
    const has  = new Set((p.tags || []).map(String));
    const toAdd = want.filter(t => !has.has(t));
    if (!toAdd.length) { skipped++; continue; }

    await addTags(p.id, toAdd);
    updated++;
    await new Promise(r => setTimeout(r, 200)); // throttle léger
  }
  console.log(JSON.stringify({ updated, skipped }));
}

main().catch(e => { console.error(e); process.exit(1); });
