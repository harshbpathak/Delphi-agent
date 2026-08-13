import { delphiClient } from './delphiClient';
/**
 * Calculates how much it will cost to buy a certain number of shares.
 *
 * @param marketAddress The address of the market proxy
 * @param outcomeIdx The outcome index (usually 0 for YES, 1 for NO)
 * @param sharesOut BigInt of shares we want to receive (in 18 decimals)
 * @returns The expected tokens required (in 6 decimals for USDC usually, or 18 for competition token)
 */
export async function getSlippageQuote(marketAddress, outcomeIdx, sharesOut) {
    try {
        const { tokensIn } = await delphiClient.quoteBuy({
            marketAddress,
            outcomeIdx,
            sharesOut,
        });
        return tokensIn;
    }
    catch (error) {
        console.error(`Quote failed for market ${marketAddress}:`, error);
        return null;
    }
}
