const SELECTOR_APPROVE = "095ea7b3";
const SELECTOR_EXECUTE = "3593564c";

export function getFunctionSelector(data: string): string {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  return hex.slice(0, 8).toLowerCase();
}

function readWord(params: string, byteOffset: number): string {
  const hexOffset = byteOffset * 2;
  return params.slice(hexOffset, hexOffset + 64);
}

function readUint(params: string, byteOffset: number): number {
  const w = readWord(params, byteOffset);
  if (w.length < 64) return 0;
  return Number(BigInt("0x" + w));
}

function readBigUint(params: string, byteOffset: number): string {
  const w = readWord(params, byteOffset);
  if (w === "0".repeat(64)) return "0";
  return BigInt("0x" + w).toString();
}

function readAddress(params: string, byteOffset: number): string {
  const word = readWord(params, byteOffset);
  return "0x" + word.slice(24);
}

export type DecodedApprove = {
  functionName: "approve";
  args: [string, string];
};

export function decodeApprove(data: string): DecodedApprove | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.slice(0, 8).toLowerCase() !== SELECTOR_APPROVE) return null;
  const params = hex.slice(8);
  if (params.length < 128) return null;

  const spender = readAddress(params, 0);
  const amount = readBigUint(params, 32);

  return { functionName: "approve", args: [spender, amount] };
}

export type DecodedExecute = {
  functionName: "execute";
  args: [string, string[], string];
};

export function decodeUniversalRouterExecute(data: string): DecodedExecute | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.slice(0, 8).toLowerCase() !== SELECTOR_EXECUTE) return null;
  const params = hex.slice(8);
  if (params.length < 192) return null;

  const commandsOffset = readUint(params, 0);
  const inputsOffset = readUint(params, 32);
  const deadline = readBigUint(params, 64);

  const commandsLen = readUint(params, commandsOffset);
  const commandsStart = (commandsOffset + 32) * 2;
  const commands = "0x" + params.slice(commandsStart, commandsStart + commandsLen * 2);

  const arrayLen = readUint(params, inputsOffset);
  const inputs: string[] = [];
  const arrayDataStart = inputsOffset + 32;

  for (let i = 0; i < arrayLen; i++) {
    const elementOffset = readUint(params, arrayDataStart + i * 32);
    const elementAbsolutePos = arrayDataStart + elementOffset;
    const elementLen = readUint(params, elementAbsolutePos);
    const elementStart = (elementAbsolutePos + 32) * 2;
    inputs.push("0x" + params.slice(elementStart, elementStart + elementLen * 2));
  }

  return { functionName: "execute", args: [commands, inputs, deadline] };
}

export const UNIVERSAL_ROUTER_EXECUTE_ABI = JSON.stringify([{
  inputs: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "deadline", type: "uint256" },
  ],
  name: "execute",
  outputs: [],
  stateMutability: "payable",
  type: "function",
}]);

export const ERC20_APPROVE_ABI = JSON.stringify([{
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  name: "approve",
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
  type: "function",
}]);
