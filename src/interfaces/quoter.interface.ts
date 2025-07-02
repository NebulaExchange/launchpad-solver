export interface BondingCurveState {
  [assetId: string]: string; // balances in yocto
}

export type QuoterState = {
  bondingCurve: BondingCurveState;
  nonce: string;
};
