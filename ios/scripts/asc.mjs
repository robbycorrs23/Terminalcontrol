#!/usr/bin/env node
// Minimal App Store Connect API client, no dependencies.
//   node scripts/asc.mjs GET /v1/apps
//   node scripts/asc.mjs POST /v1/bundleIds '{"data":{...}}'
// Key: ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (same key the
// other projects' TestFlight scripts use). Never prints the key.
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { homedir } from "node:os";

const KEY_ID = process.env.ASC_KEY_ID || "63H63G924B";
const ISSUER = process.env.ASC_ISSUER_ID || "e26181bd-b05f-4e5a-a43c-d20bd728bc26";
const key = createPrivateKey(readFileSync(`${homedir()}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`, "utf8"));

export function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" })}.${b64({ iss: ISSUER, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export async function call(method, path, body) {
  const res = await fetch("https://api.appstoreconnect.apple.com" + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [method, path, body] = process.argv.slice(2);
  const r = await call(method, path, body ? JSON.parse(body) : undefined);
  console.log(r.status);
  console.log(typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2));
}
