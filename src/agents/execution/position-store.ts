import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Position } from "../../shared/types";

const DATA_DIR = join(__dirname, "..", "..", "..", "data");
const FILE_PATH = join(DATA_DIR, "positions.json");

const positions = new Map<string, Position>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  const arr = Array.from(positions.values());
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(arr, null, 2), "utf-8");
  } catch (err) {
    console.error(`[position-store] flush failed: ${(err as Error).message}`);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 500);
}

export function loadPositions(): void {
  try {
    const raw = readFileSync(FILE_PATH, "utf-8");
    const arr = JSON.parse(raw) as Position[];
    for (const p of arr) {
      positions.set(p.positionId, p);
    }
    console.log(`[position-store] loaded ${arr.length} positions from disk`);
  } catch {
    console.log("[position-store] no existing positions file, starting fresh");
  }
}

export function getPosition(id: string): Position | undefined {
  return positions.get(id);
}

export function setPosition(id: string, pos: Position): void {
  positions.set(id, pos);
  scheduleFlush();
}

export function deletePosition(id: string): boolean {
  const deleted = positions.delete(id);
  if (deleted) scheduleFlush();
  return deleted;
}

export function getAllPositions(): Position[] {
  return Array.from(positions.values());
}

export function getPositionsByUser(userId: string): Position[] {
  return Array.from(positions.values()).filter((p) => p.userId === userId);
}

export function hasPosition(id: string): boolean {
  return positions.has(id);
}
