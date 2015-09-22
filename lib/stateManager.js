/*

//
// BLOCKCHAIN STATE LOOKUPS
//

// block number -> hash (in BLOCKHASH)
self.blockchain.getBlockByNumber(number, function (err, block) {
  if (err) return done(err)
  stack.push(block.hash())
  done()
})

// code lookup
account.getCode(self.trie, function (err2, code, compiled) {...})

// cache read writes
self.cache.getOrLoad(address, function (err, account) {
self.cache.getOrLoad(to, function (err, account) {
self.cache.getOrLoad(suicideTo, function(err, toAccount){
self.cache.get(opts.address)
self.cache.put(suicideTo, toAccount)
self.cache.put(opts.address, opts.account)
self.cache.put(caller, account)
self.cache.get(toAddress)
self.cache.checkpoint()
self.cache.commit()
self.cache.del(createdAddress)
self.cache.revert()
self.cache.put(caller, account)
self.cache.commit()
self.cache.put(toAddress, toAccount)

primary goal of cache mechanism:
  - pre-fetch from state trie
  - materializing to accnt obj
  - hold uncommited state

// update storageTrie
opts.account = self.cache.get(opts.address)
storageTrie.root = opts.account.stateRoot

self
  cache
  trie
  blockchain
  _precomiled

??

- Account objects, do they have any recency guarantees?
should they?
are they best as snapshots of the time of serialization?

- for the cache, do we ever checkpoint at a time when we dont
checkpoint the stateTrie?
what is the purpose?
  synchronous lookups?
  serialized objects?

- when is `vm.loadCompiled` used?

- how the hell to generalize `results.vm.storageTries`??

*/
const Trie = require('merkle-patricia-tree/secure.js')
const async = require('async')
const BN = require('bn.js')
const Account = require('ethereumjs-account')
const HistoryTree = require('history-tree')
const fakeBlockchain = require('./fakeBlockChain.js')
const Cache = require('./cache.js')

module.exports = StateManager

function StateManager (opts) {
  var self = this

  var trie = opts.trie
  if (!trie || !trie.db) {
    trie = new Trie(trie)
  }

  var blockchain = opts.blockchain
  if (!blockchain) {
    blockchain = fakeBlockchain
  }

  self.blockchain = blockchain
  self.trie = trie
  self._storageTries = {}
  self.cache = new Cache(trie)
  self.history = new HistoryTree()

  self.history.on('commit', trie.commit.bind(trie))
  self.history.on('commit', self.commitContracts.bind(self))
  self.history.on('revert', trie.revert.bind(trie))
  self.history.on('revert', self.revertContracts.bind(self))
}

var proto = StateManager.prototype

//
// account
//

proto.getAccount = function (address, cb) {
  console.log('-> getAccount')
  console.log('<- getAccount')
  var self = this
  self.cache.getOrLoad(new Buffer(address, 'hex'), cb)
}

proto.putAccount = function (address, account, cb) {
  console.log('-> putAccount')
  console.log('<- putAccount')
  var self = this
  var addressHex = new Buffer(address, 'hex')
  // TODO: dont save newly created accounts that have no balance
  // if (toAccount.balance.toString('hex') === '00') {
  // if they have money or a non-zero nonce or code, then write to tree
  self.cache.put(addressHex, account)
  self.trie.put(addressHex, account.serialize(), cb)
}

proto.getAccountBalance = function (address, cb) {
  console.log('-> getAccountBalance')
  console.log('<- getAccountBalance')
  var self = this
  self.getAccount(address, function (err, account) {
    if (err) return cb(err)
    cb(null, account.balance)
  })
}

proto.putAccountBalance = function (address, account, balance, cb) {
  console.log('-> putAccountBalance')
  console.log('<- putAccountBalance')
  var self = this
  account.balance = balance
  self.putAccount(address, account, cb)
}

// sets the contract code on the account
proto.putContractCode = function (address, account, value, cb) {
  console.log('-> putContractCode')
  console.log('<- putContractCode')
  var self = this
  account.setCode(self.trie, value, function (err) {
    if (err) return cb(err)
    self.putAccount(address, account, cb)
  })
}

// given an account object, returns the code
proto.getContractCode = function (account, cb) {
  console.log('-> getContractCode')
  console.log('<- getContractCode')
  var self = this
  account.getCode(self.trie, cb)
}

proto.getContractCodeByAddress = function (address, cb) {
  console.log('-> getContractCodeByAddress')
  console.log('<- getContractCodeByAddress')
  var self = this
  self.getAccount(address, function (err, account) {
    if (err) return cb(err)
    self.getContractCode(account, cb)
  })
}

proto.getContractStorage = function (address, key, cb) {
  console.log('-> getContractStorage')
  console.log('<- getContractStorage')
  var self = this
  self._storageTrieForAddress(address, function(err, storageTrie){
    if (err) return cb(err)
    storageTrie.get(key, cb)
  })
}

proto.checkpointContracts = function (cb) {
  console.log('-> checkpointContracts')
  console.log('<- checkpointContracts')
  var self = this
  async.each(Object.keys(self._storageTries), function (address, cb) {
    var trie = self._storageTries[address]
    trie.checkpoint()
    cb()
  }, cb)
}

proto.commitContracts = function (cb) {
  console.log('-> commitContracts')
  console.log('<- commitContracts')
  var self = this
  async.each(Object.keys(self._storageTries), function (address, cb) {
    var trie = self._storageTries[address]
    trie.commit(cb)
  }, cb)
}

