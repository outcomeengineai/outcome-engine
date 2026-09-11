"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var supabase_env_exports = {};
__export(supabase_env_exports, {
  supabaseAnonKey: () => supabaseAnonKey,
  supabaseUrl: () => supabaseUrl
});
module.exports = __toCommonJS(supabase_env_exports);
const REF = /^[a-z0-9]{20}$/;
function clean(v) {
  let s = (v ?? "").trim();
  s = s.replace(/^NEXT_PUBLIC_SUPABASE_(URL|ANON_KEY)\s*=\s*/, "");
  s = s.replace(/^["']|["']$/g, "").trim();
  return s.replace(/\/+$/, "");
}
function supabaseUrl() {
  const raw = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!raw) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (REF.test(raw)) return `https://${raw}.supabase.co`;
  if (/^https?:\/\//.test(raw)) return raw;
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL must be the project URL (https://<ref>.supabase.co) or the bare project ref; got "${raw}"`
  );
}
function supabaseAnonKey() {
  const raw = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!raw) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  return raw;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  supabaseAnonKey,
  supabaseUrl
});
