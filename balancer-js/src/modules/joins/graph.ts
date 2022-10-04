import { BalancerError, BalancerErrorCode } from '@/balancerErrors';
import { parsePoolInfo } from '@/lib/utils';
import { BalancerSdkConfig, Pool, PoolAttribute, PoolType } from '@/types';
import { Zero, WeiPerEther } from '@ethersproject/constants';
import { BigNumber } from '@ethersproject/bignumber';
import { Findable } from '../data/types';
import { Pools } from '../pools';
import { getNetworkConfig } from '../sdk.helpers';

type SpotPrices = { [tokenIn: string]: string };
export interface Node {
  address: string;
  id: string;
  joinAction: JoinAction;
  exitAction: ExitAction;
  type: string;
  children: Node[];
  marked: boolean;
  index: string;
  proportionOfParent: BigNumber;
  parent: Node | undefined;
  isLeaf: boolean;
  spotPrices: SpotPrices;
  decimals: number;
}

type JoinAction =
  | 'input'
  | 'batchSwap'
  | 'wrap'
  | 'joinPool'
  | 'wrapAaveDynamicToken'
  | 'wrapERC4626';
const joinActions = new Map<PoolType, JoinAction>();
joinActions.set(PoolType.AaveLinear, 'batchSwap');
joinActions.set(PoolType.ERC4626Linear, 'batchSwap');
joinActions.set(PoolType.Element, 'batchSwap');
joinActions.set(PoolType.Investment, 'joinPool');
joinActions.set(PoolType.LiquidityBootstrapping, 'joinPool');
joinActions.set(PoolType.MetaStable, 'joinPool');
joinActions.set(PoolType.Stable, 'joinPool');
joinActions.set(PoolType.StablePhantom, 'batchSwap');
joinActions.set(PoolType.Weighted, 'joinPool');
joinActions.set(PoolType.ComposableStable, 'joinPool');

type ExitAction =
  | 'output'
  | 'batchSwap'
  | 'unwrap'
  | 'exitPool'
  | 'unwrapAaveStaticToken'
  | 'unwrapERC4626';
const exitActions = new Map<PoolType, ExitAction>();
exitActions.set(PoolType.AaveLinear, 'batchSwap');
exitActions.set(PoolType.ERC4626Linear, 'batchSwap');
exitActions.set(PoolType.Element, 'batchSwap');
exitActions.set(PoolType.Investment, 'exitPool');
exitActions.set(PoolType.LiquidityBootstrapping, 'exitPool');
exitActions.set(PoolType.MetaStable, 'exitPool');
exitActions.set(PoolType.Stable, 'exitPool');
exitActions.set(PoolType.StablePhantom, 'batchSwap');
exitActions.set(PoolType.Weighted, 'exitPool');
exitActions.set(PoolType.ComposableStable, 'exitPool');

export class PoolGraph {
  constructor(
    private pools: Findable<Pool, PoolAttribute>,
    private sdkConfig: BalancerSdkConfig
  ) {}

  async buildGraphFromRootPool(
    poolId: string,
    wrapMainTokens: boolean
  ): Promise<Node> {
    const rootPool = await this.pools.find(poolId);
    if (!rootPool) throw new BalancerError(BalancerErrorCode.POOL_DOESNT_EXIST);
    const nodeIndex = 0;
    const rootNode = await this.buildGraphFromPool(
      rootPool.address,
      nodeIndex,
      undefined,
      WeiPerEther,
      wrapMainTokens
    );
    return rootNode[0];
  }

  getTokenTotal(pool: Pool): BigNumber {
    const bptIndex = pool.tokensList.indexOf(pool.address);
    let total = Zero;
    const { parsedBalances } = parsePoolInfo(pool);
    parsedBalances.forEach((balance, i) => {
      // Ignore phantomBpt balance
      if (bptIndex !== i) {
        total = total.add(balance);
      }
    });
    return total;
  }

