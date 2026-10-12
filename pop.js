import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import fs from "fs";

const blockEngineUrl =
  process.env.BLOCK_ENGINE_URL || "mainnet.block-engine.jito.wtf";
const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || "./keypair.json";
const tip = parseInt(process.env.TIP_AMOUNT_LAMPORTS || "100000", 10);
const resultWaitMs = parseInt(process.env.RESULT_WAIT_MS || "10000", 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadAuthKeypair = () => {
  const keypairData = JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"));
  return Keypair.fromSecretKey(Buffer.from(keypairData));
};

const main = async () => {
  try {
    const authKeypair = loadAuthKeypair();
    const rpcConnection = new Connection(rpcUrl, "confirmed");
    const client = searcherClient(blockEngineUrl, authKeypair);

    console.log("Connected to block engine:", blockEngineUrl);
    console.log("RPC endpoint:", rpcUrl);

    const tipAccountsResult = await client.getTipAccounts();
    if (!tipAccountsResult.ok) {
      throw new Error(
        `Failed to fetch tip accounts: ${tipAccountsResult.error.message}`,
      );
    }
    const tipAccount = new PublicKey(tipAccountsResult.value[0]);
    console.log("tip account:", tipAccount.toBase58());

    const cancelBundleResultSubscription = client.onBundleResult(
      (bundleResult) => console.log("result for", bundleResult.bundleId, bundleResult),
      (error) => console.error("result stream:", error),
    );

    const { blockhash } = await rpcConnection.getLatestBlockhash();
    const jitoBundle = new Bundle([], 1);
    jitoBundle.addTipTx(authKeypair, tip, tipAccount, blockhash);

    const submitResult = await client.sendBundle(jitoBundle);
    if (!submitResult.ok) {
      console.error("Bundle submission failed:", submitResult.error);
      process.exit(1);
    }
    console.log("submitted", submitResult.value);

    console.log(`waiting ${resultWaitMs}ms for bundle results`);
    await sleep(resultWaitMs);

    cancelBundleResultSubscription();
    process.exit(0);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
};

main();
