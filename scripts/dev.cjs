#!/usr/bin/env node

const fs = require("node:fs");
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

const entry = process.argv[2] === "swarm" ? "../src/index.ts" : "../src/telegram/bot.ts";
require(path.resolve(__dirname, entry));
