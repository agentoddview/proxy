import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";
import { RateLimiterMemory } from "rate-limiter-flexible";

const {
  PORT = 8080,
  PROXY_KEY,                         // shared key Roblox sends in X-Proxy-Key
  ALLOW_ORIGINS = "",                // comma-separated, full origins incl. https://
  TIMEOUT_MS = 15000
} = process.env;

if (!PROXY_KEY) {
  console.error("Missing PROXY_KEY env var");
  process.exit(1);
}

const app = express();

// Security + CORS (IMPORTANT: origins must include scheme, e.g. https://netransit.github.io)
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Roblox HttpService / server-to-server
    const allowed = ALLOW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
    return allowed.length === 0 || allowed.includes(origin)
      ? cb(null, true)
      : cb(new Error("CORS blocked"));
  })
}));

app.use(express.json({ limit: "256kb" }));
app.use(morgan("tiny"));

// Simple auth via shared key
app.use((req, res, next) => {
  const key = req.headers["x-proxy-key"];
  if (key !== PROXY_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Rate limit
const limiter = new RateLimiterMemory({ points: 60, duration: 60 });
app.use(async (req, res, next) => {
  try { await limiter.consume(req.ip); next(); }
  catch { res.status(429).json({ error: "Rate limit exceeded" }); }
});

// Fixed route map (safe)
const targets = {
  "wetrust": "https://net-api.mbtaroblox.com"
};

function makeProxy(targetBase) {
  return createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    secure: true,
    ws: false,
    proxyTimeout: Number(TIMEOUT_MS),
    timeout: Number(TIMEOUT_MS),
    pathRewrite: (path) => {
      // /t/<slug>/... => /...
      const parts = path.split("/").slice(3);
      return "/" + parts.join("/");
    },
    onProxyReq(proxyReq, req) {
      proxyReq.removeHeader("x-proxy-key");

      // OPTIONAL: if the upstream requires an API key, set it here from env
      // if (req.params.slug === "wetrust" && process.env.WETRUST_API_KEY) {
      //   proxyReq.setHeader("Authorization", `Bearer ${process.env.WETRUST_API_KEY}`);
      // }
    }
  });
}

app.use("/t/:slug", (req, res, next) => {
  const base = targets[req.params.slug];
  if (!base) return res.status(404).json({ error: "Unknown target slug" });
  return makeProxy(base)(req, res, next);
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log(`Proxy listening on :${PORT}`));
