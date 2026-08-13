import { delphiClient } from './delphiClient';
export async function executeTrade(marketAddress, outcomeIdx, sharesOut, expectedTokensIn) {
    try {
        console.log(`Ensuring token approval for ${expectedTokensIn.toString()} tokens...`);
        // 1. Ensure token approval
        await delphiClient.ensureTokenApproval({
            marketAddress,
            minimumAmount: expectedTokensIn,
        });
        // 2. Buy Shares
        // We add a 1% slippage tolerance
        const maxTokensIn = expectedTokensIn * 101n / 100n;
        console.log(`Buying ${sharesOut.toString()} shares...`);
        const { transactionHash } = await delphiClient.buyShares({
            marketAddress,
            outcomeIdx,
            sharesOut,
            maxTokensIn,
        });
        console.log(`Trade successful! Tx Hash: ${transactionHash}`);
        return transactionHash;
    }
    catch (error) {
        console.error("Trade execution failed:", error);
        return null;
    }
}
