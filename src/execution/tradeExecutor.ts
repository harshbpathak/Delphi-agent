import { delphiClient } from './delphiClient.js';

/**
 * Executes a buy. `maxTokensIn` must already include the caller's full
 * slippage tolerance — no additional buffer is added here, so the slippage
 * cap checked upstream is the slippage cap actually enforced on-chain.
 */
export async function executeTrade(
    marketAddress: `0x${string}`,
    outcomeIdx: number,
    sharesOut: bigint,
    maxTokensIn: bigint
) {
    try {
        await delphiClient.ensureTokenApproval({
            marketAddress,
            minimumAmount: maxTokensIn,
        });

        console.log(`Buying ${sharesOut.toString()} shares (max spend ${maxTokensIn.toString()})...`);
        const { transactionHash } = await delphiClient.buyShares({
            marketAddress,
            outcomeIdx,
            sharesOut,
            maxTokensIn,
        });

        console.log(`Trade successful! Tx Hash: ${transactionHash}`);
        return transactionHash;
    } catch (error) {
        console.error("Trade execution failed:", error);
        return null;
    }
}
