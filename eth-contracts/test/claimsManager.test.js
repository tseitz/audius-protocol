import * as _lib from '../utils/lib.js'
const { time } = require('@openzeppelin/test-helpers')

const MockDelegateManager = artifacts.require('MockDelegateManager')
const MockStakingCaller = artifacts.require('MockStakingCaller')
const Staking = artifacts.require('Staking')
const AudiusAdminUpgradeabilityProxy = artifacts.require('AudiusAdminUpgradeabilityProxy')
const ClaimsManager = artifacts.require('ClaimsManager')

const stakingProxyKey = web3.utils.utf8ToHex('StakingProxy')
const serviceProviderFactoryKey = web3.utils.utf8ToHex('ServiceProviderFactory')
const delegateManagerKey = web3.utils.utf8ToHex('DelegateManager')
const governanceKey = web3.utils.utf8ToHex('Governance')
const claimsManagerProxyKey = web3.utils.utf8ToHex('ClaimsManagerProxy')

const DEFAULT_AMOUNT = _lib.audToWeiBN(120)
const VOTING_PERIOD = 10
const VOTING_QUORUM = 1


contract('ClaimsManager', async (accounts) => {
  let token, registry, governance, staking0, stakingProxy, staking, claimsManager0, claimsManagerProxy, claimsManager
  let mockDelegateManager, mockStakingCaller

  // intentionally not using acct0 to make sure no TX accidentally succeeds without specifying sender
  const [, proxyAdminAddress, proxyDeployerAddress, staker] = accounts
  const guardianAddress = proxyDeployerAddress

  const approveTransferAndStake = async (amount, staker) => {
    // Transfer default tokens to
    await token.transfer(staker, amount, { from: proxyDeployerAddress })
    // Allow Staking app to move owner tokens
    await token.approve(staking.address, amount, { from: staker })
    // Stake tokens
    await mockStakingCaller.stakeFor(
      staker,
      amount)
  }

  beforeEach(async () => {
    token = await _lib.deployToken(artifacts, proxyAdminAddress, proxyDeployerAddress)
    registry = await _lib.deployRegistry(artifacts, proxyAdminAddress, proxyDeployerAddress)

    // Deploy + register Governance
    governance = await _lib.deployGovernance(
      artifacts,
      proxyAdminAddress,
      proxyDeployerAddress,
      registry,
      stakingProxyKey,
      governanceKey,
      VOTING_PERIOD,
      VOTING_QUORUM,
      guardianAddress
    )
    await registry.addContract(governanceKey, governance.address, { from: proxyDeployerAddress })

    // Deploy and register stakingProxy
    staking0 = await Staking.new({ from: proxyDeployerAddress })
    const stakingInitializeData = _lib.encodeCall(
      'initialize',
      ['address', 'address', 'bytes32', 'bytes32', 'bytes32'],
      [
        token.address,
        registry.address,
        claimsManagerProxyKey,
        delegateManagerKey,
        serviceProviderFactoryKey
      ]
    )
    stakingProxy = await AudiusAdminUpgradeabilityProxy.new(
      staking0.address,
      proxyAdminAddress,
      stakingInitializeData,
      registry.address,
      governanceKey,
      { from: proxyDeployerAddress }
    )
    await registry.addContract(stakingProxyKey, stakingProxy.address, { from: proxyDeployerAddress })
    staking = await Staking.at(stakingProxy.address)

    // Mock SP for test
    mockStakingCaller = await MockStakingCaller.new()
    await mockStakingCaller.initialize(stakingProxy.address, token.address)
    await registry.addContract(serviceProviderFactoryKey, mockStakingCaller.address, { from: proxyDeployerAddress })

    // Deploy mock delegate manager with only function to forward processClaim call
    mockDelegateManager = await MockDelegateManager.new()
    await mockDelegateManager.initialize(registry.address, claimsManagerProxyKey)
    await registry.addContract(delegateManagerKey, mockDelegateManager.address, { from: proxyDeployerAddress })

    // Deploy claimsManagerProxy
    claimsManager0 = await ClaimsManager.new({ from: proxyDeployerAddress })
    const claimsInitializeCallData = _lib.encodeCall(
      'initialize',
      ['address', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [token.address, registry.address, stakingProxyKey, serviceProviderFactoryKey, delegateManagerKey, governanceKey]
    )
    claimsManagerProxy = await AudiusAdminUpgradeabilityProxy.new(
      claimsManager0.address,
      proxyAdminAddress,
      claimsInitializeCallData,
      registry.address,
      governanceKey,
      { from: proxyDeployerAddress }
    )
    claimsManager = await ClaimsManager.at(claimsManagerProxy.address)

    // Register claimsManagerProxy
    await registry.addContract(claimsManagerProxyKey, claimsManagerProxy.address, { from: proxyDeployerAddress })

    // Register new contract as a minter, from the same address that deployed the contract
    await token.addMinter(claimsManagerProxy.address, { from: proxyDeployerAddress })
  })

  it('Initiate a claim', async () => {
    // Get amount staked
    let totalStaked = await staking.totalStaked()
    assert.isTrue(
      totalStaked.isZero(),
      'Expect zero treasury stake prior to claim funding'
    )

    // Stake default amount
    await approveTransferAndStake(DEFAULT_AMOUNT, staker)

    // Get funds per claim
    let fundsPerRound = await claimsManager.getFundsPerRound()

    // Try and initiate from invalid address
    await _lib.assertRevert(
      claimsManager.initiateRound({ from: accounts[8] }),
      'Only callable by staked account or Governance contract'
    )

    assert.isFalse((await claimsManager.claimPending(staker)), 'Expect no pending claim')

    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, true)

    // Confirm a claim is pending
    assert.isTrue((await claimsManager.claimPending(staker)), 'Expect pending claim')

    // Try and directly initiate claim
    await _lib.assertRevert(
      claimsManager.processClaim(staker, 0),
      'ProcessClaim only accessible to DelegateManager')

    await mockDelegateManager.testProcessClaim(staker, 0)

    totalStaked = await staking.totalStaked()

    assert.isTrue(
      totalStaked.eq(fundsPerRound.add(DEFAULT_AMOUNT)),
      'Expect single round of funding + initial stake at this time'
    )

    assert.isTrue(
      (await claimsManager.getTotalClaimedInRound()).eq(fundsPerRound),
      'All funds expected to be claimed')

    // Confirm another claim cannot be immediately funded
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, false)

    await _lib.assertRevert(
      mockDelegateManager.testProcessClaim(staker, 0),
      'Claim already processed for user'
    )
  })

  it('Initiate multiple rounds, 1x block diff', async () => {
    // Get amount staked
    let totalStaked = await staking.totalStaked()
    assert.isTrue(
      totalStaked.isZero(),
      'Expect zero stake prior to claim funding'
    )

    // Stake default amount
    await approveTransferAndStake(DEFAULT_AMOUNT, staker)

    // Get funds per claim
    let fundsPerClaim = await claimsManager.getFundsPerRound()

    // Initiate round
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, true)
    await mockDelegateManager.testProcessClaim(staker, 0)
    totalStaked = await staking.totalStaked()

    assert.isTrue(
      totalStaked.eq(fundsPerClaim.add(DEFAULT_AMOUNT)),
      'Expect single round of funding + initial stake at this time')

    // Confirm another round cannot be immediately funded
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, false)
    
    let lastClaimBlock = await claimsManager.getLastFundBlock()
    let claimDiff = await claimsManager.getFundingRoundBlockDiff()
    let nextClaimBlock = lastClaimBlock.add(claimDiff)

    // Advance blocks to the next valid claim
    await time.advanceBlockTo(nextClaimBlock)

    // No change expected after block diff
    totalStaked = await staking.totalStaked()
    assert.isTrue(
      totalStaked.eq(fundsPerClaim.add(DEFAULT_AMOUNT)),
      'Expect single round of funding + initial stake at this time')

    let accountStakeBeforeSecondClaim = await staking.totalStakedFor(staker)

    // Initiate another round
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, true)
    await mockDelegateManager.testProcessClaim(staker, 0)
    totalStaked = await staking.totalStaked()
    let finalAcctStake = await staking.totalStakedFor(staker)
    let expectedFinalValue = accountStakeBeforeSecondClaim.add(fundsPerClaim)

    assert.isTrue(finalAcctStake.eq(expectedFinalValue), 'Expect additional increase in stake after 2nd claim')
  })

  it('Initiate single claim after 2x claim block diff', async () => {
    // Get funds per claim
    let fundsPerClaim = await claimsManager.getFundsPerRound()
    // Get amount staked
    let totalStaked = await staking.totalStaked()
    assert.isTrue(
      totalStaked.isZero(),
      'Expect zero stake prior to claim funding')

    // Stake default amount
    await approveTransferAndStake(DEFAULT_AMOUNT, staker)

    // Initiate 1st claim
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, true)

    let lastClaimBlock = await claimsManager.getLastFundBlock()
    let claimDiff = await claimsManager.getFundingRoundBlockDiff()
    let twiceClaimDiff = claimDiff.mul(_lib.toBN(2))
    let nextClaimBlockTwiceDiff = lastClaimBlock.add(twiceClaimDiff)

    // Advance blocks to the target
    await time.advanceBlockTo(nextClaimBlockTwiceDiff)

    // Initiate claim
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, true)
    await mockDelegateManager.testProcessClaim(staker, 0)
    totalStaked = await staking.totalStaked()

    assert.isTrue(
      totalStaked.eq(fundsPerClaim.add(DEFAULT_AMOUNT)),
      'Expect single round of funding + initial stake at this time')

    // Confirm another round cannot be immediately funded, despite 2x block diff
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, false)
  })

  it('Updates funding amount', async () => {
    const currentFunding = await claimsManager.getFundsPerRound()
    const newAmountVal = _lib.audToWei(1000)
    let newAmount = _lib.toBN(newAmountVal)

    assert.isTrue(!newAmount.eq(currentFunding), 'Expect change in funding value')

    await _lib.assertRevert(
      claimsManager.updateFundingAmount(newAmount, { from: accounts[7] }),
      'Only callable by Governance contract'
    )

    const updateFundingAmountTxReceipt = await governance.guardianExecuteTransaction(
      claimsManagerProxyKey,
      _lib.toBN(0),
      'updateFundingAmount(uint256)',
      _lib.abiEncode(['uint256'], [newAmountVal]),
      { from: guardianAddress }
    )
    assert.isTrue(_lib.parseTx(updateFundingAmountTxReceipt).event.args.success, 'Expected tx to succeed')

    let updatedFundingAmount = await claimsManager.getFundsPerRound()
    assert.isTrue(newAmount.eq(updatedFundingAmount), 'Expect updated funding amount')
  })

  it('Updates fundRoundBlockDiff', async () => {
    const curBlockDiff = await claimsManager.getFundingRoundBlockDiff.call()
    const proposedBlockDiff = curBlockDiff.mul(_lib.toBN(2))

    await _lib.assertRevert(
      claimsManager.updateFundingRoundBlockDiff(proposedBlockDiff, { from: accounts[7] }),
      'Only callable by Governance contract'
    )

    const updateBlockDiffTxReceipt = await governance.guardianExecuteTransaction(
      claimsManagerProxyKey,
      _lib.toBN(0),
      'updateFundingRoundBlockDiff(uint256)',
      _lib.abiEncode(['uint256'], [_lib.fromBN(proposedBlockDiff)]),
      { from: guardianAddress }
    )
    assert.isTrue(_lib.parseTx(updateBlockDiffTxReceipt).event.args.success, 'Expected tx to succeed')

    const newBlockDiff = await claimsManager.getFundingRoundBlockDiff.call()
    assert.isTrue(newBlockDiff.eq(proposedBlockDiff), 'Expected updated block diff')
  })

  it('Bound violation during claim processing,', async () => {
    let invalidAmount = _lib.audToWeiBN(5)
    // Mark invalid bounds
    await mockStakingCaller.updateBounds(false)
    // Stake default amount
    await approveTransferAndStake(invalidAmount, staker)
    await _lib.initiateFundingRound(governance, claimsManagerProxyKey, guardianAddress, true)
    let accountStake = await staking.totalStakedFor(staker)
    mockDelegateManager.testProcessClaim(staker, 0)
    let accountStakeAfterClaim = await staking.totalStakedFor(staker)
    assert.isTrue(accountStake.eq(accountStakeAfterClaim), 'Expect NO reward due to bound violation')
  })
})