import { Pool } from 'pg';
import { BondingCurveState } from '../interfaces/quoter.interface';
import { dbConnectionString } from '../configs/db.config';

export class DBService {
  private pool: Pool;
  private tableName = 'bonding_curves';

  public constructor() {
    this.pool = new Pool({
      connectionString: dbConnectionString,
      ssl: { rejectUnauthorized: false },
    });
  }

  public async init() {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id SERIAL PRIMARY KEY,
        pair TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        balance NUMERIC NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ
      );
    `;
    await this.pool.query(query);
  }

  public async appendState(state: BondingCurveState) {
    const assetIds = Object.keys(state);
    if (assetIds.length !== 2) {
      throw new Error(`Expected exactly two assetIds, got ${assetIds.length}`);
    }

    const [asset1, asset2] = assetIds;
    const balance1 = state[asset1];
    const balance2 = state[asset2];
    const pair = [asset1, asset2].sort().join('/');

    const query = `
      INSERT INTO ${this.tableName} (pair, asset_id, balance)
      VALUES
        ($1, $2, $3),
        ($1, $4, $5);
    `;
    await this.pool.query(query, [pair, asset1, balance1, asset2, balance2]);
  }

  public async readLatest(pair: string): Promise<{ asset_id: string; balance: number; created_at: string }[]> {
    const query = `
      SELECT bc.asset_id, bc.balance, bc.created_at
      FROM ${this.tableName} bc
      INNER JOIN (
        SELECT pair, MAX(created_at) AS max_created_at
        FROM ${this.tableName}
        WHERE pair = $1
        GROUP BY pair
      ) latest
      ON bc.pair = latest.pair AND bc.created_at = latest.max_created_at;
    `;
    const result = await this.pool.query(query, [pair]);
    return result.rows;
  }

  public async readAll(): Promise<{ pair: string; asset_id: string; balance: number; created_at: string }[]> {
    const result = await this.pool.query(
      `SELECT pair, asset_id, balance, created_at FROM ${this.tableName} ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  public async close() {
    await this.pool.end();
  }
}
