import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import * as dotenv from 'dotenv';

dotenv.config();

// The SDK automatically reads DELPHI_NETWORK, DELPHI_SIGNER_TYPE, WALLET_PRIVATE_KEY, etc.
// from the environment variables.
export const delphiClient = new DelphiClient();
