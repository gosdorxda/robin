import { loadEnvConfig } from "@next/env";
import { promises as dns } from "node:dns";
import net from "node:net";
import tls from "node:tls";

/**
 * Outbound-network diagnostic for the production VPS.
 *
 * Run with:  npm run net:test
 *
 * `fetch failed` from the app is useless on its own: DNS failure, a blocked
 * egress port, a broken IPv6 route and SNI-based filtering (Trust+/ISP DNS
 * blocking) all look the same from inside Next. This script probes each layer
 * separately for the hosts the app actually talks to:
 *
 *   dns → tcp4 / tcp6 → TLS with the real SNI → TLS with another SNI → HTTPS status
 *
 * The comparison is what matters: pumpdev failing while the control host works
 * means "this destination is blocked", not "this server has no internet".
 */

const CONNECT_TIMEOUT_MS = 8_000;
const HTTP_TIMEOUT_MS = 15_000;

interface Probe {
  ok: boolean;
  ms: number;
  detail: string;
}

function errCode(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return err?.code ?? err?.message ?? "error";
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function tcpProbe(host: string, family?: 4 | 6, port = 443): Promise<Probe> {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    const sock = net.connect({ host, port, family });
    const done = (r: Probe) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(CONNECT_TIMEOUT_MS, () =>
      done({ ok: false, ms: elapsed(start), detail: "ETIMEDOUT (local)" })
    );
    sock.once("connect", () => done({ ok: true, ms: elapsed(start), detail: "connected" }));
    sock.once("error", (e) => done({ ok: false, ms: elapsed(start), detail: errCode(e) }));
  });
}

function tlsProbe(ip: string, servername: string): Promise<Probe> {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    const sock = tls.connect({ host: ip, port: 443, servername, rejectUnauthorized: true });
    const done = (r: Probe) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(CONNECT_TIMEOUT_MS, () =>
      done({ ok: false, ms: elapsed(start), detail: "handshake timeout" })
    );
    sock.once("secureConnect", () => {
      const cn = sock.getPeerCertificate()?.subject?.CN;
      done({
        ok: true,
        ms: elapsed(start),
        detail: `${sock.getProtocol() ?? "tls"} · cert ${typeof cn === "string" ? cn : "?"}`,
      });
    });
    sock.once("error", (e) => done({ ok: false, ms: elapsed(start), detail: errCode(e) }));
  });
}

async function httpProbe(url: string): Promise<Probe> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: "manual",
    });
    return { ok: true, ms: elapsed(start), detail: `HTTP ${res.status}` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const detail = [err?.message ?? "fetch failed", err?.cause?.code, err?.cause?.message]
      .filter(Boolean)
      .join(" — ");
    return { ok: false, ms: elapsed(start), detail };
  }
}

function line(step: string, p: Probe): string {
  return `  ${p.ok ? "OK  " : "FAIL"} ${step.padEnd(30)} ${String(p.ms).padStart(6)}ms  ${p.detail}`;
}

interface TargetResult {
  host: string;
  dns: { v4: string[]; v6: string[]; error?: string };
  tcp4?: Probe;
  tcp6?: Probe;
  tls?: Probe;
  tlsAltSni?: Probe;
  http?: Probe;
  isTarget: boolean;
}

async function probeTarget(host: string, url: string, isTarget: boolean): Promise<TargetResult> {
  const out: TargetResult = { host, dns: { v4: [], v6: [] }, isTarget };

  try {
    out.dns.v4 = await dns.resolve4(host);
  } catch (e) {
    out.dns.error = `A: ${errCode(e)}`;
  }
  try {
    out.dns.v6 = await dns.resolve6(host);
  } catch {
    // No AAAA record is normal — not worth a second error line.
  }

  console.log(`\n${isTarget ? "TARGET " : "CONTROL"}  ${host}`);
  console.log(
    `  dns                            A=[${out.dns.v4.join(", ") || "-"}] AAAA=[${out.dns.v6.join(", ") || "-"}]`
  );
  if (out.dns.error) console.log(`  dns error                      ${out.dns.error}`);

  if (out.dns.v4[0]) {
    out.tcp4 = await tcpProbe(out.dns.v4[0], 4);
    console.log(line("tcp4 → :443", out.tcp4));
  }
  if (out.dns.v6[0]) {
    out.tcp6 = await tcpProbe(out.dns.v6[0], 6);
    console.log(line("tcp6 → :443", out.tcp6));
  }

  if (out.dns.v4[0] && out.tcp4?.ok) {
    out.tls = await tlsProbe(out.dns.v4[0], host);
    console.log(line(`tls sni=${host}`, out.tls));

    // A handshake that only works with a different SNI means the *name* is being
    // filtered (Trust+/ISP blocking), not the port.
    if (!out.tls?.ok) {
      out.tlsAltSni = await tlsProbe(out.dns.v4[0], "example.com");
      console.log(line("tls sni=example.com", out.tlsAltSni));
    }
  }

  out.http = await httpProbe(url);
  console.log(line("https request", out.http));

  return out;
}

