// Ollama API → LM Studio (OpenAI-compatible API) Bridge
// Usage: node bridge.mjs [--ollama-port 11434] [--lmstudio-url http://localhost:1234]

import http from "node:http";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

const OLLAMA_HOST = flag("--ollama-host", "127.0.0.1");
const OLLAMA_PORT = Number(flag("--ollama-port", "11434"));
const LMSTUDIO_BASE = flag("--lmstudio-url", "http://127.0.0.1:1234");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Forward a fetch to LM Studio and return the Response */
async function lmFetch(path, opts = {}) {
  const url = `${LMSTUDIO_BASE}${path}`;
  return fetch(url, opts);
}

/** Read entire request body as string */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Send JSON response */
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Current ISO timestamp in Ollama format */
function ollamaTimestamp() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Route: GET / — health check
// ---------------------------------------------------------------------------
function handleRoot(_req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Ollama is running");
}

// ---------------------------------------------------------------------------
// Route: GET /api/version
// ---------------------------------------------------------------------------
const OLLAMA_VERSION = flag("--ollama-version", "0.8.0");

function handleVersion(_req, res) {
  json(res, 200, { version: OLLAMA_VERSION });
}

// ---------------------------------------------------------------------------
// Route: GET /api/tags — list models
// ---------------------------------------------------------------------------
async function handleTags(_req, res) {
  try {
    const r = await lmFetch("/v1/models");
    const body = await r.json();
    const models = (body.data || []).map((m) => ({
      name: m.id,
      model: m.id,
      modified_at: ollamaTimestamp(),
      size: 0,
      digest: "0000000000000000",
      details: {
        parent_model: "",
        format: "gguf",
        family: "",
        families: [],
        parameter_size: "",
        quantization_level: "",
      },
    }));
    json(res, 200, { models });
  } catch (e) {
    json(res, 502, { error: `LM Studio unreachable: ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/show — model info (synthesised)
// ---------------------------------------------------------------------------
async function handleShow(req, res) {
  const data = JSON.parse(await readBody(req));
  const modelName = data.name || data.model || "";
  // Try to find the model in LM Studio's model list
  try {
    const r = await lmFetch("/v1/models");
    const body = await r.json();
    const found = (body.data || []).find((m) => m.id === modelName);
    if (!found) {
      json(res, 404, { error: `model '${modelName}' not found` });
      return;
    }
    json(res, 200, {
      modelfile: "",
      parameters: "",
      template: "",
      details: {
        parent_model: "",
        format: "gguf",
        family: "",
        families: [],
        parameter_size: "",
        quantization_level: "",
      },
      model_info: {},
    });
  } catch (e) {
    json(res, 502, { error: `LM Studio unreachable: ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/chat — chat completion (streaming & non-streaming)
// ---------------------------------------------------------------------------
async function handleChat(req, res) {
  const data = JSON.parse(await readBody(req));
  const stream = data.stream !== false; // default true

  const openAIBody = {
    model: data.model,
    messages: (data.messages || []).map((m) => {
      const msg = { role: m.role, content: m.content };
      if (m.images && m.images.length > 0) {
        // Convert Ollama image format to OpenAI vision format
        msg.content = [
          { type: "text", text: m.content || "" },
          ...m.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${img}` },
          })),
        ];
      }
      return msg;
    }),
    stream,
  };
  if (data.options) {
    if (data.options.temperature != null) openAIBody.temperature = data.options.temperature;
    if (data.options.top_p != null) openAIBody.top_p = data.options.top_p;
    if (data.options.num_predict != null) openAIBody.max_tokens = data.options.num_predict;
    if (data.options.stop) openAIBody.stop = data.options.stop;
    if (data.options.seed != null) openAIBody.seed = data.options.seed;
    if (data.options.frequency_penalty != null) openAIBody.frequency_penalty = data.options.frequency_penalty;
    if (data.options.presence_penalty != null) openAIBody.presence_penalty = data.options.presence_penalty;
    if (data.options.top_k != null) openAIBody.top_k = data.options.top_k;
  }
  if (data.keep_alive != null) {
    // No equivalent in OpenAI API — ignore
  }

  try {
    const r = await lmFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openAIBody),
    });

    if (!r.ok) {
      const errText = await r.text();
      json(res, r.status, { error: errText });
      return;
    }

    if (!stream) {
      // Non-streaming
      const body = await r.json();
      const choice = body.choices?.[0];
      const ollamaResp = {
        model: data.model,
        created_at: ollamaTimestamp(),
        message: {
          role: choice?.message?.role || "assistant",
          content: choice?.message?.content || "",
        },
        done: true,
        done_reason: "stop",
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: body.usage?.prompt_tokens || 0,
        prompt_eval_duration: 0,
        eval_count: body.usage?.completion_tokens || 0,
        eval_duration: 0,
      };
      json(res, 200, ollamaResp);
      return;
    }

    // Streaming: convert SSE → Ollama NDJSON
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    });
    res.flushHeaders();

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            // Final message
            const final = {
              model: data.model,
              created_at: ollamaTimestamp(),
              message: { role: "assistant", content: "" },
              done: true,
              done_reason: "stop",
              total_duration: 0,
              load_duration: 0,
              prompt_eval_count: 0,
              prompt_eval_duration: 0,
              eval_count: 0,
              eval_duration: 0,
            };
            res.write(JSON.stringify(final) + "\n");
            continue;
          }
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta || {};
            const ollamaChunk = {
              model: data.model,
              created_at: ollamaTimestamp(),
              message: {
                role: delta.role || "assistant",
                content: delta.content || "",
              },
              done: false,
            };
            res.write(JSON.stringify(ollamaChunk) + "\n");
          } catch {
            // skip malformed chunks
          }
        }
      }
    };

    // Detect client disconnect
    res.on("close", () => {
      reader.cancel().catch(() => {});
    });

    await pump();
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      json(res, 502, { error: `LM Studio unreachable: ${e.message}` });
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/generate — text generation (streaming & non-streaming)
// ---------------------------------------------------------------------------
async function handleGenerate(req, res) {
  const data = JSON.parse(await readBody(req));
  const stream = data.stream !== false;

  // Convert generate request to chat format via LM Studio
  const messages = [];
  if (data.system) {
    messages.push({ role: "system", content: data.system });
  }
  messages.push({ role: "user", content: data.prompt || "" });

  const openAIBody = {
    model: data.model,
    messages,
    stream,
  };
  if (data.options) {
    if (data.options.temperature != null) openAIBody.temperature = data.options.temperature;
    if (data.options.top_p != null) openAIBody.top_p = data.options.top_p;
    if (data.options.num_predict != null) openAIBody.max_tokens = data.options.num_predict;
    if (data.options.stop) openAIBody.stop = data.options.stop;
    if (data.options.seed != null) openAIBody.seed = data.options.seed;
  }

  try {
    const r = await lmFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openAIBody),
    });

    if (!r.ok) {
      const errText = await r.text();
      json(res, r.status, { error: errText });
      return;
    }

    if (!stream) {
      const body = await r.json();
      const choice = body.choices?.[0];
      const ollamaResp = {
        model: data.model,
        created_at: ollamaTimestamp(),
        response: choice?.message?.content || "",
        done: true,
        done_reason: "stop",
        context: [],
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: body.usage?.prompt_tokens || 0,
        prompt_eval_duration: 0,
        eval_count: body.usage?.completion_tokens || 0,
        eval_duration: 0,
      };
      json(res, 200, ollamaResp);
      return;
    }

    // Streaming
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    });
    res.flushHeaders();

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            const final = {
              model: data.model,
              created_at: ollamaTimestamp(),
              response: "",
              done: true,
              done_reason: "stop",
              context: [],
              total_duration: 0,
              load_duration: 0,
              prompt_eval_count: 0,
              prompt_eval_duration: 0,
              eval_count: 0,
              eval_duration: 0,
            };
            res.write(JSON.stringify(final) + "\n");
            continue;
          }
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta || {};
            const ollamaChunk = {
              model: data.model,
              created_at: ollamaTimestamp(),
              response: delta.content || "",
              done: false,
            };
            res.write(JSON.stringify(ollamaChunk) + "\n");
          } catch {
            // skip
          }
        }
      }
    };

    res.on("close", () => {
      reader.cancel().catch(() => {});
    });

    await pump();
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      json(res, 502, { error: `LM Studio unreachable: ${e.message}` });
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/embeddings & /api/embed
// ---------------------------------------------------------------------------
async function handleEmbeddings(req, res) {
  const data = JSON.parse(await readBody(req));
  const input = data.prompt || data.input || "";

  try {
    const r = await lmFetch("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: data.model,
        input: Array.isArray(input) ? input : [input],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      json(res, r.status, { error: errText });
      return;
    }

    const body = await r.json();
    const embeddings = (body.data || []).map((d) => d.embedding);
    json(res, 200, {
      model: data.model,
      embeddings,
    });
  } catch (e) {
    json(res, 502, { error: `LM Studio unreachable: ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/pull, /api/push, /api/copy, /api/delete — stubs
// ---------------------------------------------------------------------------
function handleStub(_req, res) {
  json(res, 200, { status: "success" });
}

// ---------------------------------------------------------------------------
// Route: HEAD /  — some clients do a HEAD request
// ---------------------------------------------------------------------------
function handleHead(_req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS headers for browser-based clients
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // Health & version
    if (path === "/" && req.method === "GET") return handleRoot(req, res);
    if (path === "/" && req.method === "HEAD") return handleHead(req, res);
    if (path === "/api/version" && req.method === "GET") return handleVersion(req, res);

    // Models
    if (path === "/api/tags" && req.method === "GET") return await handleTags(req, res);
    if (path === "/api/show" && req.method === "POST") return await handleShow(req, res);

    // Generation
    if (path === "/api/chat" && req.method === "POST") return await handleChat(req, res);
    if (path === "/api/generate" && req.method === "POST") return await handleGenerate(req, res);

    // Embeddings
    if ((path === "/api/embeddings" || path === "/api/embed") && req.method === "POST")
      return await handleEmbeddings(req, res);

    // Stubs for model management (not applicable to LM Studio)
    if (["/api/pull", "/api/push", "/api/copy", "/api/delete"].includes(path) && req.method === "POST")
      return handleStub(req, res);

    // Also support /v1/* passthrough for tools that may use OpenAI format directly
    if (path.startsWith("/v1/")) {
      const body = req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined;
      const r = await lmFetch(path, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body } : {}),
      });
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
      const respBody = await r.text();
      res.end(respBody);
      return;
    }

    json(res, 404, { error: `unknown route: ${req.method} ${path}` });
  } catch (e) {
    console.error(`Error handling ${req.method} ${path}:`, e);
    if (!res.headersSent) {
      json(res, 500, { error: e.message });
    } else {
      res.end();
    }
  }
});

server.listen(OLLAMA_PORT, OLLAMA_HOST, () => {
  console.log(`Ollama Bridge started`);
  console.log(`  Listening : http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
  console.log(`  Forwarding: ${LMSTUDIO_BASE}`);
  console.log();
  console.log(`Supported endpoints:`);
  console.log(`  GET  /              → health check`);
  console.log(`  GET  /api/version   → bridge version`);
  console.log(`  GET  /api/tags      → list models (from LM Studio)`);
  console.log(`  POST /api/show      → model info`);
  console.log(`  POST /api/chat      → chat completion (streaming)`);
  console.log(`  POST /api/generate  → text generation (streaming)`);
  console.log(`  POST /api/embeddings→ embeddings`);
  console.log(`  /v1/*               → passthrough to LM Studio`);
  console.log();
  console.log(`Ollama version: ${OLLAMA_VERSION}`);
});
