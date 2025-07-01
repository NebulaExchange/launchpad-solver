import Big from 'big.js';
import { getBuyQuote, getSellQuote } from '../src/services/quoter.service';
import { LoggerService } from '../src/services/logger.service';
import { QuoterService } from '../src/services/quoter.service';
import { NearService } from '../src/services/near.service';
import { CacheService } from '../src/services/cache.service';
import { DBService } from '../src/services/db.service';
import { IntentsService } from '../src/services/intents.service';

const BUY_FEE = 0.01;
const SELL_FEE = 0.1;
const STEP_SIZE = new Big(0.02);
const STEP_SIZE_OVER_TWO = STEP_SIZE.div(2);

const logger = new LoggerService('test');

test('getSellQuote should return expected payout and apply fee', () => {
  const tokenInDecimals = 9;
  const tokenOutDecimals = 6;

  const amountInHuman = new Big(100); // 100 tokens
  const amountInYocto = amountInHuman.mul(Big(10).pow(tokenInDecimals)).toFixed(0);

  const currentSupply = new Big(1000); // 1000 tokens in supply
  const payoutYocto = getSellQuote(amountInYocto, logger, tokenInDecimals, tokenOutDecimals, currentSupply);

  const start = currentSupply;
  const end = currentSupply.plus(amountInHuman);
  const rawUSD = STEP_SIZE_OVER_TWO.mul(end.pow(2).minus(start.pow(2)));
  const expectedUSD = rawUSD.mul(1 - SELL_FEE);
  const expectedYocto = expectedUSD.mul(Big(10).pow(tokenOutDecimals)).round(0, Big.roundDown);

  expect(payoutYocto).toBe(expectedYocto.toFixed(0));
});

test('getBuyQuote should return expected tokens and apply fee', () => {
  const tokenInDecimals = 9;
  const tokenOutDecimals = 6;

  const amountOutUSD = new Big(500);
  const amountOutYocto = amountOutUSD.mul(Big(10).pow(tokenOutDecimals)).toFixed(0);

  const currentSupply = new Big(1000); // 1000 tokens in supply
  const amountInYocto = getBuyQuote(amountOutYocto, logger, tokenInDecimals, tokenOutDecimals, currentSupply);

  const grossUSD = amountOutUSD.div(1 - BUY_FEE);
  const target = grossUSD.div(STEP_SIZE_OVER_TWO).plus(currentSupply.pow(2));
  const end = target.sqrt();
  const amountInHuman = end.minus(currentSupply);
  const expectedYocto = amountInHuman.mul(Big(10).pow(tokenInDecimals)).round(0, Big.roundUp);

  expect(amountInYocto).toBe(expectedYocto.toFixed(0));
});

test('buy then sell should result in small net loss due to fees', () => {
  const tokenInDecimals = 9;
  const tokenOutDecimals = 6;

  const currentSupply = new Big(1000);
  const usdToSpend = new Big(500);
  const usdToSpendYocto = usdToSpend.mul(Big(10).pow(tokenOutDecimals)).toFixed(0);

  const buyTokensYocto = getBuyQuote(usdToSpendYocto, logger, tokenInDecimals, tokenOutDecimals, currentSupply);
  const buyAmount = new Big(buyTokensYocto).div(Big(10).pow(tokenInDecimals));
  const sellSupply = currentSupply.plus(buyAmount);

  const usdBackYocto = getSellQuote(buyTokensYocto, logger, tokenInDecimals, tokenOutDecimals, sellSupply);
  const usdBack = new Big(usdBackYocto).div(Big(10).pow(tokenOutDecimals));

  expect(Number(usdBack)).toBeLessThan(Number(usdToSpend));
  expect(Number(usdBack)).toBeGreaterThan(Number(usdToSpend.mul(1 - BUY_FEE - SELL_FEE).toFixed(2)));
});

jest.mock('../src/configs/tokens', () => ({
  tokens: [
    { assetId: 'nep141:usdt.tether-token.near', decimals: 6 },
    { assetId: 'nep141:sol.omft.near', decimals: 9 },
  ],
}));

test('quote response uses raw values and formats intent correctly', async () => {
  const mockCache = new CacheService('./data/test-cache.json');
  const mockDbService = {
    appendState: jest.fn().mockResolvedValue(undefined),
    init: jest.fn().mockResolvedValue(undefined),
    readAll: jest.fn().mockResolvedValue([]),
    readLatest: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as DBService;
  const mockNear = {
    getAccountId: () => 'test-account.near',
    signMessage: async () => ({ signature: Buffer.from('sig'), publicKey: { data: Buffer.from('pk') } }),
  } as unknown as NearService;
  const mockIntents = {
    generateDeterministicNonce: () => 'mock-nonce',
    getBalancesOnContract: async () => ['1000000000', '1000000000000'],
  } as unknown as IntentsService;

  const service = new QuoterService(mockCache, mockDbService, mockNear, mockIntents);

  service.__setTestState({
    bondingCurve: {
      'nep141:usdt.tether-token.near': '1000000000000', // 1_000 USDT with 6 decimals
      'nep141:sol.omft.near': '1000000000000000', // 1_000 SOL with 9 decimals
    },
    nonce: '1111111111111111111111111111111111111111111',
  });

  const quote = await service.getQuoteResponse({
    quote_id: 'test-quote-id',
    defuse_asset_identifier_in: 'nep141:usdt.tether-token.near',
    defuse_asset_identifier_out: 'nep141:sol.omft.near',
    exact_amount_in: '100000000', // 0.1 token with 9 decimals
    min_deadline_ms: 5000,
  });

  expect(quote).toBeDefined();
  expect(quote?.quote_output.amount_out).toMatch(/^\d+$/); // raw yocto string
  expect(quote?.signed_data.payload.message).toContain('token_diff');
});
