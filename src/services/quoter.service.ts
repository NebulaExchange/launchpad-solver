import Big from 'big.js';
import bs58 from 'bs58';
import { IMessage, SignStandardEnum } from '../interfaces/intents.interface';
import { IQuoteRequestData, IQuoteResponseData } from '../interfaces/websocket.interface';
import { intentsContract } from '../configs/intents.config';
import { quoteDeadlineExtraMs, quoteDeadlineMaxMs } from '../configs/quoter.config';
import { NearService } from './near.service';
import { LoggerService } from './logger.service';
import { StateManagerService } from './state-manager.service';
import { serializeIntent } from '../utils/hashing';
import { makeNonReentrant } from '../utils/make-nonreentrant';
import { tokens } from '../configs/tokens';

const BUY_FEE = 0.01; // 1%
const SELL_FEE = 0.1; // 10%
const STEP_SIZE = new Big(0.02); // $0.02 per token
const STEP_SIZE_OVER_TWO = new Big(0.01);

export class QuoterService {
  private logger = new LoggerService('quoter');

  public constructor(
    private readonly stateManagerService: StateManagerService,
    private readonly nearService: NearService,
  ) {}

  public updateCurrentState = makeNonReentrant(async () => {
    await this.stateManagerService.updateFromChain();
  });

  public async getQuoteResponse(params: IQuoteRequestData): Promise<IQuoteResponseData | undefined> {
    const logger = this.logger.toScopeLogger(params.quote_id);

    if (params.min_deadline_ms > quoteDeadlineMaxMs) {
      logger.info(`min_deadline_ms exceeds maximum allowed value: ${params.min_deadline_ms} > ${quoteDeadlineMaxMs}`);
      return;
    }

    const currentState = this.stateManagerService.getCurrentState();

    const amount = this.calculateQuote(params, logger);

    if (amount === '0') {
      logger.info('Calculated amount is 0');
      return;
    }

    const quoteDeadlineMs = params.min_deadline_ms + quoteDeadlineExtraMs;
    const standard = SignStandardEnum.nep413;

    const tokenInDecimals = tokens.find((t) => t.assetId === params.defuse_asset_identifier_in)?.decimals;
    const tokenOutDecimals = tokens.find((t) => t.assetId === params.defuse_asset_identifier_out)?.decimals;

    const amountInRaw = params.exact_amount_in ?? amount;
    const amountOutRaw = params.exact_amount_out ?? amount;

    this.logger.debug(`Decimals - tokenIn: ${tokenInDecimals}, tokenOut: ${tokenOutDecimals}`);

    const message: IMessage = {
      signer_id: this.nearService.getAccountId(),
      deadline: new Date(Date.now() + quoteDeadlineMs).toISOString(),
      intents: [
        {
          intent: 'token_diff',
          diff: {
            [params.defuse_asset_identifier_in]: amountInRaw,
            [params.defuse_asset_identifier_out]: `-${amountOutRaw}`,
          },
        },
      ],
    };

    const messageStr = JSON.stringify(message);
    const nonce = currentState!.nonce;
    const recipient = intentsContract;
    const quoteHash = serializeIntent(messageStr, recipient, nonce, standard);
    const signature = await this.nearService.signMessage(quoteHash);

    const quoteResp: IQuoteResponseData = {
      quote_id: params.quote_id,
      quote_output: {
        amount_in: params.exact_amount_out ? amountInRaw : undefined,
        amount_out: params.exact_amount_in ? amountOutRaw : undefined,
      },
      signed_data: {
        standard,
        payload: {
          message: messageStr,
          nonce,
          recipient,
        },
        signature: `ed25519:${bs58.encode(signature.signature)}`,
        public_key: `ed25519:${bs58.encode(signature.publicKey.data)}`,
      },
    };

    this.logger.info(`amountInRaw: ${amountInRaw}, amountOutRaw: ${amountOutRaw}`);
    this.logger.info(`Generated message: ${messageStr}`);
    this.logger.info(`Quote hash: ${bs58.encode(quoteHash)}`);

    return quoteResp;
  }