function verdict(results: TargetResult[]): string[] {
  const target = results.find((r) => r.isTarget);
  const control = results.find((r) => !r.isTarget);
  const notes: string[] = [];
  if (!target) return ["no target probed"];

  const controlOk = Boolean(control?.tcp4?.ok);
  const targetOk = Boolean(target.tcp4?.ok);

  if (!target.dns.v4.length) {
    notes.push(
      `DNS gagal untuk ${target.host} (${target.dns.error ?? "tidak ada A record"}). Perbaiki resolver di server — app tidak akan pernah connect.`
    );
    return notes;
  }
  if (!targetOk && controlOk) {
    notes.push(
      `TCP ke ${target.host}:443 gagal padahal ${control?.host} jalan → tujuan ini diblok di jalur keluar (firewall provider, Trust+/penyaringan nama domain, atau Cloudflare menolak IP datacenter). Bukan bug app.`
    );
  }
  if (!targetOk && !controlOk) {
    notes.push(
      "TCP keluar gagal untuk semua host → server tidak punya egress 443 (firewall provider / ufw outgoing / rute)."
    );
    return notes;
  }
  if (targetOk && target.tls && !target.tls.ok && target.tlsAltSni?.ok) {
    notes.push(
      `TCP & TLS ke IP ${target.host} bisa, tapi handshake dengan SNI "${target.host}" gagal → penyaringan berbasis nama domain (Trust+/ISP), bukan port.`
    );
  } else if (targetOk && target.tls && !target.tls.ok) {
    notes.push(
      `TCP nyambung tapi TLS gagal (${target.tls.detail}) → sertifikat, jam server, atau MTU. Cek "timedatectl" dan "ca-certificates".`
    );
  } else if (targetOk && target.tls?.ok && target.http && !target.http.ok) {
    notes.push(`TLS OK tapi request HTTPS gagal (${target.http.detail}).`);
  } else if (targetOk && target.http?.ok) {
    notes.push(
      `Jalur ke ${target.host} sehat dari mesin ini (${target.http.detail}) — kalau app masih "fetch failed", restart service dan pastikan proses memakai env yang sama.`
    );
  }
  if (target.tcp6 && !target.tcp6.ok && target.tcp4?.ok) {
    notes.push(
      "IPv6 tidak bisa connect (normal di banyak VPS). Kalau app memilih IPv6 lebih dulu, set NODE_OPTIONS=--dns-result-order=ipv4first."
    );
  }
  return notes;
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  const pumpBase = process.env.PUMPFUN_API_BASE?.trim() || "https://pumpdev.io";
  const pumpHost = new URL(pumpBase).hostname;
  const rpcHost = process.env.SOLANA_RPC_URL ? new URL(process.env.SOLANA_RPC_URL).hostname : null;
  const controlHost = process.env.NET_TEST_CONTROL?.trim() || "github.com";

  console.log("=== Outbound network diagnostic ===");
  console.log(`node         : ${process.version}`);
  console.log(`server time  : ${new Date().toISOString()}`);
  console.log(`pumpdev base : ${pumpBase}`);
  console.log(`rpc host     : ${rpcHost ?? "(SOLANA_RPC_URL kosong)"}`);
  console.log(`control host : ${controlHost}`);

  const results: TargetResult[] = [];
  results.push(
    await probeTarget(
      pumpHost,
      `${pumpBase.replace(/\/+$/, "")}/api/claim-account?publicKey=x&mint=y`,
      true
    )
  );
  if (rpcHost) results.push(await probeTarget(rpcHost, `https://${rpcHost}/`, false));
  results.push(await probeTarget(controlHost, `https://${controlHost}/`, false));

  console.log("\n=== Verdict ===");
  for (const n of verdict(results)) console.log(`- ${n}`);
}

main().catch((e) => {
  console.error("FAIL:", (e as Error).message);
  process.exit(1);
});
