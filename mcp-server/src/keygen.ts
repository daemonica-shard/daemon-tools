import { randomBytes } from "node:crypto";
import { sha256 } from "./auth.js";

// Generates an API key. Give the token to the caller; put only the hash in tenants.yaml.
const token = `dmt_${randomBytes(32).toString("base64url")}`;
console.log(`token (give to caller, shown once):  ${token}`);
console.log(`hash  (put in tenants.yaml):         ${sha256(token)}`);
