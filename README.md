# Forge AI

Forge AI is a free suite of AI-powered tools for creators and small businesses. It requires no account, no API keys from the user, and keeps all file processing locally in the browser.

## Features
- **Image Studio**: High-quality image generation using Pollinations.ai with optional Groq-powered prompt enhancement.
- **Video Lab**: In-browser video editing, auto-captioning, and silence removal powered by FFmpeg.wasm and Gemini.
- **Writing Hub**: Context-aware content generation forms utilizing Groq and Cloudflare Workers AI.
- **Document Brain**: Client-side document parsing and AI analysis (summarization, extraction, chat) using Gemini Flash.

## Architecture
- **Frontend**: A single `index.html` file (no frameworks, no build step, no npm dependencies). Heavy libraries are loaded via CDN only when needed.
- **Backend**: A Cloudflare Worker (`worker.js`) that securely proxies AI API calls, handles IP-based daily rate limits using Cloudflare KV, and manages CORS.

## Deployment Instructions

### 1. Cloudflare KV Setup
First, create a Cloudflare KV namespace for tracking rate limits.

Run the following command using the Wrangler CLI:
```bash
npx wrangler kv:namespace create KV_STORE
```

This will output a configuration block. Copy the `id` and update the `wrangler.toml` file in this repository:
```toml
[[kv_namespaces]]
binding = "KV_STORE"
id = "YOUR_KV_NAMESPACE_ID_HERE"
```

### 2. Set API Secrets
The worker uses Gemini and Groq APIs. You need to store these securely as Cloudflare secrets.

Run the following commands and paste your API keys when prompted:
```bash
npx wrangler secret put GEMINI_KEY
npx wrangler secret put GROQ_KEY
```

### 3. Deploy the Worker
Deploy the `worker.js` script to Cloudflare:
```bash
npx wrangler deploy
```

Once deployed, Wrangler will output the URL for your worker (e.g., `https://forge-ai.your-subdomain.workers.dev`).

### 4. Configure Frontend
Open `index.html` and update the `API_BASE` constant at the top of the script block to point to your deployed worker URL:
```javascript
const API_BASE = 'https://forge-ai.your-subdomain.workers.dev';
```

### 5. Host the Frontend
You can host the `index.html` file on any static file hosting service, such as:
- Cloudflare Pages
- GitHub Pages
- Vercel
- Netlify

Since everything is inline, simply upload the `index.html` file to the root of your hosting provider.
