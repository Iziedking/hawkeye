import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Position } from "../../shared/types";

const DATA_DIR = resolve(process.cwd(), "data");
const FILE_PATH = resolve(DATA_DIR, "positions.json");

const positions = new Map<string, Position>();

function flush(): void {
  const arr = Array.from(positions.values());
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(arr, null, 2), "utf-8");
  } catch (err) {
    console.error(`[position-store] flush failed: ${(err as Error).message}`);
  }
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
  flush();
}

export function deletePosition(id: string): boolean {
  const deleted = positions.delete(id);
  if (deleted) flush();
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
