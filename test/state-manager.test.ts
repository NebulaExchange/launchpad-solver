import { StateManagerService } from '../src/services/state-manager.service';
import { CacheService } from '../src/services/cache.service';
import { DBService } from '../src/services/db.service';
import { IntentsService } from '../src/services/intents.service';

jest.mock('../src/configs/tokens', () => ({
  tokens: [
    { assetId: 'nep141:usdt.tether-token.near', decimals: 6 },
    { assetId: 'nep141:sol.omft.near', decimals: 9 },
  ],
}));

const mockCache = {
  set: jest.fn(),
} as unknown as CacheService;

const mockDB = {
  appendState: jest.fn().mockResolvedValue(undefined),
  readLatest: jest.fn().mockResolvedValue([
    { asset_id: 'nep141:usdt.tether-token.near', balance: 1000000 },
    { asset_id: 'nep141:sol.omft.near', balance: 2000000 },
  ]),
} as unknown as DBService;

const mockIntents = {
  generateDeterministicNonce: jest.fn(() => 'test-nonce'),
  getBalancesOnContract: jest.fn(() => Promise.resolve(['1000001', '2000002'])),
} as unknown as IntentsService;

describe('StateManagerService', () => {
  let stateManager: StateManagerService;

  beforeEach(() => {
    stateManager = new StateManagerService(mockCache, mockDB, mockIntents);
  });

  it('loads state from DB and hydrates cache', async () => {
    await stateManager.loadFromDb();

    const state = stateManager.getCurrentState();
    expect(state?.bondingCurve['nep141:usdt.tether-token.near']).toBe('1000000');
    expect(state?.bondingCurve['nep141:sol.omft.near']).toBe('2000000');
    expect(state?.nonce).toBe('test-nonce');
    expect(mockCache.set).toHaveBeenCalledWith('bonding_curve', expect.any(Object));
  });

  it('applies trade delta and persists after threshold', async () => {
    await stateManager.loadFromDb();

    for (let i = 0; i < 100; i++) {
      await stateManager.applyTradeDelta('nep141:sol.omft.near', '1000', true);
    }

    expect(mockDB.appendState).toHaveBeenCalled();
    const updated = stateManager.getCurrentState()?.bondingCurve['nep141:sol.omft.near'];
    expect(updated).toBe((2000000n + 1000n * 100n).toString());
  });

  it('updates state from on-chain and persists to DB', async () => {
    await stateManager.updateFromChain();

    expect(mockIntents.getBalancesOnContract).toHaveBeenCalled();
    expect(mockDB.appendState).toHaveBeenCalledWith({
      'nep141:sol.omft.near': '1000001',
      'nep141:usdt.tether-token.near': '2000002',
    });
  });

  it('persists state on demand', async () => {
    await stateManager.loadFromDb();
    await stateManager.persistToDbNow();

    expect(mockDB.appendState).toHaveBeenCalled();
  });
});
