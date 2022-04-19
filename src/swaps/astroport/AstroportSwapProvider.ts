import { ChainId, chains, currencyToUnit, unitToCurrency } from '@liquality/cryptoassets';
import { TerraNetworks } from '@liquality/terra-networks';
import { LCDClient } from '@terra-money/terra.js';
import BN from 'bignumber.js';
import { v4 as uuidv4 } from 'uuid';
import { withInterval } from '../../store/actions/performNextAction/utils';
import { prettyBalance } from '../../utils/coinFormatter';
import cryptoassets from '../../utils/cryptoassets';
import { SwapProvider } from '../SwapProvider';
import { QuoteRequest, SwapStatus } from '../types';
import {
  buildSwapFromContractTokenMsg,
  buildSwapFromContractTokenToUSTMsg,
  buildSwapFromNativeTokenMsg,
  getPairAddressQuery,
  getRateERC20ToERC20,
  getRateNativeToAsset,
} from './queries';

class AstroportSwapProvider extends SwapProvider {
  async getSupportedPairs() {
    return [];
  }

  // @ts-ignore TODO: check return type
  async getQuote(quoteRequest: QuoteRequest) {
    const { from, to, amount } = quoteRequest;
    const fromInfo = cryptoassets[from];
    const toInfo = cryptoassets[to];

    // only for Terra network swaps
    if (fromInfo.chain !== ChainId.Terra || toInfo.chain !== ChainId.Terra || amount.lt(0)) {
      return null;
    }

    const fromAmountInUnit = currencyToUnit(fromInfo, new BN(amount)).toFixed();
    const { rate, fromTokenAddress, toTokenAddress, pairAddress } = await this._getSwapRate(
      fromAmountInUnit,
      fromInfo,
      toInfo
    );

    return {
      from,
      to,
      fromAmount: fromAmountInUnit,
      toAmount: rate.amount?.toString() || rate.return_amount?.toString(),
      fromTokenAddress,
      toTokenAddress,
      pairAddress,
    };
  }

  async newSwap({ network, walletId, quote }) {
    const client = this.getClient(network, walletId, quote.from, quote.fromAccountId);
    const [{ address }] = await client.wallet.getAddresses();

    const denom = this._getDenom(quote.from);

    const { fromTokenAddress, toTokenAddress, pairAddress } = quote;

    const isFromNative = quote.from === 'UST' || (quote.from === 'LUNA' && quote.to === 'UST');
    const isFromERC20ToUST = fromTokenAddress && quote.to === 'UST';

    let txData;

    if (isFromNative) {
      txData = buildSwapFromNativeTokenMsg(quote, denom, address, pairAddress);
    } else if (isFromERC20ToUST) {
      txData = buildSwapFromContractTokenToUSTMsg(quote, address, fromTokenAddress, pairAddress);
    } else {
      txData = buildSwapFromContractTokenMsg(quote, address, fromTokenAddress, toTokenAddress);
    }

    await this.sendLedgerNotification(quote.fromAccountId, 'Signing required to complete the swap.');

    const swapTx = await client.chain.sendTransaction(txData);

    const updates = {
      status: 'WAITING_FOR_SWAP_CONFIRMATIONS',
      swapTx,
      swapTxHash: swapTx.hash,
    };

    return {
      id: uuidv4(),
      fee: quote.fee,
      slippage: 50,
      ...updates,
    };
  }

  // ======== STATE TRANSITIONS ========

  async waitForSwapConfirmations({ swap, network, walletId }) {
    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId);