  public calculateQuote(params: IQuoteRequestData, logger: LoggerService): string {
    const tokenIn = tokens.find((t) => t.assetId === params.defuse_asset_identifier_in)!;
    const tokenOut = tokens.find((t) => t.assetId === params.defuse_asset_identifier_out)!;

    const tokenInDecimals = tokenIn.decimals;
    const tokenOutDecimals = tokenOut.decimals;

    const currentState = this.stateManagerService.getCurrentState();
    const currentSupplyYocto = currentState!.bondingCurve[tokenIn.assetId];
    const currentSupply = new Big(currentSupplyYocto).div(Big(10).pow(tokenIn.decimals));

    if (params.exact_amount_in) {
      logger.info(`Calculating sell quote for amountIn: ${params.exact_amount_in}`);
      return getSellQuote(params.exact_amount_in, logger, tokenInDecimals, tokenOutDecimals, currentSupply);
    } else if (params.exact_amount_out) {
      logger.info(`Calculating buy quote for amountOut: ${params.exact_amount_out}`);
      return getBuyQuote(params.exact_amount_out, logger, tokenInDecimals, tokenOutDecimals, currentSupply);
    }

    logger.warn(`Neither amountIn nor amountOut provided`);
    return '0';
  }

  public async applyAcceptedQuote(params: IQuoteRequestData) {
    const isSell = !!params.exact_amount_in;
    const assetId = isSell ? params.defuse_asset_identifier_out : params.defuse_asset_identifier_in;
    const delta = params.exact_amount_in ?? params.exact_amount_out ?? '0';

    await this.stateManagerService.applyTradeDelta(assetId, delta, isSell);
  }
}

export function getSellQuote(
  exactAmountIn: string,
  logger: LoggerService,
  tokenInDecimals: number,
  tokenOutDecimals: number,
  currentSupply: Big, // new param (as Big)
): string {
  const amountIn = new Big(exactAmountIn).div(Big(10).pow(tokenInDecimals));
  const start = currentSupply;
  const end = currentSupply.plus(amountIn);

  const payout = STEP_SIZE_OVER_TWO.mul(end.pow(2).minus(start.pow(2))); // a/2 * (s+q)^2 - s^2
  const payoutAfterFee = payout.mul(new Big(1).minus(SELL_FEE));
  const payoutYocto = payoutAfterFee.mul(Big(10).pow(tokenOutDecimals)).round(0, Big.roundDown);

  logger.info(
    `Sell ${amountIn.toFixed()} tokens yields $${payoutAfterFee.toFixed(6)} after ${
      SELL_FEE * 100
    }% fee (bonding curve with a=${STEP_SIZE.toFixed()})`,
  );
  return payoutYocto.gt(0) ? payoutYocto.toFixed(0) : '1';
}

export function getBuyQuote(
  exactAmountOut: string,
  logger: LoggerService,
  tokenInDecimals: number,
  tokenOutDecimals: number,
  currentSupply: Big, // new param (as Big)
): string {
  const amountOut = new Big(exactAmountOut).div(Big(10).pow(tokenOutDecimals));
  const grossOut = amountOut.div(new Big(1).minus(BUY_FEE));

  const start = currentSupply;
  // Solve: a/2 * ((s + q)^2 - s^2) = grossOut
  // (s + q)^2 = 2 * grossOut / a + s^2
  const target = grossOut.div(STEP_SIZE_OVER_TWO).plus(start.pow(2));
  const end = target.sqrt();
  const amountIn = end.minus(start);

  const amountInYocto = amountIn.mul(Big(10).pow(tokenInDecimals)).round(0, Big.roundUp); // round up to ensure sufficient payment

  logger.info(
    `Buy $${amountOut.toFixed()} requires ${amountIn.toFixed()} tokens before fee (bonding curve with a=${STEP_SIZE.toFixed()})`,
  );
  return amountInYocto.gt(0) ? amountInYocto.toFixed(0) : '1';
}
