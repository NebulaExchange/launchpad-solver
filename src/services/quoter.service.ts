import Big from 'big.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { IMessage, SignStandardEnum } from '../interfaces/intents.interface';
import { IQuoteRequestData, IQuoteResponseData } from '../interfaces/websocket.interface';
import { CacheService } from './cache.service';
import { intentsContract } from '../configs/intents.config';
import { quoteDeadlineExtraMs, quoteDeadlineMaxMs } from '../configs/quoter.config';
import { NearService } from './near.service';
import { IntentsService } from './intents.service';
import { LoggerService } from './logger.service';
import { serializeIntent } from '../utils/hashing';
import { makeNonReentrant } from '../utils/make-nonreentrant';
import { tokens } from '../configs/tokens';

const BUY_FEE = 0.01; // 1%
const SELL_FEE = 0.1; // 10%
const STEP_SIZE = new Big(0.02); // $0.02 per token
const STEP_SIZE_OVER_2 = STEP_SIZE.div(2);
const STATE_FILE = path.join(__dirname, '../../data/bonding-curve.json');

interface BondingCurveState {
  supply: number; // total tokens in circulation
}

type State = {
  bondingCurve: BondingCurveState;
  nonce: string;
};

function toIntegerAmountString(amount: string | Big, decimals: number): string {
  const bigAmount = typeof amount === 'string' ? new Big(amount) : amount;
  return bigAmount.mul(Big(10).pow(decimals)).round(0, Big.roundDown).toFixed(0);
}

export class QuoterService {
  private currentState?: State;
  private logger = new LoggerService('quoter');

  public constructor(
    private readonly cacheService: CacheService,
    private readonly nearService: NearService,
    private readonly intentsService: IntentsService,
  ) {}

  public updateCurrentState = makeNonReentrant(async () => {
    const rawState = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed: BondingCurveState = JSON.parse(rawState);
    this.currentState = {
      bondingCurve: parsed,
      nonce: this.intentsService.generateDeterministicNonce(`supply:${parsed.supply}`),
    };
    this.logger.debug(`Loaded bonding curve state: ${JSON.stringify(this.currentState)}`);
  });

  public async getQuoteResponse(params: IQuoteRequestData): Promise<IQuoteResponseData | undefined> {
    const logger = this.logger.toScopeLogger(params.quote_id);
    if (params.min_deadline_ms > quoteDeadlineMaxMs) {
      logger.info(`min_deadline_ms exceeds maximum allowed value: ${params.min_deadline_ms} > ${quoteDeadlineMaxMs}`);
      return;
    }

    const { currentState } = this;
    if (!currentState) {
      logger.error(`Quoter state is not yet initialized`);
      return;
    }

    const amount = this.calculateQuote(
      params.exact_amount_in,
      params.exact_amount_out,
      currentState.bondingCurve,
      logger,
    );

    if (amount === '0') {
      logger.info('Calculated amount is 0');
      return;
    }

    const quoteDeadlineMs = params.min_deadline_ms + quoteDeadlineExtraMs;
    const standard = SignStandardEnum.nep413;

    const tokenInDecimals = tokens.find((t) => t.assetId === params.defuse_asset_identifier_in)?.decimals;
    // const amountInRaw = params.exact_amount_in
    //   ? toIntegerAmountString(params.exact_amount_in, tokenInDecimals!)
    //   : toIntegerAmountString(amount, tokenInDecimals!);
    const amountInRaw = params.exact_amount_in ?? toIntegerAmountString(amount, tokenInDecimals!);

    const tokenOutDecimals = tokens.find((t) => t.assetId === params.defuse_asset_identifier_out)?.decimals;
    // const amountOutRaw = params.exact_amount_out
    //   ? toIntegerAmountString(params.exact_amount_out, tokenOutDecimals!)
    //   : toIntegerAmountString(amount, tokenOutDecimals!);
    const amountOutRaw = params.exact_amount_out ?? toIntegerAmountString(amount, tokenOutDecimals!);

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
    const nonce = currentState.nonce;
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

    this.cacheService.set(bs58.encode(quoteHash), quoteResp, quoteDeadlineMs / 1000);

    return quoteResp;
  }

  public calculateQuote(
    amountIn: string | undefined,
    amountOut: string | undefined,
    state: BondingCurveState,
    logger: LoggerService,
  ): string {
    if (amountIn) {
      return getSellQuote(new Big(amountIn), new Big(state.supply), logger);
    } else if (amountOut) {
      return getBuyQuote(new Big(amountOut), new Big(state.supply), logger);
    }
    return '0';
  }

  public applyAcceptedQuote(params: IQuoteRequestData) {
    if (!this.currentState) {
      throw new Error('State is not initialized');
    }

    let delta: Big;
    const isSell = !!params.exact_amount_in;

    if (params.exact_amount_in) {
      delta = new Big(params.exact_amount_in);
    } else if (params.exact_amount_out) {
      delta = new Big(params.exact_amount_out);
    } else {
      throw new Error('Both amount_in and amount_out are missing');
    }

    const currentSupply = new Big(this.currentState.bondingCurve.supply);
    const updatedSupply = isSell ? currentSupply.plus(delta) : currentSupply.minus(delta);

    this.currentState.bondingCurve.supply = parseInt(updatedSupply.toFixed(0));
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.currentState.bondingCurve, null, 2));

    this.logger.info(
      `Applied accepted ${isSell ? 'sell' : 'buy'} quote. Updated supply: ${this.currentState.bondingCurve.supply}`,
    );
  }

  /** Test-only method */
  public __setTestState(state: State) {
    this.currentState = state;
  }
}

export function getSellQuote(amountIn: Big, supply: Big, logger: LoggerService): string {
  const newSupply = supply.plus(amountIn);
  const payout = newSupply.pow(2).minus(supply.pow(2)).mul(STEP_SIZE_OVER_2);
  const payoutAfterFee = payout.mul(new Big(1).minus(SELL_FEE));
  logger.info(
    `Sell ${amountIn.toFixed()} tokens from supply ${supply.toFixed()} yields $${payoutAfterFee.toFixed(2)} after ${
      SELL_FEE * 100
    }% fee`,
  );
  return payoutAfterFee.toFixed(2);
}

export function getBuyQuote(amountOut: Big, supply: Big, logger: LoggerService): string {
  const grossCost = amountOut.div(new Big(1).minus(BUY_FEE));
  const newTotal = grossCost.div(STEP_SIZE_OVER_2).add(supply.pow(2));
  const newSupply = newTotal.sqrt();
  const amountIn = newSupply.minus(supply);
  logger.info(
    `Buy ${amountOut.toFixed(2)} USD from supply ${supply.toFixed()} costs ${amountIn.toFixed()} tokens (before ${
      BUY_FEE * 100
    }% fee)`,
  );
  return amountIn.toFixed(0);
}
