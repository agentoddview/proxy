import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";
import { RateLimiterMemory } from "rate-limiter-flexible";

const {
  PORT = 8080,
  PROXY_KEY,                 // required: shared key your Roblox code sends in header
  ALLOW_ORIGINS = "",        // comma list of allowed origins for CORS (e.g. your site)
  TIMEOUT_MS = 15000
} = process.env;

if (!PROXY_KEY) {
  console.error("Missing PROXY_KEY env var");
  process.exit(1);
}

const app = express();

// Basic security + CORS
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = ALLOW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
    return allowed.length === 0 || allowed.includes(origin)
      ? cb(null, true)
      : cb(new Error("CORS blocked"));
  })
}));

app.use(express.json({ limit: "256kb" }));
app.use(morgan("tiny"));

// Very simple auth (send same key from Roblox)
app.use((req, res, next) => {
  const key = req.headers["x-proxy-key"];
  if (key !== PROXY_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Rate limit per IP (memory; fine for small installs)
const limiter = new RateLimiterMemory({ points: 60, duration: 60 });
app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    next();
  } catch {
    res.status(429).json({ error: "Rate limit exceeded" });
  }
});

// Map fixed routes to upstreams (safe!)
const targets = {
  // example slugs you can use from Roblox:
  // GET https://your-proxy.example.com/t/myapi/endpoint
  "myapi": "https://api.example.com",
  // add more:
  // "openai": "https://api.openai.com",
  // "sheet":  "https://script.google.com",
};

function makeProxy(targetBase) {
  return createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    secure: true,
    ws: false,
    proxyTimeout: Number(TIMEOUT_MS),
    timeout: Number(TIMEOUT_MS),
    pathRewrite: (path, req) => {
      // /t/<slug>/... => /...
      const parts = path.split("/").slice(3);
      return "/" + parts.join("/");
    },
    onProxyReq(proxyReq, req, res) {
      // Strip internal headers, keep things tidy
      proxyReq.removeHeader("x-proxy-key");
      // Optional: add upstream API key here from env to keep Roblox clean
      // if (req.params.slug === "myapi") proxyReq.setHeader("Authorization", `Bearer ${process.env.MYAPI_KEY}`);
    }
  });
}

app.use("/t/:slug", (req, res, next) => {
  const slug = req.params.slug;
  const base = targets[slug];
  if (!base) return res.status(404).json({ error: "Unknown target slug" });
  return makeProxy(base)(req, res, next);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => console.log(`Proxy listening on :${PORT}`));
