import { Network as Environment, isEVMChain } from '@certusone/wormhole-sdk';
import { BigNumber, utils } from 'ethers';
import {
  WormholeContext,
  SolanaContext,
  TokenId,
  ChainId,
  ChainName,
  MAINNET_CHAINS,
} from '@wormhole-foundation/wormhole-connect-sdk';

import { getTokenById, getTokenDecimals, getWrappedTokenId } from '../utils';
import { GAS_ESTIMATES, isMainnet, TOKENS, WH_CONFIG } from '../config';
import { postVaa, signAndSendTransaction, TransferWallet } from 'utils/wallet';

export enum PayloadType {
  MANUAL = 1,
  AUTOMATIC = 3,
}

const ENV = isMainnet ? 'MAINNET' : 'TESTNET';
export const wh = new WormholeContext(ENV as Environment, WH_CONFIG);

export interface ParsedMessage {
  sendTx: string;
  sender: string;
  amount: string;
  payloadID: number;
  recipient: string;
  toChain: ChainName;
  fromChain: ChainName;
  tokenAddress: string;
  tokenChain: ChainName;
  tokenId: TokenId;
  tokenKey: string;
  tokenDecimals: number;
  emitterAddress: string;
  sequence: string;
  block: number;
  gasFee?: string;
  payload?: string;
}

export interface ParsedRelayerMessage extends ParsedMessage {
  relayerPayloadId: number;
  to: string;
  relayerFee: string;
  toNativeTokenAmount: string;
}

export const solanaContext = (): SolanaContext<WormholeContext> => {
  return wh.getContext(MAINNET_CHAINS.solana) as SolanaContext<WormholeContext>;
};

export const formatAddress = (chain: ChainName | ChainId, address: string) => {
  const context = wh.getContext(chain);
  return context.formatAddress(address);
};

export const formatAssetAddress = (
  chain: ChainName | ChainId,
  address: string,
) => {
  const context = wh.getContext(chain);
  return context.formatAssetAddress(address);
};

export const parseAddress = (chain: ChainName | ChainId, address: string) => {
  const context = wh.getContext(chain);
  return context.parseAddress(address);
};

export const parseMessageFromTx = async (
  tx: string,
  chain: ChainName | ChainId,
): Promise<ParsedMessage | ParsedRelayerMessage> => {
  const parsed: any = (await wh.parseMessageFromTx(tx, chain))[0];

  const tokenId = {
    address: parsed.tokenAddress,
    chain: parsed.tokenChain,
  };
  const decimals = await wh.fetchTokenDecimals(tokenId, parsed.fromChain);
  const token = getTokenById(tokenId);

  const base: ParsedMessage = {
    ...parsed,
    amount: parsed.amount.toString(),
    tokenKey: token?.key,
    tokenDecimals: decimals,
    sequence: parsed.sequence.toString(),
    gasFee: parsed.gasFee ? parsed.gasFee.toString() : undefined,
  };
  // get wallet address of associated token account for Solana
  const toChainId = wh.toChainId(parsed.toChain);
  if (toChainId === MAINNET_CHAINS.solana) {
    const accountOwner = await solanaContext().getTokenAccountOwner(
      parsed.recipient,
    );
    base.recipient = accountOwner;
  }
  if (parsed.payloadID === PayloadType.MANUAL) {
    return base;
  }
  return {
    ...base,
    relayerFee: parsed.relayerFee.toString(),
    toNativeTokenAmount: parsed.toNativeTokenAmount.toString(),
  };
};

export const getRelayerFee = async (
  sourceChain: ChainName | ChainId,
  destChain: ChainName | ChainId,
  token: string,
) => {
  const context: any = wh.getContext(sourceChain);
  const tokenConfig = TOKENS[token];
  if (!tokenConfig) throw new Error('could not get token config');
  const tokenId = tokenConfig.tokenId || getWrappedTokenId(tokenConfig);
  return await context.getRelayerFee(sourceChain, destChain, tokenId);
};

