const { healthCheck } = require('./healthCheckComponentService')
const assert = require('assert')
const version = require('../../../.version.json')
const config = require('../../../src/config')

const TEST_ENDPOINT = 'test_endpoint'

const libsMock = {
  discoveryProvider: {
    discoveryProviderEndpoint: TEST_ENDPOINT
  }
}

const mockLogger = {
  warn: () => {}
}

describe('Test Health Check', function () {
  it.only('Should pass', function () {
    config.set('creatorNodeEndpoint', 'http://test.endpoint')
    config.set('spID', 10)
    let expectedEndpoint = config.get('creatorNodeEndpoint')
    let expectedSpID = config.get('spID')
    const res = healthCheck({ libs: libsMock }, mockLogger)
    assert.deepStrictEqual(res, {
      ...version,
      service: 'creator-node',
      healthy: true,
      git: undefined,
      selectedDiscoveryProvider: TEST_ENDPOINT,
      spID: expectedSpID,
      creatorNodeEndpoint: expectedEndpoint
    })
  })

  it('Should handle no libs', function () {
    const res = healthCheck({}, mockLogger)
    assert.deepStrictEqual(res, {
      ...version,
      service: 'creator-node',
      healthy: true,
      git: undefined,
      selectedDiscoveryProvider: 'none'
    })
  })
})
