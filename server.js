import express from "express";
import axios from "axios";
import cors from "cors";
app.use(cors({ origin: "*" }));


const app = express();
app.use(express.json());

const API = "http://api.sifam.fr";
const KEY = process.env.SIFAM_API_KEY;
const app = express();
app.use(express.json());

const API = "http://api.sifam.fr";
const KEY = process.env.SIFAM_API_KEY;

// petit cache mémoire (5 min)
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

// Render fournit process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SIFAM proxy running on :${PORT}`));