export const sendTransfer = async (
  token: TokenId | 'native',
  amount: string,
  fromNetwork: ChainName | ChainId,
  fromAddress: string,
  toNetwork: ChainName | ChainId,
  toAddress: string,
  payloadType: PayloadType,
  toNativeToken?: string,
  payload?: any,
): Promise<string> => {
  const fromChainId = wh.toChainId(fromNetwork);
  const fromChainName = wh.toChainName(fromNetwork);
  const decimals = getTokenDecimals(fromChainId, token);
  const parsedAmt = utils.parseUnits(amount, decimals);
  if (payloadType === PayloadType.MANUAL) {
    const tx = await wh.send(
      token,
      parsedAmt.toString(),
      fromNetwork,
      fromAddress,
      toNetwork,
      toAddress,
      undefined,
      payload,
    );
    const txId = await signAndSendTransaction(
      fromChainName,
      tx,
      TransferWallet.SENDING,
    );
    wh.registerProviders();
    return txId;
  } else {
    if (!wh.supportsSendWithRelay(fromChainId)) {
      throw new Error(`send with relay not supported`);
    }
    const parsedNativeAmt = toNativeToken
      ? utils.parseUnits(toNativeToken, decimals).toString()
      : '0';
    const tx = await wh.sendWithRelay(
      token,
      parsedAmt.toString(),
      fromNetwork,
      fromAddress,
      toNetwork,
      toAddress,
      parsedNativeAmt,
    );
    const txId = await signAndSendTransaction(
      fromChainName,
      tx,
      TransferWallet.SENDING,
    );
    wh.registerProviders();
    return txId;
  }
};

export const calculateMaxSwapAmount = async (
  destChain: ChainName | ChainId,
  token: TokenId,
  walletAddress: string,
) => {
  const contracts = wh.getContracts(destChain);
  if (!contracts?.relayer) return;
  const context: any = wh.getContext(destChain);
  return await context.calculateMaxSwapAmount(destChain, token, walletAddress);
};

export const calculateNativeTokenAmt = async (
  destChain: ChainName | ChainId,
  token: TokenId,
  amount: BigNumber,
  walletAddress: string,
) => {
  const context: any = wh.getContext(destChain);
  return await context.calculateNativeTokenAmt(
    destChain,
    token,
    amount,
    walletAddress,
  );
};

export const claimTransfer = async (
  destChain: ChainName | ChainId,
  vaa: Uint8Array,
  payerAddr: string,
): Promise<string> => {
  // post vaa (solana)
  // TODO: move to context
  const destChainId = wh.toChainId(destChain);
  const destChainName = wh.toChainName(destChain);
  if (destChainId === MAINNET_CHAINS.solana) {
    const destContext = wh.getContext(destChain) as any;
    const connection = destContext.connection;
    if (!connection) throw new Error('no connection');
    const contracts = wh.mustGetContracts(destChain);
    if (!contracts.core) throw new Error('contract not found');
    await postVaa(connection, contracts.core, Buffer.from(vaa));
  }

  const gasLimit = GAS_ESTIMATES[destChainName]?.claim || 250000;
  const tx = await wh.redeem(destChain, vaa, { gasLimit }, payerAddr);
  const txId = await signAndSendTransaction(
    destChainName,
    tx,
    TransferWallet.RECEIVING,
  );
  wh.registerProviders();
  return txId;
};

export const fetchTokenDecimals = async (
  tokenId: TokenId,
  chain: ChainName | ChainId,
) => {
  return await wh.fetchTokenDecimals(tokenId, chain);
};

export const getTransferComplete = async (
  destChain: ChainName | ChainId,
  signedVaa: string,
): Promise<boolean> => {
  return await wh.isTransferCompleted(destChain, signedVaa);
};

export const getCurrentBlock = async (
  chain: ChainName | ChainId,
): Promise<number> => {
  const chainId = wh.toChainId(chain);
  const context: any = wh.getContext(chain);
  return context.getCurrentBlock(chainId);
};

export const isAcceptedToken = async (tokenId: TokenId): Promise<boolean> => {
  const context: any = wh.getContext(tokenId.chain);
  const relayer = context.contracts.getTokenBridgeRelayer(tokenId.chain);
  if (!relayer) return false;
  const accepted = await relayer.isAcceptedToken(tokenId.address);
  return accepted;
};

export const isEvmChain = (chain: ChainName | ChainId) => {
  return isEVMChain(wh.toChainId(chain));
};

export const toChainId = (chain: ChainName | ChainId) => {
  return wh.toChainId(chain);
};