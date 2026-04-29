#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (typeof request === "string" && request.endsWith(".js")) {
    const tsRequest = request.slice(0, -3) + ".ts";
    try {
      return originalResolveFilename.call(this, tsRequest, parent, isMain, options);
    } catch {
      // Fall through to the original request so real JS dependencies still load normally.
    }
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

function registerTypeScriptExtension(extension) {
  Module._extensions[extension] = function register(module, filename) {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: filename,
    });

    module._compile(output.outputText, filename);
  };
}

registerTypeScriptExtension(".ts");
registerTypeScriptExtension(".tsx");

if (typeof globalThis.AbortController === "undefined") {
  class PolyfillAbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this._listeners = new Set();
      this.onabort = null;
    }

    addEventListener(type, listener) {
      if (type === "abort" && typeof listener === "function") {
        this._listeners.add(listener);
      }
    }

    removeEventListener(type, listener) {
      if (type === "abort") {
        this._listeners.delete(listener);
      }
    }

    dispatchEvent(event) {
      if (event?.type !== "abort") return false;
      for (const listener of this._listeners) {
        try {
          listener.call(this, event);
        } catch {
          // Ignore listener failures in polyfill dispatch.
        }
      }
      if (typeof this.onabort === "function") {
        try {
          this.onabort.call(this, event);
        } catch {
          // Ignore listener failures in polyfill dispatch.
        }
      }
      return true;
    }

    static timeout(ms) {
      const controller = new PolyfillAbortController();
      setTimeout(() => {
        controller.abort(new Error("TimeoutError"));
      }, ms);
      return controller.signal;
    }
  }

  class PolyfillAbortController {
    constructor() {
      this.signal = new PolyfillAbortSignal();
    }

    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      this.signal.dispatchEvent({ type: "abort" });
    }
  }

  globalThis.AbortSignal = PolyfillAbortSignal;
  globalThis.AbortController = PolyfillAbortController;
}

if (typeof globalThis.AbortSignal.timeout !== "function") {
  globalThis.AbortSignal.timeout = function timeout(ms) {
    const controller = new globalThis.AbortController();
    setTimeout(() => {
      controller.abort(new Error("TimeoutError"));
    }, ms);
    return controller.signal;
  };
}

if (typeof globalThis.fetch === "undefined") {
  class PolyfillResponse {
    constructor(status, headers, bodyBuffer) {
      this.status = status;
      this.ok = status >= 200 && status < 300;
      this._headers = headers;
      this._body = bodyBuffer;
      this.headers = {
        get: (name) => this._headers[String(name).toLowerCase()] ?? null,
      };
    }

    async text() {
      return this._body.toString("utf8");
    }

    async json() {
      return JSON.parse(await this.text());
    }
  }

  globalThis.fetch = function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(url);
      const method = options.method ?? "GET";
      const headers = options.headers ?? {};
      const body = options.body;
      const signal = options.signal;

      if (signal?.aborted) {
        reject(signal.reason ?? new Error("AbortError"));
        return;
      }

      const reqOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers,
      };

      const client = targetUrl.protocol === "https:" ? https : http;
      const req = client.request(reqOptions, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          const normalizedHeaders = {};
          for (const [key, value] of Object.entries(res.headers)) {
            normalizedHeaders[key.toLowerCase()] = Array.isArray(value)
              ? value.join(", ")
              : value ?? "";
          }
          resolve(new PolyfillResponse(res.statusCode ?? 0, normalizedHeaders, bodyBuffer));
        });
      });

      req.on("error", reject);

      if (signal) {
        const onAbort = () => {
          req.destroy(signal.reason ?? new Error("AbortError"));
          reject(signal.reason ?? new Error("AbortError"));
        };
        signal.addEventListener("abort", onAbort);
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }

      if (body !== undefined && body !== null) {
        req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : String(body));
      }

      req.end();
    });
  };
}

const entry = process.argv[2] === "swarm" ? "../src/index.ts" : "../src/telegram/bot.ts";
require(path.resolve(__dirname, entry));