proto.revertContracts = function (cb) {
  console.log('-> revertContracts')
  console.log('<- revertContracts')
  var self = this
  async.each(Object.keys(self._storageTries), function (address, cb) {
    var trie = self._storageTries[address]
    trie.revert(cb)
  }, cb)
}

proto.putContractStorage = function (address, contract, key, value, cb) {
  console.log('-> putContractStorage')
  console.log('<- putContractStorage')
  var self = this
  var checkpoint = self.history.getCurrentCheckpoint()
  var originalRoot = contract.stateRoot
  var storageTrie = undefined

  async.series([
    loadStorageTrie,
    setupRevertHandler,
    updateContract,
  ], cb)

  // load in the storage trie
  function loadStorageTrie (cb) {
    self._storageTrieForAddress(address, function(err, _storageTrie){
      if (err) return cb(err)
      storageTrie = _storageTrie
      cb()
    })
  }

  // revert account state after set
  function setupRevertHandler (cb) {
    // if no checkpoint skip revert handler
    if (!checkpoint) return cb()
    checkpoint.on('rejected', function (cb) {
      console.log('revert')
      contract.stateRoot = originalRoot
      // self.putAccount(address, contract, cb)
      storageTrie.revert()
    })
    cb()
  }

  // set account code to new value
  function updateContract (cb) {
    // create contract trie
    storageTrie.put(key, value, function (err) {
      if (err) return cb()
      contract.stateRoot = storageTrie.root
      self.putAccount(address, contract, cb)
    })
  }
}

proto._storageTrieForAddress = function(address, cb){
  console.log('-> _storageTrieForAddress')
  var self = this
  var addressHex = address.toString('hex')
  // try cache
  var storageTrie = self._storageTries[addressHex]
  if (storageTrie) {
    console.log('<- _storageTrieForAddress')
    return cb(null, storageTrie)
  }
  // create trie
  self.getAccount(address, function(err, account){
    if (err) return cb(err)
    storageTrie = self.trie.copy()
    storageTrie.root = account.stateRoot
    storageTrie._checkpoints = [account.stateRoot]
    self._storageTries[addressHex] = storageTrie
    self._syncWithHistoryTree(storageTrie)
    console.log('<- _storageTrieForAddress')
    cb(null, storageTrie)
  })
}

proto._syncWithHistoryTree = function(storageTrie){
  console.log('-> _syncWithHistoryTree')
  console.log('<- _syncWithHistoryTree')
  var self = this
  var times = self.history._stack.length
  for (var i=0; i<times; i++) {
    storageTrie.checkpoint()
  }
}


//
// blockchain
//

proto.getBlockHashByNumber = function (number, cb) {
  console.log('-> getBlockHashByNumber')
  var self = this
  self.blockchain.getBlockByNumber(number, function (err, block) {
    if (err) return cb(err)
    var blockHash = block.hash()
    console.log('<- getBlockHashByNumber')
    cb(null, blockHash)
  })
}

//
// revision history
//

proto.checkpoint = function (cb) {
  console.log('-> checkpoint')
  var self = this
  self.history.checkpoint()
  async.series([
    self.trie.checkpoint.bind(self.trie),
    self.checkpointContracts.bind(self),
  ], function(){
  console.log('<- checkpoint')
  cb()
  })
}

proto.commit = function (cb) {
  console.log('-> commit')
  var self = this
  self.history.commit(function(){
  console.log('<- commit')
  cb()
  })
}

proto.revert = function (cb) {
  console.log('-> revert')
  var self = this
  self.history.revert(function(){
  console.log('<- revert')

  cb()
  })
}

//
// cache stuff
//

proto.getStateRoot = function (cb) {
  console.log('-> getStateRoot')
  var self = this
  self.cacheFlush(function (err) {
    if (err) return cb(err)
    var stateRoot = self.trie.root
  console.log('<- getStateRoot')
    cb(null, stateRoot)
  })
}

proto.warmCache = function (addresses, cb) {
  console.log('-> warmCache')
  var self = this

  // shim till async supports iterators
  var accountArr = []
  addresses.forEach(function (val) {
    if (val) accountArr.push(val)
  })

  async.eachSeries(accountArr, function (acnt, done) {
    acnt = new Buffer(acnt, 'hex')
    self.trie.get(acnt, function (err, val) {
      val = new Account(val)
      self.cache.put(acnt, val, true)
      done()
    })
  }, function(){
  console.log('<- warmCache')
  cb()
  })
}

proto.cacheGet = function (key) {
  console.log('-> cacheGet')
  console.log('<- cacheGet')
  var self = this
  return self.cache.get(key)
}

proto.cachePut = function (key, value) {
  console.log('-> cachePut')
  console.log('<- cachePut')
  var self = this
  return self.cache.put(key, value)
}

proto.cacheDel = function (key) {
  console.log('-> cacheDel')
  console.log('<- cacheDel')
  var self = this
  return self.cache.del(key)
}

proto.cacheFlush = function (cb) {
  console.log('-> cacheFlush')
  console.log('<- cacheFlush')
  var self = this
  self.cache.flush(cb)
}

proto.cacheCheckpoint = function () {
  console.log('-> cacheCheckpoint')
  console.log('<- cacheCheckpoint')
  var self = this
  self.cache.checkpoint()
}

proto.cacheCommit = function () {
  console.log('-> cacheCommit')
  console.log('<- cacheCommit')
  var self = this
  self.cache.commit()
}

proto.cacheRevert = function () {
  console.log('-> cacheRevert')
  console.log('<- cacheRevert')
  var self = this
  self.cache.revert()
}