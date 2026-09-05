/**
 * Explicit Keeper tool registry.
 *
 * A registry is deliberately required for every callable operation.  There is
 * no fallback command, shell, filesystem, package-discovery, or arbitrary URL
 * tool.  Photo-specific tools can be registered by the tools module without
 * coupling the agent loop to Immich internals.
 */

const FORBIDDEN = /^(?:shell|exec|command|filesystem|file|fs|glob|discover|discovery|readdir|read_file|write_file|run_command)(?:[._:-]|$)/i;
const NAME = /^[a-z][a-z0-9_.:-]{0,79}$/i;

function cleanSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  // Tool schemas are sent to a model and must not contain executable values.
  const result = JSON.parse(JSON.stringify(schema));
  result.type = "object";
  if (!result.properties || typeof result.properties !== "object" || Array.isArray(result.properties)) result.properties = {};
  return result;
}

export class ToolRegistry {
  #tools = new Map();

  constructor(definitions = []) {
    this.registerMany(definitions);
  }

  register(definition, execute) {
    const item = typeof definition === "string" ? { name: definition, execute } : definition;
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !NAME.test(item.name) || FORBIDDEN.test(item.name)) {
      throw new TypeError("Keeper tools must use an explicit safe name");
    }
    if (typeof item.execute !== "function") throw new TypeError(`Tool ${item.name} has no executor`);
    if (this.#tools.has(item.name)) throw new Error(`Keeper tool already registered: ${item.name}`);
    const name = item.name;
    const tool = {
      name,
      description: typeof item.description === "string" ? item.description.slice(0, 2_000) : "",
      parameters: cleanSchema(item.parameters || item.inputSchema),
      execute: item.execute,
      mutating: item.mutating === true,
    };
    this.#tools.set(name, tool);
    return this;
  }

  registerMany(definitions) {
    if (!definitions) return this;
    if (definitions instanceof Map) {
      for (const [name, execute] of definitions) this.register(name, execute);
      return this;
    }
    if (Array.isArray(definitions)) {
      for (const definition of definitions) this.register(definition);
      return this;
    }
    for (const [name, execute] of Object.entries(definitions)) this.register(name, execute);
    return this;
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    return this.#tools.get(name);
  }

  list() {
    return [...this.#tools.values()].map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  async execute(name, args, context) {
    const tool = this.#tools.get(name);
    if (!tool) {
      const error = Error(`Keeper tool is not registered: ${name}`);
      error.tool = name;
      error.invalidTool = true;
      throw error;
    }
    if (!context?.owner?.id || !context?.run?.id) throw Error("Keeper tool context is not owner-scoped");
    const input = typeof args === "string" ? JSON.parse(args) : args;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Keeper tool arguments must be an object");
    return tool.execute(input, context);
  }
}

export function createToolRegistry(definitions) {
  return new ToolRegistry(definitions);
}