  async buildGraphFromPool(
    address: string,
    nodeIndex: number,
    parent: Node | undefined,
    proportionOfParent: BigNumber,
    wrapMainTokens: boolean
  ): Promise<[Node, number]> {
    const pool = await this.pools.findBy('address', address);

    if (!pool) {
      if (!parent) {
        // If pool not found by address and is root pool (without parent), then throw error
        throw new BalancerError(BalancerErrorCode.POOL_DOESNT_EXIST);
      } else {
        // If pool not found by address, but it has parent, assume it's a leaf token and add a leafTokenNode
        // TODO: maybe it's a safety issue? Can we be safer?
        const parentPool = (await this.pools.findBy(
          'address',
          parent.address
        )) as Pool;
        const leafTokenDecimals =
          parentPool.tokens[parentPool.tokensList.indexOf(address)].decimals ??
          18;

        const nodeInfo = PoolGraph.createInputTokenNode(
          nodeIndex,
          address,
          leafTokenDecimals,
          parent,
          proportionOfParent
        );
        return nodeInfo;
      }
    }

    const joinAction = joinActions.get(pool.poolType);
    const exitAction = exitActions.get(pool.poolType);
    if (!joinAction || !exitAction)
      throw new BalancerError(BalancerErrorCode.UNSUPPORTED_POOL_TYPE);

    const tokenTotal = this.getTokenTotal(pool);
    const network = getNetworkConfig(this.sdkConfig);
    const controller = Pools.wrap(pool, network);
    const spotPrices: SpotPrices = {};
    let decimals = 18;
    // Spot price of a path is product of the sp of each pool in path. We calculate the sp for each pool token here to use as required later.
    pool.tokens.forEach((token) => {
      if (token.address === pool.address) {
        // Updated node with BPT token decimal
        decimals = token.decimals ? token.decimals : 18;
        return;
      }
      const sp = controller.calcSpotPrice(token.address, pool.address);
      spotPrices[token.address] = sp;
    });

    let poolNode: Node = {
      address: pool.address,
      id: pool.id,
      type: pool.poolType,
      joinAction,
      exitAction,
      children: [],
      marked: false,
      index: nodeIndex.toString(),
      parent,
      proportionOfParent,
      isLeaf: false,
      spotPrices,
      decimals,
    };
    nodeIndex++;
    if (pool.poolType.toString().includes('Linear')) {
      [poolNode, nodeIndex] = this.createLinearNodeChildren(
        poolNode,
        nodeIndex,
        pool,
        wrapMainTokens
      );
    } else {
      const { parsedBalances } = parsePoolInfo(pool);
      for (let i = 0; i < pool.tokens.length; i++) {
        // ignore any phantomBpt tokens
        if (pool.tokens[i].address === pool.address) continue;
        const proportion = BigNumber.from(parsedBalances[i])
          .mul((1e18).toString())
          .div(tokenTotal);
        const finalProportion = proportion
          .mul(proportionOfParent)
          .div((1e18).toString());
        const childNode = await this.buildGraphFromPool(
          pool.tokens[i].address,
          nodeIndex,
          poolNode,
          finalProportion,
          wrapMainTokens
        );
        nodeIndex = childNode[1];
        if (childNode[0]) poolNode.children.push(childNode[0]);
      }
    }
    return [poolNode, nodeIndex];
  }

  createLinearNodeChildren(
    linearPoolNode: Node,
    nodeIndex: number,
    linearPool: Pool,
    wrapMainTokens: boolean
  ): [Node, number] {
    if (wrapMainTokens) {
      // Linear pool will be joined via wrapped token. This will be the child node.
      const wrappedNodeInfo = this.createWrappedTokenNode(
        linearPool,
        nodeIndex,
        linearPoolNode,
        linearPoolNode.proportionOfParent
      );
      linearPoolNode.children.push(wrappedNodeInfo[0]);
      return [linearPoolNode, wrappedNodeInfo[1]];
    } else {
      // Main token
      if (linearPool.mainIndex === undefined)
        throw new Error('Issue With Linear Pool');

      const mainTokenDecimals =
        linearPool.tokens[linearPool.mainIndex].decimals ?? 18;

      const nodeInfo = PoolGraph.createInputTokenNode(
        nodeIndex,
        linearPool.tokensList[linearPool.mainIndex],
        mainTokenDecimals,
        linearPoolNode,
        linearPoolNode.proportionOfParent
      );
      linearPoolNode.children.push(nodeInfo[0]);
      nodeIndex = nodeInfo[1];
      return [linearPoolNode, nodeIndex];
    }
  }

