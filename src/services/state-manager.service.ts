import bs58 from 'bs58';
import { CacheService } from './cache.service';
import { DBService } from './db.service';
import { IntentsService } from './intents.service';
import { LoggerService } from './logger.service';
import { BondingCurveState, QuoterState } from '../interfaces/quoter.interface';
import { IQuoteResponseData } from '../interfaces/websocket.interface';
import { tokens } from '../configs/tokens';

export class StateManagerService {
  private logger = new LoggerService('state');
  private tradeCounter = 0;
  private persistThreshold = 100;
  private currentState?: QuoterState;

  public constructor(
    private readonly cacheService: CacheService,
    private readonly dbService: DBService,
    private readonly intentsService: IntentsService,
  ) {}

  public async loadFromDb() {
    const pair = tokens
      .map((t) => t.assetId)
      .sort()
      .join('/');
    const latest = await this.dbService.readLatest(pair);

    const bondingCurveState: BondingCurveState = {};
    latest.forEach((row) => (bondingCurveState[row.asset_id] = row.balance.toString()));

    const nonceSeed = Object.entries(bondingCurveState)
      .map(([id, bal]) => `${id}:${bal}`)
      .join('|');

    const newState: QuoterState = {
      bondingCurve: bondingCurveState,
      nonce: this.intentsService.generateDeterministicNonce(`supply:${nonceSeed}`),
    };

    this.currentState = newState;
    this.cacheService.set('bonding_curve', bondingCurveState);
    this.logger.info('Hydrated cache from DB');
  }

  public getCurrentState(): QuoterState | undefined {
    return this.currentState;
  }

  public async applyTradeDelta(assetId: string, delta: string, isSell: boolean) {
    if (!this.currentState) throw new Error('State not initialized');

    const current = this.currentState.bondingCurve[assetId] ?? '0';
    const updated = isSell ? BigInt(current) + BigInt(delta) : BigInt(current) - BigInt(delta);

    this.logger.info(
      `${isSell ? 'Sell' : 'Buy'} trade applied to ${assetId}: delta = ${delta}, old = ${current}, new = ${updated}`,
    );

    this.currentState.bondingCurve[assetId] = updated.toString();
    this.cacheService.set('bonding_curve', this.currentState.bondingCurve);

    this.tradeCounter++;
    if (this.tradeCounter >= this.persistThreshold) {
      await this.dbService.appendState(this.currentState.bondingCurve);
      this.tradeCounter = 0;
      this.logger.info('Persisted state to DB after trade threshold');
    }
  }

  public async updateFromChain() {
    if (!this.currentState) this.logger.info('No previous state found, initializing from chain');

    const sorted = [...tokens].sort((a, b) => a.assetId.localeCompare(b.assetId));
    const assetIds = sorted.map((t) => t.assetId);
    const balances = await this.intentsService.getBalancesOnContract(assetIds);

    const bondingCurveState: BondingCurveState = {};
    assetIds.forEach((assetId, idx) => {
      const newBal = balances[idx];
      bondingCurveState[assetId] = newBal;

      const prev = this.currentState?.bondingCurve[assetId];
      if (prev && prev !== newBal) {
        this.logger.info(`Balance changed for ${assetId}: ${prev} → ${newBal}`);
      } else {
        this.logger.debug(`${assetId} balance remains ${newBal}`);
      }
    });

    const nonceSeed = assetIds.map((id, i) => `${id}:${balances[i]}`).join('|');
    const newState: QuoterState = {
      bondingCurve: bondingCurveState,
      nonce: this.intentsService.generateDeterministicNonce(`supply:${nonceSeed}`),
    };

    this.currentState = newState;
    this.cacheService.set('bonding_curve', bondingCurveState);
    await this.dbService.appendState(bondingCurveState);
    this.logger.info('Updated state from on-chain balances');
  }

  public async cacheQuoteResp(
    quoteHash: Buffer<ArrayBufferLike>,
    quoteResp: IQuoteResponseData,
    quoteDeadlineMs: number,
  ) {
    this.cacheService.set(bs58.encode(quoteHash), quoteResp, quoteDeadlineMs / 1000);
  }

  public async persistToDbNow() {
    if (this.currentState) {
      await this.dbService.appendState(this.currentState.bondingCurve);
      this.logger.info('Persisted state to DB on shutdown');
    }
  }
}
