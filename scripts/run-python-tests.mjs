#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const python = process.env.PYTHON?.trim() || "python3";
const result = spawnSync(python, [
  "-m",
  "unittest",
  "discover",
  "-s",
  "tests/python",
  "-p",
  "test_*.py",
], { cwd: root, stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
