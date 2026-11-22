import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function loadTlsConfig() {
  const certPath = path.join(ROOT, "cert.pem");
  const keyPath = path.join(ROOT, "key.pem");

  const hasCert = fs.existsSync(certPath);
  const hasKey = fs.existsSync(keyPath);

  if (!hasCert && !hasKey) {
    return { options: null, status: "missing", message: "cert.pem/key.pem not found; using HTTP/WS" };
  }

  if (!hasCert || !hasKey) {
    return {
      options: null,
      status: "incomplete",
      message: "only one of cert.pem/key.pem exists; using HTTP/WS",
    };
  }

  try {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    const parsed = new X509Certificate(cert);
    const now = Date.now();
    const validFrom = Date.parse(parsed.validFrom);
    const validTo = Date.parse(parsed.validTo);

    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
      return { options: null, status: "invalid", message: "certificate validity could not be parsed; using HTTP/WS" };
    }

    if (now < validFrom) {
      return { options: null, status: "not-yet-valid", message: "certificate is not valid yet; using HTTP/WS" };
    }

    if (now > validTo) {
      return { options: null, status: "expired", message: "certificate has expired; using HTTP/WS" };
    }

    tls.createSecureContext({ cert, key });

    return {
      options: { cert, key },
      status: "ready",
      message: "valid certificate and key loaded; using HTTPS/WSS",
    };
  } catch (error) {
    return {
      options: null,
      status: "invalid",
      message: `certificate/key validation failed (${error.message}); using HTTP/WS`,
    };
  }
}
