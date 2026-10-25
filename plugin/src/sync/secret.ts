/** 32 random bytes as 64 lower-case hex digits: the plugin's credential for the editor's approve-on-connect (protocol 4). */
export function newSecret(getRandomValues: (a: Uint8Array) => Uint8Array): string {
  return Array.from(getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const isSecret = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
