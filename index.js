const Dat = require('dat-node')
const datDns = require('dat-dns')()
const minimist = require('minimist')
const mkdirp = require('mkdirp')

const argv = minimist(process.argv.slice(2), {
  alias: {
    'subscribe': 's',
    'dat-share': 'd'
  },
  boolean: [
    'subscribe',
    'dat-share'
  ],
  default: {
    'subscribe': true,
    'dat-share': true
  }
})

if (argv._.length === 0) {
  console.error('Need a dat archive key')
  process.exit(1)
}

if (argv._.length > 1) {
  console.error('Too many arguments')
  process.exit(1)
}

const sourceDatUrl = argv._[0]

console.log(sourceDatUrl, argv.subscribe, argv['dat-share'])

function subscribeToDat (key) {
  const promise = new Promise((resolve, reject) => {
    const sourceDir = `data/${key}/source`
    mkdirp.sync(sourceDir)
    Dat(sourceDir, { key }, (error, dat) => {
      if (error) {
        return reject(error)
      }
      dat.joinNetwork()
      resolve(dat)
    })
  })
  return promise
}

function networkTools (dat) {
  const { network } = dat
  network.on('connection', (connection, info) => {
    console.log('network onConnection', info.host)
  })
  network.on('peer', peer => {
    console.log('network peer', peer)
  })
  network.on('drop', peer => {
    console.log('network drop', peer)
  })
  network.on('error', error => {
    console.log('network error', error)
  })
  setInterval(() => {
    const { connected, connecting, queued } = network
    console.log('Network:', connected, connecting, queued)
  }, 5000)
}

function datStatus (dat) {
  const stats = dat.trackStats()
  stats.on('update', () => {
    const st = stats.get()
    console.log('Stats update:', st)
  })
  setInterval(() => {
    console.log('Stats network:', stats.network.downloadSpeed,
      stats.network.uploadSpeed)
    console.log('Stats peers:', stats.peers.total, stats.peers.complete)
  }, 5000)
}

async function run ({ sourceDatUrl, subscribe, share }) {
  console.log('Source Url:', sourceDatUrl)
  const key = await datDns.resolveName(sourceDatUrl)
  console.log('Source Key:', key)
  const dat = await subscribeToDat(key)
  // networkTools(dat)
  datStatus(dat)
  // console.log('Jim', dat)
}

run({
  sourceDatUrl,
  subscribe: argv.subscribe,
  share: argv['dat-share']
})
