import Link from "next/link";
import { deploymentRegistry } from "@/lib/contracts/manifests";

export default function TestnetHelp() {
  const manifest = deploymentRegistry[84532]!;
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-5 py-12 text-ink">
      <h1 className="display text-4xl">Try Sowmorrow on Base Sepolia</h1>
      <p>These test stocks and test ETH have no real value. Use a separate test wallet.</p>
      <ol className="list-decimal space-y-4 pl-5">
        <li>Connect MetaMask or Coinbase Wallet and switch to Base Sepolia (chain ID 84532).</li>
        <li>
          Get Base Sepolia ETH from the{" "}
          <a
            className="underline"
            href="https://portal.cdp.coinbase.com/products/faucet"
            target="_blank"
            rel="noreferrer"
          >
            Coinbase Developer Platform faucet
          </a>{" "}
          to pay test transaction fees.
        </li>
        <li>
          Open the{" "}
          <a
            className="underline"
            href="https://sepolia.basescan.org/address/0x268e0892f601c13d273525855C4933A9cB33e822#writeContract"
            target="_blank"
            rel="noreferrer"
          >
            Sowmorrow test-stock faucet
          </a>
          . Connect your test wallet and call <code>requestFixture</code> with a stock address below and{" "}
          <code>1000000000000000000</code> for one test token. Requests are limited to once per hour per
          wallet.
        </li>
        <li>
          Return to Sowmorrow, choose that stock, and plant a gift. The recipient must control the address and
          connect that wallet to claim after the opening time.
        </li>
      </ol>
      <p>
        For a short demonstration, use an already-unlocked gift. Newly planted gifts normally open at 09:00 on
        the date you choose, beginning tomorrow.
      </p>
      <details>
        <summary className="cursor-pointer font-bold">Test-stock addresses</summary>
        <ul className="mt-3 space-y-3">
          {manifest.stocks.map((stock) => (
            <li key={stock.address}>
              <strong>{stock.symbol}</strong>
              <code className="block break-all text-xs">{stock.address}</code>
            </li>
          ))}
        </ul>
      </details>
      <Link className="inline-block underline" href="/">
        Back to Sowmorrow
      </Link>
    </main>
  );
}
