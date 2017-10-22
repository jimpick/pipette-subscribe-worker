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

async function run ({ sourceDatUrl, subscribe, share }) {
  const key = await datDns.resolveName(sourceDatUrl)
  const dat = await subscribeToDat(key)
  console.log('Jim', dat)
}

run({
  sourceDatUrl,
  subscribe: argv.subscribe,
  share: argv['dat-share']
})