    try {
      const tx = await client.chain.getTransactionByHash(swap.swapTxHash);
      if (tx && tx.confirmations && tx.confirmations > 0) {
        const { status } = await client.getMethod('getTransactionByHash')(swap.swapTxHash);
        this.updateBalances(network, walletId, [swap.from]);
        return {
          endTime: Date.now(),
          status,
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  async performNextSwapAction(_store, { network, walletId, swap }) {
    let updates;

    if (swap.status === 'WAITING_FOR_SWAP_CONFIRMATIONS') {
      updates = await withInterval(async () => this.waitForSwapConfirmations({ swap, network, walletId }));
    }

    return updates;
  }

  // ======== MIN AMOUNT =======

  getSwapLimit() {
    return 2; // Min swap amount in USD
  }

  // ========= FEES ========

  async estimateFees({ asset, txType, quote, feePrices }) {
    if (txType !== this.fromTxType) {
      throw new Error(`Invalid tx type ${txType}`);
    }

    const nativeAsset = chains[cryptoassets[asset].chain].nativeAsset;

    const gasLimit = quote.from === 'UST' || (quote.from === 'LUNA' && quote.to === 'UST') ? 400_000 : 1_500_000;

    const fees = {};

    for (const feePrice of feePrices) {
      const fee = new BN(gasLimit).times(feePrice);
      fees[feePrice] = unitToCurrency(cryptoassets[nativeAsset], fee).toFixed();
    }

    return fees;
  }

  // ======== UTILS ========

  _getRPC() {
    const { chainID, nodeUrl } = TerraNetworks.terra_mainnet;

    return new LCDClient({
      chainID,
      URL: nodeUrl,
    });
  }

  _getDenom(asset) {
    return {
      LUNA: 'uluna',
      UST: 'uusd',
    }[asset];
  }

  async _getSwapRate(fromAmount, fromInfo, toInfo) {
    const rpc = this._getRPC();

    // Check coin types
    const nativeToNative = fromInfo.type === 'native' && toInfo.type === 'native';
    const erc20ToErc20 = fromInfo.type === 'erc20' && toInfo.type === 'erc20';
    const nativeToErc20 = fromInfo.type === 'native' && toInfo.type === 'erc20';
    const erc20ToNative = fromInfo.type === 'erc20' && toInfo.type === 'native';

    // Select correct query and address depending on coin types
    let contractData: any = {
      address: '',
      query: '',
    };

    let fromTokenAddress, toTokenAddress;

    if (nativeToNative) {
      const fromDenom = this._getDenom(fromInfo.code);

      contractData = getRateNativeToAsset(fromAmount, fromDenom);
    } else if (erc20ToErc20) {
      fromTokenAddress = fromInfo.contractAddress;
      toTokenAddress = toInfo.contractAddress;

      contractData = getRateERC20ToERC20(fromAmount, fromTokenAddress, toTokenAddress);
    } else if (nativeToErc20) {
      toTokenAddress = toInfo.contractAddress;

      const fromDenom = this._getDenom(fromInfo.code);

      const pairAddress = await this._getPairAddress(toTokenAddress);

      contractData =
        fromInfo.code === 'LUNA'
          ? getRateERC20ToERC20(fromAmount, fromDenom, toTokenAddress)
          : getRateNativeToAsset(fromAmount, fromDenom, pairAddress);
    } else if (erc20ToNative) {
      fromTokenAddress = fromInfo.contractAddress;

      const toDenom = this._getDenom(toInfo.code);

      const pairAddress = await this._getPairAddress(fromTokenAddress);

      contractData =
        toInfo.code === 'LUNA'
          ? getRateERC20ToERC20(fromAmount, fromTokenAddress, toDenom)
          : getRateNativeToAsset(fromAmount, fromTokenAddress, pairAddress);
    } else {
      throw new Error(`From: ${fromInfo.type} To: ${toInfo.type}`);
    }

    const { address, query } = contractData;

    const pairAddress = address;

    // TODO: type
    const rate: any = await rpc.wasm.contractQuery(address, query);

    return { rate, fromTokenAddress, toTokenAddress, pairAddress };
  }

  async _getPairAddress(tokenAddress) {
    const rpc = this._getRPC();

    const query = getPairAddressQuery(tokenAddress);

    // TODO: type
    const resp: any = await rpc.wasm.contractQuery('terra1fnywlw4edny3vw44x04xd67uzkdqluymgreu7g', query);

    return resp.contract_addr;
  }

  protected _getStatuses(): Record<string, SwapStatus> {
    return {
      WAITING_FOR_SWAP_CONFIRMATIONS: {
        step: 0,
        label: 'Swapping {from}',
        filterStatus: 'PENDING',
        notification() {
          return { message: 'Engaging Astroport' };
        },
      },
      SUCCESS: {
        step: 1,
        label: 'Completed',
        filterStatus: 'COMPLETED',
        notification(swap: any) {
          return { message: `Swap completed, ${prettyBalance(swap.toAmount, swap.to)} ${swap.to} ready to use` };
        },
      },
      FAILED: {
        step: 1,
        label: 'Swap Failed',
        filterStatus: 'REFUNDED',
        notification() {
          return { message: 'Swap failed' };
        },
      },
    };
  }

  protected _txTypes() {
    return {
      SWAP: 'SWAP',
    };
  }

  protected _fromTxType() {
    return this._txTypes().SWAP;
  }

  protected _toTxType() {
    return null;
  }

  protected _timelineDiagramSteps() {
    return ['SWAP'];
  }

  protected _totalSteps() {
    return 2;
  }
}

export { AstroportSwapProvider };
