import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function progress(args, message) {
  if (args.json) return;
  process.stderr.write(c.dim("· " + message + "\n"));
}

export function printTable(rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const width = Object.fromEntries(columns.map((key) => [key, Math.max(...rows.map((row) => String(row[key]).length), key.length)]));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(width[columns[index]])).join("  ");
  process.stdout.write(c.bold(line(columns)) + "\n");
  for (const row of rows) process.stdout.write(line(columns.map((key) => row[key])) + "\n");
}

export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function writeReceipt(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
}

export function updateReceipt(file, record) {
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
}

export async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer, { flag: "wx" });
  return buffer.length;
}
