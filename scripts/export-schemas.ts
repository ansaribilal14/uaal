/**
 * Exports the machine-readable JSON schemas (spec §40) into /schemas.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { exportJsonSchemas } from "../src/core/schemas.js";
import { capabilityRegistry } from "../src/core/capabilities.js";

const out = {
  ...exportJsonSchemas(),
  capabilities: capabilityRegistry()
};

mkdirSync(new URL("../schemas/", import.meta.url), { recursive: true });
writeFileSync(new URL("../schemas/uaal.schema.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log("schemas exported: schemas/uaal.schema.json");
