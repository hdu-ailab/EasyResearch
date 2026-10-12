/** Host-owned location/category only: never expose a parser's input excerpt. */
export class ConfigurationSourceError extends Error {
  constructor(readonly path: string, readonly category: "read" | "validation" | "monitoring") {
    super(`Configuration ${category} failed at ${path}.`);
    this.name = "ConfigurationSourceError";
  }
}
