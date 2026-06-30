export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

    // Rate Limiting Config
    const limits = {
      "/api/image": parseInt(env.LIMIT_IMAGE || "50"),
      "/api/chat": parseInt(env.LIMIT_CHAT || "200"),
      "/api/transcribe": parseInt(env.LIMIT_TRANSCRIBE || "20"),
      "/api/document": parseInt(env.LIMIT_DOCUMENT || "30")
    };

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    
    // Status endpoint bypasses rate limiting for itself, but fetches usage
    if (path === "/api/status" && request.method === "GET") {
      try {
        const getUsage = async (route) => parseInt(await env.KV_STORE.get(`rl:${ip}:${route}:${dateStr}`) || "0");
        return new Response(JSON.stringify({
          image: { used: await getUsage("/api/image"), limit: limits["/api/image"] },
          chat: { used: await getUsage("/api/chat"), limit: limits["/api/chat"] },
          transcribe: { used: await getUsage("/api/transcribe"), limit: limits["/api/transcribe"] },
          document: { used: await getUsage("/api/document"), limit: limits["/api/document"] },
          resetsAt: "midnight UTC"
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Apply Rate Limiting
    if (limits[path]) {
      const key = `rl:${ip}:${path}:${dateStr}`;
      let usage = parseInt(await env.KV_STORE.get(key) || "0");
      if (usage >= limits[path]) {
        return new Response(JSON.stringify({ error: "Daily limit reached", reset: "midnight UTC" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      ctx.waitUntil(env.KV_STORE.put(key, (usage + 1).toString(), { expirationTtl: 86400 })); // Expire in 24h
    }

    try {
      // IMAGE STUDIO
      if (path === "/api/image" && request.method === "POST") {
        const { prompt, style, width, height, enhance } = await request.json();
        let finalPrompt = prompt;
        if (style) finalPrompt += `, ${style} style`;

        if (enhance && env.GROQ_KEY) {
          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GROQ_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: [
                { role: "system", content: "You are an expert at writing image generation prompts. Enhance the user's prompt to be more detailed and vivid. Return ONLY the enhanced prompt, nothing else." },
                { role: "user", content: finalPrompt }
              ]
            })
          });
          if (groqRes.ok) {
            const groqData = await groqRes.json();
            finalPrompt = groqData.choices[0].message.content.trim();
          }
        }
        
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=${width || 1024}&height=${height || 1024}&model=flux&nologo=true`;
        const imageRes = await fetch(imageUrl);
        return new Response(imageRes.body, {
          headers: { ...corsHeaders, "Content-Type": "image/jpeg" }
        });
      }

      // WRITING HUB / CHAT
      if (path === "/api/chat" && request.method === "POST") {
        const { messages, mode } = await request.json();
        
        if (mode === "fast" && env.AI) {
          const aiRes = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages,
            stream: true,
            max_tokens: 2048
          });
          return new Response(aiRes, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
        } else if (mode === "smart" && env.GEMINI_KEY) {
          const geminiMessages = messages.map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }]
          }));
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              "X-goog-api-key": env.GEMINI_KEY
            },
            body: JSON.stringify({ contents: geminiMessages })
          });
          if (!geminiRes.ok) {
            const errBody = await geminiRes.text();
            return new Response(errBody, { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          return new Response(geminiRes.body, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
        } else if ((mode === "business" || !mode) && env.GROQ_KEY) {
          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.GROQ_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, stream: true })
          });
          return new Response(groqRes.body, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
        } else {
          return new Response(JSON.stringify({ error: "Invalid mode or missing API key" }), { status: 400, headers: corsHeaders });
        }
      }

      // VIDEO LAB TRANSCRIBE
      if (path === "/api/transcribe" && request.method === "POST") {
        const { audioBase64, mimeType } = await request.json();
        if (!env.GEMINI_KEY) return new Response(JSON.stringify({ error: "Missing Gemini Key" }), { status: 500, headers: corsHeaders });

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "X-goog-api-key": env.GEMINI_KEY
          },
          body: JSON.stringify({
            generationConfig: { responseMimeType: "application/json" },
            contents: [{
              parts: [
                { inline_data: { mime_type: mimeType || "audio/mp3", data: audioBase64 } },
                { text: "Transcribe with word-level timestamps. Return ONLY a JSON array: [{\"word\": \"...\", \"start\": 0.0, \"end\": 1.0}] in seconds. No markdown, no explanation." }
              ]
            }]
          })
        });
        const data = await geminiRes.json();
        if (!geminiRes.ok || !data.candidates || data.candidates.length === 0) {
          const errMsg = data.error?.message || "Gemini API request failed";
          return new Response(JSON.stringify({ error: errMsg }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        let words = [];
        try {
          let textResp = data.candidates[0].content.parts[0].text;
          textResp = textResp.replace(/```json/gi, '').replace(/```/g, '').trim();
          words = JSON.parse(textResp);
        } catch (e) {
          console.error("Failed to parse Gemini response", e);
        }
        return new Response(JSON.stringify({ words }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // DOCUMENT BRAIN
      if (path === "/api/document" && request.method === "POST") {
        const { content, filename, action, question, history = [] } = await request.json();
        if (!env.GEMINI_KEY) return new Response(JSON.stringify({ error: "Missing Gemini Key" }), { status: 500, headers: corsHeaders });

        let prompt = `You are an expert document analyst analyzing a document named "${filename}". Be concise, accurate, and structured. Use markdown for readability.\n\nDocument Content:\n${content.substring(0, 80000)}\n\n`;

        if (action === "summarize") {
          prompt += "Return a JSON object with strictly these keys: overview (string), keyPoints (array of strings), topics (array of strings), sentiment (string). No markdown blocks outside the JSON, just the JSON.";
        } else if (action === "chat") {
           prompt += `Conversation history:\n${history.map(h => h.role + ': ' + h.content).join('\n')}\n\nUser Question: ${question}`;
        } else if (action === "extract") {
          prompt += `Extract all ${question}. Return a structured JSON array of objects. No markdown blocks outside the JSON, just the JSON array.`;
        } else if (action === "rewrite") {
          prompt += `Rewrite the content according to this instruction: ${question}`;
        }

        const requestBody = { contents: [{ parts: [{ text: prompt }] }] };
        if (action === "summarize" || action === "extract") {
            requestBody.generationConfig = { responseMimeType: "application/json" };
        }

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "X-goog-api-key": env.GEMINI_KEY
          },
          body: JSON.stringify(requestBody)
        });
        const data = await geminiRes.json();
        if (!geminiRes.ok || !data.candidates || data.candidates.length === 0) {
          const errMsg = data.error?.message || "Gemini API request failed";
          return new Response(JSON.stringify({ error: errMsg }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        let result = data.candidates[0].content.parts[0].text;
        
        if (action === "summarize" || action === "extract") {
            result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
            // validate json output just to be safe
            try {
                result = JSON.stringify(JSON.parse(result));
            } catch (e) {
                // Return raw text if parse fails, frontend will handle it
            }
        }

        return new Response(JSON.stringify({ result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};
