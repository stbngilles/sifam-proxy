// export-uncategorized.js — liste les produits sans tags dept:/cat:
import 'dotenv/config';
import fs from 'node:fs';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOP  = process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
if (!SHOP || !TOKEN) throw new Error('SHOPIFY_* manquants');

const tmo = ms => ({ signal: AbortSignal.timeout(ms) });
const gql = async (q, v={}) => {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method:'POST', headers:{'Content-Type':'application/json','X-Shopify-Access-Token':TOKEN},
    body:JSON.stringify({query:q, variables:v}), ...tmo(25000)
  });
  const j = await r.json().catch(()=>null);
  if (!r.ok || !j || j.errors) throw new Error(JSON.stringify(j?.errors || j));
  return j.data;
};

async function* products(){
  let cursor = null;
  const Q = `
  query($cursor:String){
    products(first:100, after:$cursor){
      edges{
        cursor
        node{
          id handle title tags
          variants(first:100){ edges{ node{ sku } } }
        }
      }
      pageInfo{ hasNextPage endCursor }
    }
  }`;
  while(true){
    const d = await gql(Q,{cursor});
    for (const e of d.products.edges) yield e.node;
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
}

const rows = [["handle","title","skus","tags"]];
for await (const p of products()){
  const tags = (p.tags||[]).map(String);
  const hasDept = tags.some(t=>t.startsWith("dept:"));
  const hasCat  = tags.some(t=>t.startsWith("cat:"));
  if (hasDept && hasCat) continue;
  const skus = (p.variants?.edges||[]).map(e=>e.node?.sku).filter(Boolean).join(" | ");
  rows.push([p.handle, p.title.replaceAll('"','""'), skus, tags.join(" | ")]);
}
const csv = rows.map(r => r.map(v => `"${(v??'').toString()}"`).join(",")).join("\n");
fs.writeFileSync("./uncategorized.csv", csv);
console.log(`Export -> ./uncategorized.csv (${rows.length-1} produits)`);
