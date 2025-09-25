// server.js — version propre et unique

import express from "express";
import axios from "axios";
import cors from "cors";

const API = "http://api.sifam.fr";
const KEY = process.env.SIFAM_API_KEY;

const app = express();             // <= une seule déclaration
app.use(express.json());

// CORS: autorise ta boutique + ton domaine Render
const allow = [/\.myshopify\.com$/, /^https:\/\/.*\.onrender\.com$/];
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allow.some(r => r.test(origin))) return cb(null, true);
    cb(new Error("Origin not allowed"));
  },
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type"]
}));

// Healthcheck
app.get("/health", (req,res)=>res.json({ ok: true }));

// Cache mémoire (5 min)
const cache = new Map();
const TTL = 300000;
async function cachedGet(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const r = await axios.get(url, { timeout: 30000 });
  cache.set(url, { v: r.data, t: Date.now() });
  return r.data;
}

// 1) Familles
app.get("/familles", async (req, res) => {
  const url = `${API}/api/familles.json?langue=2&api_key=${KEY}`;
  try { res.json(await cachedGet(url)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// 2) Catalogue par famille
app.get("/catalogue", async (req, res) => {
  const fam = encodeURIComponent(req.query.fam || "ALL");
  const url = `${API}/api/articles/${fam}.json?images=1&dropshipping=1&langue=2&debut=-1&api_key=${KEY}`;
  try { res.json(await cachedGet(url)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// 3) Stock d’un article
app.get("/stock/:ref", async (req, res) => {
  const ref = req.params.ref.replaceAll("/", "~");
  const url = `${API}/api/stock/${ref}.json?api_key=${KEY}`;
  try { res.json(await cachedGet(url)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// 4) Photos d’un article
app.get("/photos/:ref", async (req, res) => {
  const ref = req.params.ref.replaceAll("/", "~");
  const url = `${API}/api/photos/${ref}.json?api_key=${KEY}`;
  try { res.json(await cachedGet(url)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// 5) Envoi commande (dropshipping)
app.post("/commande", async (req, res) => {
  try {
    const r = await axios.post(`${API}/api/commande.json?api_key=${KEY}`, req.body, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    res.status(r.status).json(r.data || { ok: true });
  } catch (e) {
    res.status(e?.response?.status || 502).json({ error: e?.response?.data || e.message });
  }
});

// 6) Suivi commande
app.get("/suivi/:refcmd", async (req, res) => {
  const url = `${API}/api/commande/${encodeURIComponent(req.params.refcmd)}.json?api_key=${KEY}`;
  try { res.json(await cachedGet(url)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// 7) Webhook Shopify -> Relay vers SIFAM (optionnel mais utile)
app.post("/relay/order-paid", async (req, res) => {
  try {
    const o = req.body;
    const pad = n => String(n).padStart(2, "0");
    const now = new Date();
    const payload = {
      CodeClient: "2",
      DateCmd: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`,
      HeureCmd: `${pad(now.getHours())}${pad(now.getMinutes())}`,
      ReferenceCommande: String(o.id),
      ChronoRelais: 1,
      NomClient: `${o.shipping_address?.first_name||""} ${o.shipping_address?.last_name||""}`.trim(),
      NomLivraison: `${o.shipping_address?.first_name||""} ${o.shipping_address?.last_name||""}`.trim(),
      Adresse1: o.shipping_address?.address1 || "",
      Adresse2: o.shipping_address?.address2 || "",
      CodePostal: o.shipping_address?.zip || "",
      Ville: o.shipping_address?.city || "",
      CodePays: (o.shipping_address?.country_code || "FR").toUpperCase(),
      Telephone: o.shipping_address?.phone || o.customer?.phone || "",
      Email: o.email,
      Express: 2,
      Prefix: "XXX",
      Articles: (o.line_items||[]).map(li => ({ ReferenceArticle: li.sku, Quantite: String(li.quantity) }))
    };

    const r = await axios.post(`${API}/api/commande.json?api_key=${KEY}`, payload, {
      headers: { "Content-Type": "application/json" }, timeout: 30000
    });
    res.status(r.status).json(r.data || { ok: true });
  } catch (e) {
    res.status(e?.response?.status || 502).json({ error: e?.response?.data || e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SIFAM proxy on :${PORT}`));
