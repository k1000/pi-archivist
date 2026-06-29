#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { convertOkfToArchivist, parseOkfJson, validateOkfArtifact } from "../lib/okf";

function usage(): never {
  console.error("Usage: bun scripts/okf-convert.ts <validate|to-md|to-catalog-json> <okf.json> [--path <catalog-path>]");
  process.exit(2);
}

const [command, file, ...rest] = process.argv.slice(2);
if (!command || !file) usage();

const pathFlagIndex = rest.indexOf("--path");
const catalogPath = pathFlagIndex >= 0 ? rest[pathFlagIndex + 1] : undefined;
const raw = readFileSync(file, "utf8");
const artifact = parseOkfJson(raw);

if (command === "validate") {
  const errors = validateOkfArtifact(artifact);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("OKF artifact is valid for Archivist conversion");
} else if (command === "to-md") {
  process.stdout.write(convertOkfToArchivist(artifact, { path: catalogPath }).markdown + "\n");
} else if (command === "to-catalog-json") {
  process.stdout.write(JSON.stringify(convertOkfToArchivist(artifact, { path: catalogPath }).catalogRow, null, 2) + "\n");
} else {
  usage();
}