  createWrappedTokenNode(
    linearPool: Pool,
    nodeIndex: number,
    parent: Node | undefined,
    proportionOfParent: BigNumber
  ): [Node, number] {
    if (
      linearPool.wrappedIndex === undefined ||
      linearPool.mainIndex === undefined
    )
      throw new Error('Issue With Linear Pool');

    // Relayer can support different wrapped tokens
    let joinAction: JoinAction = 'wrapAaveDynamicToken';
    switch (linearPool.poolType) {
      case PoolType.ERC4626Linear:
        joinAction = 'wrapERC4626';
    }
    let exitAction: ExitAction = 'unwrapAaveStaticToken';
    switch (linearPool.poolType) {
      case PoolType.ERC4626Linear:
        exitAction = 'unwrapERC4626';
    }

    const wrappedTokenNode: Node = {
      type: 'WrappedToken',
      address: linearPool.tokensList[linearPool.wrappedIndex],
      id: 'N/A',
      children: [],
      marked: false,
      joinAction,
      exitAction,
      index: nodeIndex.toString(),
      parent,
      proportionOfParent,
      isLeaf: false,
      spotPrices: {},
      decimals: 18,
    };
    nodeIndex++;

    const mainTokenDecimals =
      linearPool.tokens[linearPool.mainIndex].decimals ?? 18;

    const inputNode = PoolGraph.createInputTokenNode(
      nodeIndex,
      linearPool.tokensList[linearPool.mainIndex],
      mainTokenDecimals,
      wrappedTokenNode,
      proportionOfParent
    );
    wrappedTokenNode.children = [inputNode[0]];
    nodeIndex = inputNode[1];
    return [wrappedTokenNode, nodeIndex];
  }

  static createInputTokenNode(
    nodeIndex: number,
    address: string,
    decimals: number,
    parent: Node | undefined,
    proportionOfParent: BigNumber
  ): [Node, number] {
    return [
      {
        address,
        id: 'N/A',
        type: 'Input',
        children: [],
        marked: false,
        joinAction: 'input',
        exitAction: 'output',
        index: nodeIndex.toString(), // This will be updated with real amounts in join construction.
        parent,
        proportionOfParent,
        isLeaf: true,
        spotPrices: {},
        decimals,
      },
      nodeIndex + 1,
    ];
  }

  static orderByBfs(root: Node): Node[] {
    // Breadth first traversal of graph
    const nodes: Node[] = [];
    const orderedNodes: Node[] = [];
    root.marked = true;
    nodes.push(root);
    while (nodes.length > 0) {
      const currentNode = nodes.shift(); // removes first
      if (currentNode) orderedNodes.push(currentNode);
      currentNode?.children.forEach((c) => {
        if (!c.marked) {
          c.marked = true;
          nodes.push(c);
        }
      });
    }
    return orderedNodes;
  }

  // From a starting node traverse up graph until root
  static getNodesToRoot(
    orderedNodes: Node[],
    inputToken: string,
    startingIndex: number
  ): Node[] {
    let index = startingIndex;
    // Can't join using the root token itself
    if (
      inputToken.toLowerCase() ===
      orderedNodes[orderedNodes.length - 1].address.toLowerCase()
    )
      throw new BalancerError(BalancerErrorCode.INPUT_TOKEN_INVALID);
    // Find the node matching input token
    const inputNode = orderedNodes.find(
      (node) => node.address.toLowerCase() === inputToken.toLowerCase()
    );
    if (inputNode === undefined)
      throw new BalancerError(BalancerErrorCode.INPUT_TOKEN_INVALID);
    const nodesToRoot: Node[] = [];
    if (inputNode.joinAction !== 'input') {
      // Create an input node for the input token
      // For a non-leaf join we will use 100% of token amount in path
      const [inputTokenNode] = this.createInputTokenNode(
        startingIndex,
        inputToken,
        inputNode.decimals,
        inputNode.parent,
        WeiPerEther
      );
      nodesToRoot.push(inputTokenNode);
    } else {
      // Joining with a leaf token
      const inputTokenNode = { ...inputNode };
      // For a non-leaf join we will use 100% of token amount in path
      inputTokenNode.proportionOfParent = WeiPerEther;
      inputTokenNode.index = '0';
      nodesToRoot.push(inputNode);
    }
    index++;

    let parentNode: Node | undefined = inputNode.parent;
    // Traverse up graph until we reach root adding each node
    while (parentNode !== undefined) {
      const node: Node = { ...parentNode };
      node.proportionOfParent = BigNumber.from('0'); // TODO - Will this cause issues?
      node.index = index.toString();
      if (index - 1 === startingIndex) {
        // The first non-input node must have its child input node updated and other to 0 amounts
        const childrenWithoutRoot = node.children
          .filter(
            (node) =>
              node.address.toLowerCase() !==
              nodesToRoot[0].address.toLowerCase()
          )
          .map((n) => {
            n.index = '0';
            return n;
          });
        childrenWithoutRoot.push(nodesToRoot[0]);
        node.children = childrenWithoutRoot;
      }
      index++;
      nodesToRoot.push(node);
      parentNode = parentNode.parent;
    }
    return nodesToRoot;
  }

  // Return a list of leaf token addresses
  static getLeafAddresses(nodes: Node[]): string[] {
    return nodes.filter((n) => n.isLeaf).map((n) => n.address);
  }
}
