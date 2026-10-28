import { parseArgs } from "jsr:@std/cli/parse-args";
import { searcherClient } from "npm:jito-ts@4/dist/sdk/block-engine/searcher.js";
import { Bundle } from "npm:jito-ts@4/dist/sdk/block-engine/types.js";
import { Connection, Keypair, PublicKey } from "npm:@solana/web3.js";

const TIP_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
const LAMPORTS = 1e9;
const BLOCK_ENGINE = Deno.env.get("BLOCK_ENGINE_URL") ?? "mainnet.block-engine.jito.wtf";
const RPC_URL = Deno.env.get("RPC_URL") ?? "https://api.mainnet-beta.solana.com";

interface TipFloor {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

const args = parseArgs(Deno.args, { string: ["pct"], default: { send: 0, wait: 20 } });

const res = await fetch(TIP_URL);
if (!res.ok) throw new Error(`tip floor request failed (${res.status})`);
const [tip]: TipFloor[] = await res.json();

const levels: Record<number, number> = {
  25: tip.landed_tips_25th_percentile,
  50: tip.landed_tips_50th_percentile,
  75: tip.landed_tips_75th_percentile,
  95: tip.landed_tips_95th_percentile,
  99: tip.landed_tips_99th_percentile,
};

const pct = Number(args.pct ?? 50);
const sol = levels[pct];
if (sol === undefined) {
  throw new Error(`--pct must be one of ${Object.keys(levels).join(", ")}`);
}
const lamports = Math.ceil(sol * LAMPORTS);

if (args.pct === undefined && !Number(args.send)) {
  const priceUrl = Deno.env.get("PRICE_URL");
  let usd: number | undefined;
  if (priceUrl) usd = (await (await fetch(priceUrl)).json()).solana.usd;

  const row = (label: string, s: number) => ({
    percentile: label,
    SOL: s,
    lamports: Math.ceil(s * LAMPORTS),
    ...(usd === undefined ? {} : { USD: +(s * usd).toFixed(4) }),
  });

  console.log(`tip_floor @ ${tip.time}`);
  console.table([
    ...Object.entries(levels).map(([p, s]) => row(`${p}th`, s)),
    row("ema 50th", tip.ema_landed_tips_50th_percentile),
  ]);
} else {
  console.log(`tip_floor @ ${tip.time}: ${pct}th = ${lamports} lamports`);
}

if (Number(args.send) > 0) {
  const auth = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await Deno.readTextFile(Deno.env.get("AUTH_KEYPAIR")!))),
  );
  const client = searcherClient(BLOCK_ENGINE, auth);
  const tipRes = await client.getTipAccounts();
  if (!tipRes.ok) throw tipRes.error;
  const tipAccounts: string[] = tipRes.value;
  const { blockhash } = await new Connection(RPC_URL).getLatestBlockhash();

  const seen = new Set<string>();
  client.onBundleResult(
    (r: { bundleId: string; processed?: unknown; finalized?: unknown }) => {
      if (r.processed || r.finalized) seen.add(r.bundleId);
    },
    (e: Error) => console.error("bundle stream:", e.message),
  );

  const sent: string[] = [];
  for (let i = 0; i < Number(args.send); i++) {
    const bundle = new Bundle([], 5).addTipTx(
      auth,
      lamports,
      new PublicKey(tipAccounts[i % tipAccounts.length]),
      blockhash,
    );
    if (bundle instanceof Error) throw bundle;
    const sentRes = await client.sendBundle(bundle);
    if (!sentRes.ok) throw sentRes.error;
    sent.push(sentRes.value);
  }
  console.log(`sent ${sent.length} bundle(s), waiting ${args.wait}s`);

  await new Promise((done) => setTimeout(done, Number(args.wait) * 1000));
  const landed = sent.filter((id) => seen.has(id)).length;
  console.table([{
    landed,
    sent: sent.length,
    rate: `${((100 * landed) / sent.length).toFixed(1)}%`,
  }]);
  Deno.exit(0);
}
