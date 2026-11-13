// A reader for ActionScript 2 bytecode that finds call sites: `obj.method(args)` and `func(args)` with their object path and the arguments it can know
// (strings, numbers, member paths such as `this.track`). It follows the operand stack symbolically; it does not run the code.
// shortcut: no control flow (a branch is read straight through), no arithmetic beyond + - * | &; enough for `x.Lock("TL")` and `addElement(this.y, 12)`.
import { Reader } from "./read.js";

export type Val = { k: "s"; v: string } | { k: "n"; v: number } | { k: "p"; v: string } | { k: "u" };
export type Call = { obj: string; method: string; args: Val[] };
const U: Val = { k: "u" };
const EDGE: Record<string, number> = { LEFT: 1, RIGHT: 2, TOP: 4, BOTTOM: 8, ALL: 15 }; // gfx.utils.Constraints
const path = (v: string): Val => ({ k: "p", v });
// operand stack effects of the actions that are not handled one by one: [pops, pushes an unknown value]
const UNARY = new Set([0x12, 0x14, 0x18, 0x31, 0x32, 0x33, 0x44, 0x4a, 0x4b, 0x50, 0x51, 0x1e, 0x2a, 0x3a]);
const BINARY = new Set([0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x21, 0x29, 0x3f, 0x47, 0x48, 0x49, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x45, 0x2b, 0x54]);

function double(b: Uint8Array): number {
  // AVM1 stores a double as its two 32-bit halves swapped
  const d = new DataView(new ArrayBuffer(8));
  [4, 5, 6, 7, 0, 1, 2, 3].forEach((s, i) => d.setUint8(i, b[s]));
  return d.getFloat64(0, true);
}

export function scanCalls(code: Uint8Array): Call[] {
  const calls: Call[] = [];
  let pool: string[] = [];

  const run = (r: Reader, end: number, regs: Val[]): void => {
    const st: Val[] = [];
    const pop = (): Val => st.pop() ?? U;
    const num = (v: Val): number => (v.k === "n" ? v.v : 0);
    while (r.p < end) {
      const op = r.u8();
      if (op === 0) return;
      const len = op >= 0x80 ? r.u16() : 0, next = r.p + len;
      if (op === 0x96) { // Push
        while (r.p < next) {
          const t = r.u8();
          if (t === 0) st.push({ k: "s", v: r.str() });
          else if (t === 1) { const d = new DataView(new ArrayBuffer(4)); r.bytes(4).forEach((x, i) => d.setUint8(i, x)); st.push({ k: "n", v: d.getFloat32(0, true) }); }
          else if (t === 2 || t === 3) st.push(U);
          else if (t === 4) st.push(regs[r.u8()] ?? U);
          else if (t === 5) st.push({ k: "n", v: r.u8() });
          else if (t === 6) st.push({ k: "n", v: double(r.bytes(8)) });
          else if (t === 7) st.push({ k: "n", v: r.s32() });
          else if (t === 8 || t === 9) { const s = pool[t === 8 ? r.u8() : r.u16()]; st.push(s === undefined ? U : { k: "s", v: s }); }
          else { r.p = next; break; }
        }
      } else if (op === 0x88) { const n = r.u16(); pool = Array.from({ length: n }, () => r.str()); }
      else if (op === 0x1c) { const n = pop(); st.push(n.k === "s" ? path(n.v) : U); } // GetVariable
      else if (op === 0x4e) { // GetMember
        const n = pop(), o = pop();
        const p = o.k === "p" && (n.k === "s" || n.k === "n") ? `${o.v}.${n.v}` : "";
        const c = /(^|\.)Constraints\.(LEFT|RIGHT|TOP|BOTTOM|ALL)$/.exec(p); // CLIK's edge flags are plain numbers
        st.push(c ? { k: "n", v: EDGE[c[2]] } : p ? path(p) : U);
      } else if (op === 0x4f) { pop(); pop(); pop(); } // SetMember
      else if (op === 0x1d || op === 0x3c) { pop(); pop(); } // SetVariable, DefineLocal
      else if (op === 0x41 || op === 0x17 || op === 0x3e || op === 0x9d || op === 0x20 || op === 0x9f) pop(); // DefineLocal2, Pop, Return, If, SetTarget2, GotoFrame2
      else if (op === 0x87) regs[r.u8()] = st[st.length - 1] ?? U; // StoreRegister
      else if (op === 0x4c) st.push(st[st.length - 1] ?? U); // PushDuplicate
      else if (op === 0x4d) { const a = pop(), b = pop(); st.push(a, b); } // StackSwap
      else if (op === 0x52 || op === 0x3d) { // CallMethod, CallFunction
        const name = pop(), obj = op === 0x52 ? pop() : U, argc = num(pop());
        const args = Array.from({ length: Math.min(argc, 32) }, pop);
        const method = name.k === "s" ? name.v : "";
        calls.push({ obj: obj.k === "p" ? obj.v : "", method, args });
        // `eval("a.b")` is the path a.b
        st.push(op === 0x3d && method === "eval" && args[0]?.k === "s" ? path(args[0].v) : U);
      } else if (op === 0x40) { pop(); const n = num(pop()); for (let i = 0; i < Math.min(n, 32); i++) pop(); st.push(U); } // NewObject
      else if (op === 0x42) { const n = num(pop()); for (let i = 0; i < Math.min(n, 256); i++) pop(); st.push(U); } // InitArray
      else if (op === 0x43) { const n = num(pop()); for (let i = 0; i < Math.min(n, 256) * 2; i++) pop(); st.push(U); } // InitObject
      else if (op === 0x0a || op === 0x0b || op === 0x0c || op === 0x60 || op === 0x61) { // + - * & |
        const b = pop(), a = pop();
        st.push(a.k === "n" && b.k === "n" ? { k: "n", v: op === 0x0a ? a.v + b.v : op === 0x0b ? a.v - b.v : op === 0x0c ? a.v * b.v : op === 0x60 ? a.v & b.v : a.v | b.v } : U);
      } else if (UNARY.has(op)) { pop(); st.push(U); }
      else if (BINARY.has(op)) { pop(); pop(); st.push(U); }
      else if (op === 0x9b || op === 0x8e) { // DefineFunction(2): the body is code too; it has its own stack and registers
        const name = r.str(), n = r.u16(), fregs: Val[] = [];
        if (op === 0x8e) {
          r.u8();
          const f = r.u16();
          let reg = 1;
          if (f & 1) fregs[reg++] = path("this");
          if (f & 4) reg++; // arguments
          if (f & 16) reg++; // super
          if (f & 64) fregs[reg++] = path("_root");
          if (f & 128) fregs[reg++] = path("_parent");
          if (f & 256) fregs[reg++] = path("_global");
        }
        for (let i = 0; i < n; i++) { if (op === 0x8e) r.u8(); r.str(); } // DefineFunction2 parameter: register, then name
        const size = r.u16(), body = r.p;
        run(new Reader(r.b, body, Math.min(body + size, r.end)), body + size, fregs);
        r.p = body + size;
        if (!name) st.push(U);
        continue;
      }
      r.p = next;
    }
  };

  try { run(new Reader(code), code.length, []); } catch { /* a damaged or unfamiliar action stops the scan; the calls found so far stay */ }
  return calls;
}
