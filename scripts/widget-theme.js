const fs = require("node:fs");

// Use the page's palette as the source of truth for the native app as well.
const css = fs.readFileSync("public/styles.css", "utf8");
const root = css.match(/:root\s*\{([^}]+)\}/)?.[1];
if (!root) throw new Error("Meterboard stylesheet has no :root palette");
const names = {
  paper: "paper", card: "paper-card", raised: "paper-raised", ink: "ink",
  soft: "ink-soft", faint: "ink-faint", rule: "rule", track: "track",
  cyan: "cyan", green: "green", amber: "amber", brown: "brown", red: "red",
  shadow: "hard-shadow",
};
const properties = Object.entries(names).map(([name, variable]) => {
  const hex = root.match(new RegExp(`--${variable}:\\s*#([\\da-f]{6})\\s*;`, "i"))?.[1];
  if (!hex) throw new Error(`Expected a six-digit color for --${variable}`);
  const channels = [0, 2, 4].map(offset => `${parseInt(hex.slice(offset, offset + 2), 16)}.0 / 255`);
  return `    static let ${name} = Color(red: ${channels[0]}, green: ${channels[1]}, blue: ${channels[2]})`;
});
fs.mkdirSync(".build/widget", { recursive: true });
fs.writeFileSync(".build/widget/MeterPalette.swift", `// Generated from public/styles.css. Do not edit.\nimport SwiftUI\n\nenum MeterPalette {\n${properties.join("\n")}\n}\n`);
