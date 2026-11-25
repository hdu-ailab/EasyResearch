/** Host-owned location/category only: never expose a parser's input excerpt. */
export class ConfigurationSourceError extends Error {
  constructor(readonly path: string, readonly category: "read" | "validation" | "monitoring") {
    super(`Configuration ${category} failed at ${path}.`);
    this.name = "ConfigurationSourceError";
  }
}

/** A previously observed source changed during a read; no partial snapshot is valid. */
export class ConfigurationSourceChangedError extends ConfigurationSourceError {
  constructor(path: string) {
    super(path, "read");
    this.name = "ConfigurationSourceChangedError";
    this.message = `Configuration source changed while reading ${path}.`;
  }
}
