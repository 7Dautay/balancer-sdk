// yarn test:only ./src/modules/pools/pool-types/concerns/stable/exit.concern.integration.spec.ts
import dotenv from 'dotenv';
import { expect } from 'chai';
import { BalancerSDK, Network, Pool } from '@/.';
import hardhat from 'hardhat';

import { TransactionReceipt } from '@ethersproject/providers';
import { BigNumber, parseFixed } from '@ethersproject/bignumber';
import { forkSetup, getBalances } from '@/test/lib/utils';
import { Pools } from '@/modules/pools';

import pools_16350000 from '@/test/lib/pools_16350000.json';

dotenv.config();

const { ALCHEMY_URL: jsonRpcUrl } = process.env;
const { ethers } = hardhat;

const rpcUrl = 'http://127.0.0.1:8545';
const network = Network.MAINNET;
const { networkConfig } = new BalancerSDK({ network, rpcUrl });
const wrappedNativeAsset =
  networkConfig.addresses.tokens.wrappedNativeAsset.toLowerCase();

const provider = new ethers.providers.JsonRpcProvider(rpcUrl, network);
const signer = provider.getSigner();

// Slots used to set the account balance for each token through hardhat_setStorageAt
// Info fetched using npm package slot20
const BPT_SLOT = 0;
const initialBalance = '100000';
const amountsOutDiv = (1e7).toString(); // FIXME: depending on this number, exitExactTokenOut (single token) throws Errors.STABLE_INVARIANT_DIDNT_CONVERGE
const slippage = '100'; // 1%

const pool = pools_16350000.find(
  (pool) =>
    pool.id ==
    '0xa13a9247ea42d743238089903570127dda72fe4400000000000000000000035d' // Balancer Aave Boosted StablePool
) as unknown as Pool;
const tokensOut = pool.tokens.filter(({ address }) => address !== pool.address);
const controller = Pools.wrap(pool, networkConfig);

describe('exit stable pools execution', async () => {
  let transactionReceipt: TransactionReceipt;
  let bptBalanceBefore: BigNumber;
  let bptBalanceAfter: BigNumber;
  let bptMaxBalanceDecrease: BigNumber;
  let tokensBalanceBefore: BigNumber[];
  let tokensBalanceAfter: BigNumber[];
  let tokensMinBalanceIncrease: BigNumber[];
  let signerAddress: string;

  // Setup chain
  before(async function () {
    await forkSetup(
      signer,
      [pool.address],
      [BPT_SLOT],
      [parseFixed(initialBalance, 18).toString()],
      jsonRpcUrl as string,
      16350000 // holds the same state as the static repository
    );
    signerAddress = await signer.getAddress();
  });

  const testFlow = async (
    [to, data, maxBPTIn, minAmountsOut]: [string, string, string, string[]],
    exitTokens: string[]
  ) => {
    // Check balances before transaction to confirm success
    [bptBalanceBefore, ...tokensBalanceBefore] = await getBalances(
      [pool.address, ...exitTokens],
      signer,
      signerAddress
    );
    console.log(tokensBalanceBefore);
    // Get expected balances out of transaction
    bptMaxBalanceDecrease = BigNumber.from(maxBPTIn);
    tokensMinBalanceIncrease = minAmountsOut.map((a) => BigNumber.from(a));

    // Send transaction to local fork
    const transactionResponse = await signer.sendTransaction({
      to,
      data,
      gasLimit: 3000000,
    });
    transactionReceipt = await transactionResponse.wait();

    // Check balances after transaction to confirm success
    [bptBalanceAfter, ...tokensBalanceAfter] = await getBalances(
      [pool.address, ...exitTokens],
      signer,
      signerAddress
    );
    console.log(tokensBalanceAfter);
  };

  context('exitExactBPTIn', async () => {
    context('single token max out', async () => {
      before(async function () {
        const bptIn = parseFixed('10', 18).toString();
        const { to, data, minAmountsOut } = controller.buildExitExactBPTIn(
          signerAddress,
          bptIn,
          slippage,
          false,
          pool.tokensList.filter((address) => address !== pool.address)[0]
        );
        await testFlow(
          [to, data, bptIn, minAmountsOut],
          pool.tokensList.filter((address) => address !== pool.address)
        );
      });

      it('should work', async () => {
        expect(transactionReceipt.status).to.eql(1);
      });

      it('tokens balance should increase by at least minAmountsOut', async () => {
        for (let i = 0; i < tokensBalanceAfter.length; i++) {
          expect(
            tokensBalanceAfter[i]
              .sub(tokensBalanceBefore[i])
              .gte(tokensMinBalanceIncrease[i])
          ).to.be.true;
        }
      });

      it('bpt balance should decrease by exact bptMaxBalanceDecrease', async () => {
        expect(bptBalanceBefore.sub(bptBalanceAfter).eq(bptMaxBalanceDecrease))
          .to.be.true;
      });
    });
  });
});
