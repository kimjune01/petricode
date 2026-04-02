import { render } from "ink";
import React from "react";
import App from "./app/App.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`🧫 petricode

Usage:
  petricode [options]

Options:
  --help, -h    Show this help message
  --version     Show version

Run without arguments to open the TUI.`);
  process.exit(0);
}

if (args.includes("--version")) {
  console.log("petricode 0.1.0");
  process.exit(0);
}

// Workaround for Bun stdin bug with Ink's useInput
process.stdin.resume();

const { waitUntilExit } = render(React.createElement(App));
await waitUntilExit();
