import Big from 'big.js';
import { getBuyQuote, getSellQuote } from '../src/services/quoter.service';
import { LoggerService } from '../src/services/logger.service';
import { QuoterService } from '../src/services/quoter.service';
import { NearService } from '../src/services/near.service';
import { CacheService } from '../src/services/cache.service';
import { IntentsService } from '../src/services/intents.service';

const SUPPLY = new Big(1000);
const BUY_FEE = 0.01;
const SELL_FEE = 0.1;
const logger = new LoggerService('test');

test('getSellQuote should return expected payout and apply fee', () => {
  const amountIn = new Big(100);
  const payout = getSellQuote(amountIn, SUPPLY, logger);

  const rawPayout = SUPPLY.plus(amountIn).pow(2).minus(SUPPLY.pow(2)).mul(0.01);
  const expected = rawPayout.mul(1 - SELL_FEE);

  expect(Number(payout)).toBeCloseTo(Number(expected.toFixed(2)), 2);
});

test('getBuyQuote should return expected tokens and apply fee', () => {
  const amountOutUSD = new Big(500);
  const costInTokens = getBuyQuote(amountOutUSD, SUPPLY, logger);

  const gross = amountOutUSD.div(1 - BUY_FEE);
  const newTotal = gross.div(0.01).add(SUPPLY.pow(2));
  const expected = newTotal.sqrt().minus(SUPPLY);

  expect(Number(costInTokens)).toBeCloseTo(Number(expected.toFixed(0)), 0);
});

test('buy then sell should result in small net loss due to fees', () => {
  const usdToSpend = new Big(500);
  const buyTokens = new Big(getBuyQuote(usdToSpend, SUPPLY, logger));
  const usdBack = new Big(getSellQuote(buyTokens, SUPPLY, logger));

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
  const mockCache = new CacheService();
  const mockNear = {
    getAccountId: () => 'test-account.near',
    signMessage: async () => ({ signature: Buffer.from('sig'), publicKey: { data: Buffer.from('pk') } }),
  } as unknown as NearService;
  const mockIntents = {
    generateDeterministicNonce: () => 'mock-nonce',
    getBalancesOnContract: async () => ['1000000000', '1000000000000'],
  } as unknown as IntentsService;

  const service = new QuoterService(mockCache, mockNear, mockIntents);

  service.__setTestState({
    bondingCurve: { supply: 0 },
    nonce: '1111111111111111111111111111111111111111111',
  });

  const quote = await service.getQuoteResponse({
    quote_id: 'test-quote-id',
    defuse_asset_identifier_in: 'nep141:usdt.tether-token.near',
    defuse_asset_identifier_out: 'nep141:sol.omft.near',
    exact_amount_in: '1000',
    min_deadline_ms: 5000,
  });

  expect(quote).toBeDefined();
  expect(quote?.quote_output.amount_out).toMatch(/^\d+$/); // must be raw unit string
  expect(quote?.signed_data.payload.message).toContain('token_diff');
});
